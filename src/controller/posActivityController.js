// POS activity log: every scan / click on the selling screen, one doc per cart.
//   POST /api/pos/activity                  (pos view)        save a batch of events
//   GET  /api/pos/activity                  (pos_orders view) list carts (no events)
//   GET  /api/pos/activity/by-order/:orderId (pos_orders view) the cart of an order
//   GET  /api/pos/activity/:cartId          (pos_orders view) one cart with events
// The POST must never get in the way of a sale: soft validation, 400 only
// when cartId is missing.
const mongoose = require('mongoose');
const PosActivity = require('../models/posActivity');
const POSOrder = require('../models/posOrder');
const CashSession = require('../models/cashSession');
const User = require('../models/user');
const tillService = require('../services/tillService');
const { resolveWriteBranch } = require('../middleware/access');
const { escapeRegex } = require('../helper/paginate');

const MAX_BATCH = 100;
const MAX_EVENTS = 500;
const DEDUPE_WINDOW = 200;
const MAX_TEXT = 120;
const MAX_DATA_BYTES = 2048;

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, MAX_TEXT);
const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const toDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const eventKey = (e) => `${new Date(e.at).getTime()}|${e.type}`;

// Small JSON only; anything else becomes {}.
function cleanData(data) {
  if (data === undefined || data === null) return {};
  try {
    const s = JSON.stringify(data);
    if (!s || Buffer.byteLength(s, 'utf8') > MAX_DATA_BYTES) return {};
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Status after one event (null = no change).
function nextStatus(current, type) {
  switch (type) {
    case 'clear':
      return 'cleared';
    case 'hold':
      return 'held';
    case 'completed':
    case 'offline_saved':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'add':
    case 'scan':
      return ['held', 'cleared', 'failed'].includes(current) ? 'open' : null;
    default:
      return null;
  }
}

// The real POS order behind a 'completed' event: by id, else by number.
async function findOrder(data) {
  if (!data || typeof data !== 'object') return null;
  if (isId(data.orderId)) {
    const o = await POSOrder.findById(data.orderId).select('_id orderNumber').lean();
    if (o) return o;
  }
  if (data.orderNumber) {
    return POSOrder.findOne({ orderNumber: String(data.orderNumber) }).select('_id orderNumber').lean();
  }
  return null;
}

async function userNameOf(req) {
  const u = req.user || {};
  const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
  if (name) return name;
  const id = req.access?.userId || u._id || u.id;
  if (!isId(id)) return '';
  const doc = await User.findById(id).select('firstName lastName email').lean();
  return doc ? `${doc.firstName || ''} ${doc.lastName || ''}`.trim() || doc.email || '' : '';
}

async function saveBatch(req, cartId) {
  const body = req.body || {};
  const raw = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  const now = new Date();

  // A counter PC with a wrong clock (one was 12 h ahead): move its times by
  // the difference between its clock (sentAt) and the server's. Rounded to
  // 10 s so a resent batch gets the same times. No sentAt: future times -> now.
  const sentAt = toDate(body.sentAt);
  const rawSkew = sentAt ? now - sentAt : 0;
  const skew = Math.abs(rawSkew) >= 60 * 1000 ? Math.round(rawSkew / 10000) * 10000 : 0;
  const fixTime = (d) => {
    if (!d) return null;
    const t = new Date(d.getTime() + skew);
    return t - now > 60 * 1000 ? now : t;
  };

  // Clean events, oldest first (stable).
  const events = raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ at: fixTime(toDate(e.at)) || now, type: text(e.type), label: text(e.label), data: cleanData(e.data) }))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map((x) => x.e);

  const existing = await PosActivity.findOne({ cartId }, { status: 1, lastAt: 1, events: { $slice: -DEDUPE_WINDOW } }).lean();

  // Drop events already stored (client resent the batch) and repeats inside it.
  const seen = new Set((existing?.events || []).map(eventKey));
  const fresh = [];
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(e);
  }

  let status = existing?.status || 'open';
  let orderEvent = null;
  for (const e of fresh) {
    status = nextStatus(status, e.type) || status;
    if (e.type === 'completed') orderEvent = e;
  }

  const set = { status };
  if (fresh.length) {
    const maxAt = fresh.reduce((m, e) => (e.at > m ? e.at : m), fresh[0].at);
    set.lastAt = existing?.lastAt && existing.lastAt > maxAt ? existing.lastAt : maxAt;
    set.lastStep = fresh[fresh.length - 1].label || fresh[fresh.length - 1].type;
  } else if (!existing) {
    set.lastAt = now;
  }
  const itemCount = num(body.itemCount);
  const total = num(body.total);
  if (itemCount !== null) set.itemCount = itemCount;
  if (total !== null) set.total = total;

  if (orderEvent) {
    const order = await findOrder(orderEvent.data);
    if (order) {
      set.order = order._id;
      set.orderNumber = order.orderNumber;
    } else if (orderEvent.data && orderEvent.data.orderNumber) {
      set.orderNumber = text(orderEvent.data.orderNumber);
    }
  }

  const update = { $set: set };
  if (fresh.length) update.$push = { events: { $each: fresh, $slice: -MAX_EVENTS } };

  if (!existing) {
    const userId = req.access?.userId || req.user?._id || req.user?.id;
    const session = isId(userId) ? await CashSession.findOne({ cashier: userId, status: 'open' }).select('_id counter counterName').lean() : null;
    update.$setOnInsert = {
      user: isId(userId) ? userId : null,
      userName: await userNameOf(req),
      cashSession: session?._id || null,
      counter: session?.counter || null,
      counterName: session?.counterName || '',
      deviceName: text(req.get('x-device-name')),
      startedAt: fixTime(toDate(body.startedAt)) || fresh[0]?.at || now,
      branch: await resolveWriteBranch(req),
    };
  }

  try {
    await PosActivity.updateOne({ cartId }, update, { upsert: true });
  } catch (err) {
    // Two first batches raced: the doc exists now, save as an update.
    if (err && err.code === 11000) {
      delete update.$setOnInsert;
      await PosActivity.updateOne({ cartId }, update);
    } else {
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Path: the steps of one bill from start to end, across hold / retrieve */
/* ------------------------------------------------------------------ */

// Only what the path needs from each event.
const PATH_EVENTS = {
  $map: {
    input: { $ifNull: ['$events', []] },
    as: 'e',
    in: { type: '$$e.type', at: '$$e.at', label: '$$e.label', heldId: '$$e.data.heldId' },
  },
};
const SEGMENT_FIELDS = { cartId: 1, user: 1, userName: 1, counterName: 1, status: 1, orderNumber: 1, order: 1, lastAt: 1, ev: PATH_EVENTS };
const ITEM_TYPES = new Set(['scan', 'add', 'qty', 'scan_not_found']);
const MAX_LINKS = 6;
const LINK_WINDOW_MS = 7 * 86400000; // a held order is brought back within a week

/** One cart's events as short steps: Scanned 5 > Held, or Retrieved > Added 2 > Paid card > Completed. */
function cartSteps(seg) {
  const ev = seg.ev || [];
  const steps = [];
  const retrieved = ev.length && ev[0].type === 'retrieve';
  const push = (s) => steps.push({ cartId: seg.cartId, ...s });
  let i = 0;
  while (i < ev.length) {
    const e = ev[i];
    if (ITEM_TYPES.has(e.type)) {
      let adds = 0;
      let qty = 0;
      const at = e.at;
      while (i < ev.length && ITEM_TYPES.has(ev[i].type)) {
        if (ev[i].type === 'add') adds += 1;
        if (ev[i].type === 'qty') qty += 1;
        i += 1;
      }
      if (adds) push({ kind: 'items', label: `${retrieved ? 'Added' : 'Scanned'} ${adds} item${adds === 1 ? '' : 's'}`, at });
      else if (qty) push({ kind: 'items', label: 'Changed quantity', at });
      continue;
    }
    if (e.type === 'remove') {
      let n = 0;
      const at = e.at;
      while (i < ev.length && ev[i].type === 'remove') {
        n += 1;
        i += 1;
      }
      push({ kind: 'remove', label: `Removed ${n} item${n === 1 ? '' : 's'}`, at });
      continue;
    }
    if (e.type === 'pay_open' || e.type === 'pay_submit' || e.type === 'pay_close') {
      let submit = null;
      let closed = false;
      const at = e.at;
      while (i < ev.length && ['pay_open', 'pay_submit', 'pay_close'].includes(ev[i].type)) {
        if (ev[i].type === 'pay_submit') submit = ev[i];
        if (ev[i].type === 'pay_close') closed = true;
        i += 1;
      }
      if (submit) push({ kind: 'pay', label: String(submit.label || 'Paid').replace(/^Pay pressed:\s*/i, 'Paid '), at: submit.at });
      else if (closed) push({ kind: 'pay_cancel', label: 'Payment closed (not paid)', at });
      continue;
    }
    if (e.type === 'retrieve') push({ kind: 'retrieve', label: 'Retrieved', at: e.at, by: seg.userName, counter: seg.counterName });
    else if (e.type === 'hold') push({ kind: 'hold', label: 'Held', at: e.at, by: seg.userName, counter: seg.counterName });
    else if (e.type === 'discount') push({ kind: 'discount', label: e.label || 'Discount', at: e.at });
    else if (e.type === 'completed')
      push({ kind: 'completed', label: 'Completed', at: e.at, orderNumber: seg.orderNumber || '', orderId: seg.order ? String(seg.order) : '' });
    else if (e.type === 'offline_saved') push({ kind: 'completed', label: 'Saved offline', at: e.at });
    else if (e.type === 'failed') push({ kind: 'failed', label: 'Failed', at: e.at });
    else if (e.type === 'clear') push({ kind: 'cleared', label: 'Cleared', at: e.at });
    i += 1;
  }
  if (!steps.length || seg.status === 'open') {
    const last = steps[steps.length - 1];
    if (!last || !['completed', 'hold', 'cleared', 'failed'].includes(last.kind)) push({ kind: 'open', label: 'Not finished', at: seg.lastAt });
  }
  if (!retrieved) steps.unshift({ cartId: seg.cartId, kind: 'start', label: 'Started', at: ev[0] ? ev[0].at : seg.lastAt, by: seg.userName, counter: seg.counterName });
  return steps;
}

const segmentOf = async (match) => (await PosActivity.aggregate([{ $match: match }, { $sort: { lastAt: 1 } }, { $limit: 1 }, { $project: SEGMENT_FIELDS }]))[0] || null;

/** The cart that held this held order (by its id, else same cashier at the same time). */
async function holderOf(heldId, before) {
  const HeldOrder = require('../models/heldOrder');
  const b = new Date(before).getTime();
  const exact = await segmentOf({ lastAt: { $gte: new Date(b - LINK_WINDOW_MS), $lte: new Date(b) }, 'events.data.heldId': String(heldId), 'events.type': 'hold' });
  if (exact) return exact;
  const h = await HeldOrder.findById(heldId).select('heldBy createdAt').lean();
  if (!h || !h.heldBy) return null;
  const at = new Date(h.createdAt).getTime();
  const list = await PosActivity.aggregate([
    { $match: { user: h.heldBy, status: 'held', lastAt: { $gte: new Date(at - 2 * 60000), $lte: new Date(at + 60000) } } },
    { $project: SEGMENT_FIELDS },
  ]);
  const holdAt = (s) => {
    const e = [...(s.ev || [])].reverse().find((x) => x.type === 'hold');
    return e ? Math.abs(new Date(e.at).getTime() - at) : Infinity;
  };
  return list.sort((a, b) => holdAt(a) - holdAt(b))[0] || null;
}

/** The held order a hold cart created (saved id, else same cashier just after the hold). */
async function heldIdOf(seg) {
  const hold = [...(seg.ev || [])].reverse().find((x) => x.type === 'hold');
  if (!hold) return null;
  if (hold.heldId) return String(hold.heldId);
  if (!seg.user) return null;
  const HeldOrder = require('../models/heldOrder');
  const at = new Date(hold.at).getTime();
  const h = await HeldOrder.find({ heldBy: seg.user, createdAt: { $gte: new Date(at - 60000), $lte: new Date(at + 2 * 60000) } })
    .select('_id createdAt')
    .lean();
  h.sort((a, b) => Math.abs(new Date(a.createdAt) - at) - Math.abs(new Date(b.createdAt) - at));
  return h[0] ? String(h[0]._id) : null;
}

/** Full path of the bill this cart is part of: earlier carts (held) + this one + later carts (retrieved). */
async function pathOf(row) {
  const seg = (await PosActivity.aggregate([{ $match: { cartId: row.cartId } }, { $project: SEGMENT_FIELDS }]))[0];
  if (!seg) return [];
  const chain = [seg];
  const seen = new Set([seg.cartId]);
  // Back: this cart started from a held order -> the cart that held it.
  for (let n = 0; n < MAX_LINKS; n++) {
    const first = chain[0].ev && chain[0].ev[0];
    if (!first || first.type !== 'retrieve' || !first.heldId) break;
    const prev = await holderOf(first.heldId, first.at);
    if (!prev || seen.has(prev.cartId)) break;
    seen.add(prev.cartId);
    chain.unshift(prev);
  }
  // Forward: this cart was held -> the cart that brought it back.
  for (let n = 0; n < MAX_LINKS; n++) {
    const last = chain[chain.length - 1];
    if (last.status !== 'held') break;
    const heldId = await heldIdOf(last);
    if (!heldId) break;
    const next = await segmentOf({ 'events.0.type': 'retrieve', 'events.0.data.heldId': heldId, lastAt: { $gte: new Date(last.lastAt), $lte: new Date(new Date(last.lastAt).getTime() + LINK_WINDOW_MS) } });
    if (!next || seen.has(next.cartId)) break;
    seen.add(next.cartId);
    chain.push(next);
  }
  return chain.flatMap((s) => cartSteps(s).map((st) => ({ ...st, current: s.cartId === row.cartId })));
}

const LIST_FIELDS = {
  cartId: 1,
  userName: 1,
  counterName: 1,
  status: 1,
  lastStep: 1,
  startedAt: 1,
  lastAt: 1,
  itemCount: 1,
  total: 1,
  orderNumber: 1,
  order: 1,
  eventCount: { $size: { $ifNull: ['$events', []] } },
};

module.exports = {
  // POST /api/pos/activity
  record: async (req, res) => {
    const cartId = text(req.body && req.body.cartId);
    if (!cartId) return res.status(400).json({ success: false, message: 'cartId is required' });
    try {
      await saveBatch(req, cartId);
      return res.json({ success: true, data: { ok: true } });
    } catch (err) {
      console.error('POS activity save failed:', err);
      return res.status(500).json({ success: false, message: 'Could not save activity' });
    }
  },

  // GET /api/pos/activity?startDate&endDate&status&counter&user&orderNumber&page&limit
  list: async (req, res) => {
    try {
      const q = req.query || {};
      const base = {};
      const tz = await tillService.getTimeZone();
      const range = tillService.dayRange(q.startDate, q.endDate, tz);
      if (range) base.lastAt = range;
      if (isId(q.counter)) base.counter = new mongoose.Types.ObjectId(String(q.counter));
      if (isId(q.user)) base.user = new mongoose.Types.ObjectId(String(q.user));
      if (q.orderNumber && String(q.orderNumber).trim()) {
        base.orderNumber = { $regex: escapeRegex(String(q.orderNumber).trim()), $options: 'i' };
      }

      const filter = { ...base };
      if (q.status === 'not_completed') filter.status = { $ne: 'completed' };
      else if (PosActivity.STATUSES.includes(q.status)) filter.status = q.status;

      const page = Math.max(1, parseInt(q.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));

      // summary ignores the status filter (counts for the status tabs).
      const [rows, total, all, completed] = await Promise.all([
        PosActivity.aggregate([
          { $match: filter },
          { $sort: { lastAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $project: LIST_FIELDS },
        ]),
        PosActivity.countDocuments(filter),
        PosActivity.countDocuments(base),
        PosActivity.countDocuments({ ...base, status: 'completed' }),
      ]);

      // Each row: its bill's path from start to end (never fails the list).
      await Promise.all(
        rows.map(async (r) => {
          try {
            r.path = await pathOf(r);
          } catch (e) {
            r.path = [];
          }
        })
      );

      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      return res.json({
        success: true,
        data: rows,
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        summary: { total: all, completed, notCompleted: all - completed },
      });
    } catch (err) {
      console.error('POS activity list failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load activity' });
    }
  },

  // GET /api/pos/activity/:cartId
  getByCart: async (req, res) => {
    try {
      const doc = await PosActivity.findOne({ cartId: String(req.params.cartId) }).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Activity not found' });
      return res.json({ success: true, data: doc });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Could not load activity' });
    }
  },

  // GET /api/pos/activity/by-order/:orderId
  getByOrder: async (req, res) => {
    try {
      if (!isId(req.params.orderId)) return res.status(404).json({ success: false, message: 'Activity not found' });
      const doc = await PosActivity.findOne({ order: req.params.orderId }).sort({ lastAt: -1 }).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Activity not found' });
      return res.json({ success: true, data: doc });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Could not load activity' });
    }
  },
};
