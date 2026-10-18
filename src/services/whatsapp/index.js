// src/services/whatsapp/index.js
// WhatsApp group slips: outbox rows + delivery through the configured provider.
//
//   const wa = require('./whatsapp');
//   await wa.enqueueOrderReceipt(order, { event: 'sale' });  // never throws
//   await wa.sendTest({ to, message, userId });              // test from /admin/whatsapp
//   await wa.retryOne(outboxId);  await wa.retryFailed();    // manual / cron retries
//
// Flow: build slip -> MessageOutbox row (queued) -> try to send now (short
// timeout) -> row sent/failed + POSOrder.whatsappStatus. Failed rows are
// retried by the cron (max MAX_ATTEMPTS, last 2 days) or by hand.
const MessageOutbox = require('../../models/messageOutbox');
const POSOrder = require('../../models/posOrder');
const config = require('../configService');
const settingsSvc = require('./settings');
const { sendText } = require('./providers');
const { buildOrderSlip, formatDateTime } = require('./slip');

const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000; // a claimed row is free again after this (crashed sender)
const RETRY_WINDOW_MS = 2 * 24 * 3600 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function timeZone() {
  const tz = await config.get('store.timezone', 'Asia/Karachi');
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Karachi';
  }
}

let shopCache = { at: 0, name: '' };
async function shopName() {
  if (shopCache.name && Date.now() - shopCache.at < 60 * 1000) return shopCache.name;
  let name = 'One Dollar Store';
  try {
    const Settings = require('../../models/settings');
    const s = await Settings.findOne({ isActive: true }).select('siteName').lean();
    if (s && s.siteName) name = s.siteName;
  } catch {
    /* keep default */
  }
  shopCache = { at: Date.now(), name };
  return name;
}

/**
 * Claim a queued/failed row, send it, store the result. One sender at a time
 * per row (lockedAt), so a double "Retry" click cannot send twice.
 */
async function deliver(rowId, settings) {
  const now = Date.now();
  const row = await MessageOutbox.findOneAndUpdate(
    {
      _id: rowId,
      status: { $in: ['queued', 'failed'] },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now - LOCK_MS) } }],
    },
    { $set: { lockedAt: new Date(now) }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!row) return { ok: false, skipped: true, error: 'Already sent or being sent' };

  const s = settings || (await settingsSvc.getSettings());
  const result = await sendText(s, {
    to: row.to,
    body: row.body,
    meta: { refType: row.refType, refId: row.refId, refNo: row.refNo, event: row.event },
  });
  const update = result.ok
    ? { status: 'sent', sentAt: new Date(), providerMessageId: result.id || '', lastError: '', lockedAt: null, provider: s.provider }
    : { status: 'failed', lastError: result.error || 'Send failed', lockedAt: null, provider: s.provider };
  const saved = await MessageOutbox.findByIdAndUpdate(row._id, { $set: update }, { new: true }).lean();
  if (row.refType === 'POSOrder' && row.refId) {
    await POSOrder.updateOne(
      { _id: row.refId },
      { $set: { whatsappStatus: result.ok ? 'sent' : 'failed' } },
      { timestamps: false }
    );
  }
  return { ok: !!result.ok, error: result.ok ? undefined : update.lastError, row: saved };
}

async function loadOrder(order) {
  const id = order && order._id;
  if (id) {
    const full = await POSOrder.findById(id)
      .populate('items.product', 'name')
      .populate('cashier', 'firstName lastName')
      .populate('paymentHistory.receivedBy', 'firstName lastName')
      .lean();
    if (full) return full;
  }
  return typeof order.toObject === 'function' ? order.toObject() : order;
}

const refId = (v) => (v && typeof v === 'object' && v._id ? v._id : v) || null;

/** Build + queue + try to send the slip of a bill. Never throws. */
// event: 'sale' | 'payment' | 'resend'; resend: true = a copy sent by hand
// (ignores the sendOn switches, slip marked "(copy)").
async function enqueueOrderReceipt(order, { event = 'sale', resend = false } = {}) {
  try {
    if (!order) return { queued: false, reason: 'no_order' };
    const s = await settingsSvc.getSettings();
    if (!s.enabled) return { queued: false, reason: 'disabled' };
    const copy = !!resend || event === 'resend';
    if (!copy && s.sendOn && s.sendOn[event] === false) return { queued: false, reason: 'event_off' };
    if (settingsSvc.missingFields(s).length) return { queued: false, reason: 'not_configured' };

    const full = await loadOrder(order);
    const branchId = refId(full.branch);
    const to = settingsSvc.groupFor(s);
    if (!to) return { queued: false, reason: 'no_group' };

    const [name, tz] = await Promise.all([shopName(), timeZone()]);
    const body = buildOrderSlip(full, { shopName: name, header: s.header, footer: s.footer, timeZone: tz, event, copy });
    const row = await MessageOutbox.create({
      channel: 'whatsapp',
      provider: s.provider,
      to,
      body,
      status: 'queued',
      refType: 'POSOrder',
      refId: full._id || null,
      refNo: full.orderNumber || '',
      event: copy ? 'resend' : event,
      branch: branchId,
    });
    if (full._id) {
      await POSOrder.updateOne({ _id: full._id }, { $set: { whatsappStatus: 'queued' } }, { timestamps: false });
    }
    const r = await deliver(row._id, s);
    return { queued: true, sent: r.ok, outboxId: String(row._id), error: r.ok ? undefined : r.error };
  } catch (err) {
    console.error('[whatsapp] enqueueOrderReceipt failed:', err && err.message);
    return { queued: false, reason: 'error', error: err && err.message };
  }
}

/** Send a test message now (works while switched off, to check the setup). */
async function sendTest({ to, message, userId } = {}) {
  const s = await settingsSvc.getSettings();
  const target = (typeof to === 'string' && to.trim()) || s.groupId;
  const missing = settingsSvc.missingFields({ ...s, groupId: target }).filter(Boolean);
  if (missing.length) throw httpError(400, `Fill in and save: ${missing.join(', ')}.`);
  const [name, tz] = await Promise.all([shopName(), timeZone()]);
  const body =
    (typeof message === 'string' && message.trim().slice(0, 1000)) ||
    `*${name}*\nTest message from the POS - ${formatDateTime(new Date(), tz)}.\nReceipt slips will arrive in this group.`;
  const row = await MessageOutbox.create({
    channel: 'whatsapp',
    provider: s.provider,
    to: target,
    body,
    refType: 'test',
    event: 'test',
    createdBy: userId || null,
  });
  const r = await deliver(row._id, s);
  return { ok: r.ok, error: r.error, outbox: r.row };
}

/** Retry one row now (manual retry ignores the attempt limit). */
async function retryOne(id) {
  const row = await MessageOutbox.findById(id).lean();
  if (!row) throw httpError(404, 'Message not found');
  if (row.status === 'sent') throw httpError(409, 'This message was already sent');
  const r = await deliver(row._id);
  if (r.skipped) throw httpError(409, 'This message is being sent right now');
  return { ok: r.ok, error: r.error, outbox: r.row };
}

/**
 * Retry failed rows (and rows stuck in "queued") from the last 2 days, oldest
 * first, within a time budget so a serverless function never runs too long.
 */
async function retryFailed({ limit = 10, budgetMs = 20000 } = {}) {
  const s = await settingsSvc.getSettings();
  if (!s.enabled || settingsSvc.missingFields(s).length) return { tried: 0, sent: 0, failed: 0, skipped: 'disabled' };
  const now = Date.now();
  const rows = await MessageOutbox.find({
    createdAt: { $gte: new Date(now - RETRY_WINDOW_MS) },
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ status: 'failed' }, { status: 'queued', createdAt: { $lt: new Date(now - 2 * 60 * 1000) } }],
  })
    .sort({ createdAt: 1 })
    .limit(Math.min(50, Math.max(1, Number(limit) || 10)))
    .select('_id')
    .lean();
  const out = { tried: 0, sent: 0, failed: 0 };
  for (const r of rows) {
    if (Date.now() - now > budgetMs) break;
    const res = await deliver(r._id, s);
    if (res.skipped) continue;
    out.tried += 1;
    if (res.ok) out.sent += 1;
    else out.failed += 1;
  }
  return out;
}

module.exports = {
  enqueueOrderReceipt,
  sendTest,
  retryOne,
  retryFailed,
  deliver,
  MAX_ATTEMPTS,
  settings: settingsSvc,
};
