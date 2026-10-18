// src/services/notificationService.js
// In-app notifications + WhatsApp group receipt slips.
// OWNER: Cash management & notifications module.
//
// Interface used by other modules — keep these signatures stable. Every
// function NEVER throws (a failed message must not fail a sale):
//
//   await notificationService.enqueueOrderReceipt(order, { event, resend? })
//     order = saved POSOrder (doc or plain); event = 'sale' | 'payment' | 'resend';
//     resend = true -> a copy sent by hand (ignores the sendOn switches)
//     -> { queued: boolean, sent?, outboxId?, reason?, error? }  sends the
//        transaction slip to the configured WhatsApp group (config key
//        "whatsapp") when enabled. Tries to send right away with a short
//        timeout (~5 s); failures stay in the outbox and are retried later.
//
//   await notificationService.notify({ type, title, message, level, link, branchId, audience, meta, dedupeKey, userId })
//     level = 'info' | 'warning' | 'critical'; audience = permission key whose
//     holders should see it (e.g. 'till_verify'); no audience = staff with the
//     `notifications` permission. userId = only that user. dedupeKey = never
//     create the same notification twice.
//     -> saved notification or null (null also when the dedupeKey exists)
//
// Reading (used by the notifications controller):
//   listForUser(access, { page, limit, unread, level }), unreadCount(access),
//   markRead(access, id), markAllRead(access)
const mongoose = require('mongoose');
const Notification = require('../models/notification');
const whatsapp = require('./whatsapp');

const LEVELS = ['info', 'warning', 'critical'];
const toId = (v) => {
  const raw = v && typeof v === 'object' && v._id ? v._id : v;
  return raw && mongoose.Types.ObjectId.isValid(String(raw)) ? new mongoose.Types.ObjectId(String(raw)) : null;
};

async function enqueueOrderReceipt(order, opts = {}) {
  return whatsapp.enqueueOrderReceipt(order, opts);
}

async function notify({ type, title, message = '', level = 'info', link = '', branchId = null, audience = null, meta, dedupeKey, userId = null } = {}) {
  try {
    if (!type || !title) return null;
    const doc = {
      type: String(type),
      title: String(title).slice(0, 200),
      message: String(message || '').slice(0, 2000),
      level: LEVELS.includes(level) ? level : 'info',
      link: link ? String(link) : '',
      branch: toId(branchId),
      audience: audience ? String(audience) : null,
      user: toId(userId),
    };
    if (meta !== undefined) doc.meta = meta;
    if (dedupeKey) doc.dedupeKey = String(dedupeKey);
    const saved = await Notification.create(doc);
    return saved.toObject();
  } catch (err) {
    if (err && err.code === 11000) return null; // already notified (dedupeKey)
    console.error('[notify] failed:', err && err.message);
    return null;
  }
}

/**
 * Mongo filter of the notifications this user may see.
 * Super admin: everything. Staff: rows for them, or for a permission key they
 * hold (no key = `notifications` holders).
 */
function visibleFilter(access) {
  if (!access) return { _id: null };
  if (access.isSuperAdmin) return {};
  const me = toId(access.userId);
  const keys = Object.entries(access.permissions || {})
    .filter(([, actions]) => Array.isArray(actions) && actions.length)
    .map(([k]) => k);
  const audiences = access.can('notifications', 'view') ? [...keys, null] : keys;
  const branch = toId(access.userBranchId);
  return {
    $or: [
      { user: me },
      { user: null, audience: { $in: audiences }, branch: { $in: branch ? [null, branch] : [null] } },
    ],
  };
}

const LIST_FIELDS = 'type title message level link branch audience createdAt readBy meta';

function present(row, me) {
  const read = (row.readBy || []).some((id) => String(id) === String(me));
  const { readBy, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, read };
}

async function listForUser(access, { page = 1, limit = 20, unread = false, level } = {}) {
  const me = toId(access.userId);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const filter = { ...visibleFilter(access) };
  if (unread) filter.readBy = { $ne: me };
  if (level && LEVELS.includes(level)) filter.level = level;
  const [total, rows, unreadTotal] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.find(filter).select(LIST_FIELDS).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    unreadCount(access),
  ]);
  return {
    data: rows.map((r) => present(r, me)),
    meta: { page: p, limit: l, total, pages: Math.max(1, Math.ceil(total / l)), unread: unreadTotal },
  };
}

async function unreadCount(access) {
  const me = toId(access.userId);
  return Notification.countDocuments({ ...visibleFilter(access), readBy: { $ne: me } });
}

async function markRead(access, id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return false;
  const r = await Notification.updateOne(
    { _id: id, ...visibleFilter(access) },
    { $addToSet: { readBy: toId(access.userId) } }
  );
  return r.matchedCount > 0;
}

async function markAllRead(access) {
  const me = toId(access.userId);
  const r = await Notification.updateMany(
    { ...visibleFilter(access), readBy: { $ne: me } },
    { $addToSet: { readBy: me } }
  );
  return r.modifiedCount || 0;
}

module.exports = {
  enqueueOrderReceipt,
  notify,
  visibleFilter,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
};
