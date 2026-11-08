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

  // Clean events, oldest first (stable).
  const events = raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ at: toDate(e.at) || now, type: text(e.type), label: text(e.label), data: cleanData(e.data) }))
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
      startedAt: toDate(body.startedAt) || fresh[0]?.at || now,
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
