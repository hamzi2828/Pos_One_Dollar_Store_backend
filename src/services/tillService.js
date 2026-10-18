// src/services/tillService.js
// Till (cash drawer) sessions. OWNER: Cash management module.
//
// Interface used by the POS (posController.createOrder) — keep these
// signatures stable:
//
//   await tillService.resolveSaleSession(req)
//     -> { session, counter }  (both may be null when no till is required)
//     throws err with err.status = 409, err.code = 'TILL_NOT_OPEN' when a till
//     is required and the cashier has no open session in the request's branch.
//     A till is required when config "till.requireOpenSession" is true, or —
//     when that config is not set — when the branch has at least one active
//     sale counter. (false = never required.)
//
//   await tillService.attachOrder(session, order)   // stamps order.cashSession/counter, never throws
//
// Also used by the till / counters controllers: openSession, closeSession,
// reviewSession, computeExpected, myStatus, checkCutoffs, maybeCheckCutoffs,
// serializeSession and the store-time helpers (Asia/Karachi by default).
const mongoose = require('mongoose');
const CashSession = require('../models/cashSession');
const SaleCounter = require('../models/saleCounter');
const POSOrder = require('../models/posOrder');
const User = require('../models/user');
const config = require('./configService');
const { nextNumber } = require('./sequenceService');
const notificationService = require('./notificationService');
const { resolveWriteBranch } = require('../middleware/access');

const DEFAULT_DENOMINATIONS = [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];
const DEFAULT_TZ = 'Asia/Karachi';
const SALE_PAYMENT_GAP_MS = 5 * 60 * 1000; // first payment this close to the bill time = paid at sale

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const toId = (v) => {
  const raw = v && typeof v === 'object' && v._id ? v._id : v;
  return raw && mongoose.Types.ObjectId.isValid(String(raw)) ? new mongoose.Types.ObjectId(String(raw)) : null;
};
const sameId = (a, b) => !!a && !!b && String(a._id || a) === String(b._id || b);
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

/* ------------------------------------------------------------------ */
/* Store time (all cut-off math in the store time zone, server is UTC) */
/* ------------------------------------------------------------------ */

async function getTimeZone() {
  const tz = await config.get('store.timezone', DEFAULT_TZ);
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Wall-clock parts of `date` in `timeZone`: { dayKey: 'YYYY-MM-DD', minutes: 0..1439, ... }. */
function zonedParts(date, timeZone = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second),
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + Number(p.minute),
  };
}

/** UTC instant of local midnight of a 'YYYY-MM-DD' day in `timeZone`. */
function zonedDayStart(dayKey, timeZone = DEFAULT_TZ) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const p = zonedParts(new Date(guess), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(guess - (asUtc - guess));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** { $gte, $lt } for local days from..to (inclusive), or null. */
function dayRange(from, to, timeZone = DEFAULT_TZ) {
  const out = {};
  if (from && DAY_RE.test(from)) out.$gte = zonedDayStart(from, timeZone);
  if (to && DAY_RE.test(to)) out.$lt = new Date(zonedDayStart(to, timeZone).getTime() + 24 * 3600 * 1000);
  return Object.keys(out).length ? out : null;
}

const hhmmToMinutes = (v) => {
  if (!v || !SaleCounter.HHMM.test(v)) return null;
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};

const formatHHMM = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/* ------------------------------------------------------------------ */
/* Denominations                                                       */
/* ------------------------------------------------------------------ */

async function getDenominations() {
  const raw = await config.get('till.denominations', DEFAULT_DENOMINATIONS);
  const list = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  return (list.length ? list : DEFAULT_DENOMINATIONS).sort((a, b) => b - a);
}

/**
 * Turn { "5000": 1, "100": 7 } (or [{ value, count }]) into a clean count:
 * { denominations: { "5000": 1, "100": 7 }, total: 5700 }. Unknown notes and
 * non-whole counts are rejected.
 */
function parseCashCount(input, allowed) {
  const entries = [];
  if (Array.isArray(input)) {
    for (const row of input) entries.push([row && row.value, row && row.count]);
  } else if (input && typeof input === 'object') {
    entries.push(...Object.entries(input));
  } else if (input !== undefined && input !== null) {
    throw httpError(400, 'Count the cash by note and coin.');
  }
  const denominations = {};
  let total = 0;
  for (const [rawValue, rawCount] of entries) {
    const value = Number(rawValue);
    const count = rawCount === '' || rawCount === null || rawCount === undefined ? 0 : Number(rawCount);
    if (!allowed.includes(value)) throw httpError(400, `Unknown note or coin: ${rawValue}`);
    if (!Number.isInteger(count) || count < 0 || count > 100000) {
      throw httpError(400, `Number of Rs ${value} must be a whole number (0 or more).`);
    }
    if (count > 0) {
      denominations[String(value)] = (denominations[String(value)] || 0) + count;
      total += value * count;
    }
  }
  return { denominations, total: round2(total) };
}

/* ------------------------------------------------------------------ */
/* Is a till required?                                                 */
/* ------------------------------------------------------------------ */

async function isTillRequired(branchId) {
  const flag = await config.get('till.requireOpenSession', null);
  if (flag === true || flag === 'true') return true;
  if (flag === false || flag === 'false') return false;
  if (!branchId) return false;
  return !!(await SaleCounter.exists({ branch: toId(branchId), isActive: true }));
}

const requestUserId = (req) => String((req.access && req.access.userId) || (req.user && (req.user._id || req.user.id)) || '');

/* ------------------------------------------------------------------ */
/* POS hooks                                                           */
/* ------------------------------------------------------------------ */

async function resolveSaleSession(req) {
  const userId = requestUserId(req);
  if (!userId) return { session: null, counter: null };
  const branchId = String(await resolveWriteBranch(req));

  const session = await CashSession.findOne({ cashier: userId, status: 'open' }).lean();
  if (session && sameId(session.branch, branchId)) {
    const counter = session.counter
      ? await SaleCounter.findById(session.counter).setOptions({ withDeleted: true }).lean()
      : null;
    return { session, counter };
  }
  if (await isTillRequired(branchId)) {
    throw httpError(
      409,
      session
        ? 'Close your open till first.'
        : 'Open your till (counter + opening float) before making a sale.',
      'TILL_NOT_OPEN'
    );
  }
  return { session: null, counter: null };
}

async function attachOrder(session, order) {
  try {
    if (!session || !session._id || !order || !order._id) return null;
    const set = { cashSession: session._id, counter: session.counter || null };
    if (typeof order.set === 'function') order.set(set);
    else Object.assign(order, set);
    await POSOrder.updateOne({ _id: order._id }, { $set: set }, { timestamps: false });
    return set;
  } catch (err) {
    console.error('[till] attachOrder failed:', err && err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Expected cash                                                       */
/* ------------------------------------------------------------------ */

/**
 * Cash part of one paymentHistory entry.
 *   'cash'                 -> entry.amount. createOrder stores the amount applied
 *                             to the bill (not the cash tendered), so the change
 *                             given back is already excluded.
 *   'split' (one entry)    -> order.cashAmount − order.changeGiven (or amount −
 *                             order.cardAmount), kept between 0 and the amount.
 *                             (Split bills stored as separate cash + card entries
 *                             are handled by the 'cash' rule.)
 *   'card', 'bank_transfer' -> 0
 */
function cashPart(entry, order) {
  const amount = Number(entry && entry.amount) || 0;
  if (amount <= 0) return 0;
  if (entry.paymentMethod === 'cash') return amount;
  if (entry.paymentMethod === 'split') {
    const clamp = (v) => Math.min(amount, Math.max(0, v));
    if (Number.isFinite(order.cashAmount)) return clamp(order.cashAmount - (Number(order.changeGiven) || 0));
    if (Number.isFinite(order.cardAmount)) return clamp(amount - order.cardAmount);
  }
  return 0;
}

const ORDER_FIELDS =
  'orderNumber total subtotal paymentMethod cashAmount cardAmount changeGiven paidAmount pendingAmount paymentHistory createdAt orderStatus paymentStatus cashier cashSession refundedAt refundedBy customerInfo.name isDeleted deletedAt';

/**
 * What the drawer of `session` should hold at `until`:
 *
 *   expectedCash = openingFloat + cashSales + cashReceivedOnCredit − cashRefunds
 *
 *   - Bills of the session's branch, not deleted.
 *   - A payment belongs to the session when paymentHistory.receivedBy is the
 *     cashier and paidAt is in [openedAt, until]; only its cash part counts
 *     (see cashPart).
 *   - cashSales: payments on bills created in the session, taken at the sale
 *     (within 5 min of the bill time — covers split cash + card entries),
 *     minus cash change handed back on bank-transfer bills paid over the total
 *     (order.changeGiven on a 'bank_transfer' bill).
 *   - cashReceivedOnCredit: every other cash payment (later instalments on
 *     credit / partial bills, however old the bill).
 *   - cashRefunds: bills refunded in [openedAt, until] by this cashier
 *     (order.refundedBy, or the bill's cashier when the refunder is not
 *     recorded): all cash ever taken on the bill goes back to the customer.
 *   - The opening float is change money: it is in the drawer but is NOT sales.
 *
 * Returns { expected, bills, voided, nonCash }.
 */
async function computeExpected(session, until = new Date()) {
  const start = new Date(session.openedAt);
  const end = new Date(until);
  const cashier = String(session.cashier && (session.cashier._id || session.cashier));
  const branch = toId(session.branch);
  const float = round2(session.openingFloat && session.openingFloat.total);

  const [paidOrders, refundedOrders, voided] = await Promise.all([
    POSOrder.find({
      branch,
      isDeleted: { $ne: true },
      paymentHistory: { $elemMatch: { receivedBy: toId(cashier), paidAt: { $gte: start, $lte: end } } },
    })
      .select(ORDER_FIELDS)
      .lean(),
    POSOrder.find({ branch, isDeleted: { $ne: true }, orderStatus: 'refunded', refundedAt: { $gte: start, $lte: end } })
      .select(ORDER_FIELDS)
      .lean(),
    // Bills deleted in this window by/for this cashier: shown to the verifier, not counted.
    POSOrder.find({
      branch,
      isDeleted: true,
      deletedAt: { $gte: start, $lte: end },
      $or: [{ cashier: toId(cashier) }, { deletedBy: toId(cashier) }, { cashSession: toId(session._id) }],
    })
      .select('orderNumber total paymentMethod createdAt deletedAt')
      .lean(),
  ]);

  let cashSales = 0;
  let cashReceivedOnCredit = 0;
  let cashRefunds = 0;
  const nonCash = { card: 0, bank_transfer: 0 };
  const bills = new Map();
  const bill = (o) => {
    const key = String(o._id);
    if (!bills.has(key)) {
      bills.set(key, {
        _id: o._id,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        customerName: (o.customerInfo && o.customerInfo.name) || '',
        total: round2(o.total),
        paymentMethod: o.paymentMethod,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        pendingAmount: round2(o.pendingAmount),
        cashSale: 0,
        cashCredit: 0,
        nonCash: 0,
        cashRefund: 0,
      });
    }
    return bills.get(key);
  };

  for (const o of paidOrders) {
    const history = o.paymentHistory || [];
    const createdAt = new Date(o.createdAt).getTime();
    history.forEach((entry) => {
      if (String(entry.receivedBy) !== cashier) return;
      const at = new Date(entry.paidAt).getTime();
      if (at < start.getTime() || at > end.getTime()) return;
      const b = bill(o);
      const cash = cashPart(entry, o);
      const other = round2((Number(entry.amount) || 0) - cash);
      if (other > 0) {
        b.nonCash = round2(b.nonCash + other);
        const k = entry.paymentMethod === 'bank_transfer' ? 'bank_transfer' : 'card';
        nonCash[k] = round2(nonCash[k] + other);
      }
      if (!cash) return;
      const atSale = createdAt >= start.getTime() && Math.abs(at - createdAt) <= SALE_PAYMENT_GAP_MS;
      if (atSale) {
        cashSales += cash;
        b.cashSale = round2(b.cashSale + cash);
      } else {
        cashReceivedOnCredit += cash;
        b.cashCredit = round2(b.cashCredit + cash);
      }
    });
    // Bank transfer paid over the bill total: the change came out of the drawer.
    const change = Number(o.changeGiven) || 0;
    if (
      o.paymentMethod === 'bank_transfer' &&
      change > 0 &&
      String(o.cashier) === cashier &&
      createdAt >= start.getTime() &&
      createdAt <= end.getTime()
    ) {
      cashSales -= change;
      const b = bill(o);
      b.cashSale = round2(b.cashSale - change);
    }
  }

  for (const o of refundedOrders) {
    const refunder = o.refundedBy || o.cashier;
    if (String(refunder) !== cashier) continue;
    const cash = round2((o.paymentHistory || []).reduce((s, e) => s + cashPart(e, o), 0));
    if (!cash) continue;
    cashRefunds += cash;
    const b = bill(o);
    b.cashRefund = round2(b.cashRefund + cash);
  }

  cashSales = round2(cashSales);
  cashReceivedOnCredit = round2(cashReceivedOnCredit);
  cashRefunds = round2(cashRefunds);
  const list = [...bills.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return {
    expected: {
      float,
      cashSales,
      cashReceivedOnCredit,
      cashRefunds,
      expectedCash: round2(float + cashSales + cashReceivedOnCredit - cashRefunds),
      billCount: list.length,
    },
    bills: list,
    voided,
    nonCash,
  };
}

/* ------------------------------------------------------------------ */
/* Serialization (blind for cashiers)                                  */
/* ------------------------------------------------------------------ */

const countView = (c) => (c ? { denominations: c.denominations || {}, total: round2(c.total) } : null);

/**
 * Session for the browser. `full` (till_verify viewers) adds expected cash,
 * variance and history; without it the cashier sees only status, times, the
 * float and their own count — never expected cash or sales.
 */
function serializeSession(s, { full = false } = {}) {
  if (!s) return null;
  const out = {
    _id: s._id,
    sessionNo: s.sessionNo,
    branch: s.branch,
    counter: s.counter,
    counterName: s.counterName,
    cashier: s.cashier,
    cashierName: s.cashierName,
    status: s.status,
    openedAt: s.openedAt,
    openingFloat: countView(s.openingFloat),
    openNote: s.openNote || '',
    lateOpen: !!s.lateOpen,
    closedAt: s.closedAt || null,
    closingCount: countView(s.closingCount),
    closeNote: s.closeNote || '',
    lateClose: !!s.lateClose,
    verifiedAt: s.verifiedAt || null,
    verifyNote: s.verifyNote || '',
  };
  if (full) {
    out.expected = s.status === 'open' ? null : s.expected || null;
    out.variance = s.status === 'open' ? null : s.variance;
    out.verifiedBy = s.verifiedBy || null;
    out.closedBy = s.closedBy || null;
    out.history = s.history || [];
  }
  return out;
}

const canSeeExpected = (access) => !!access && access.can('till_verify', 'view');

/* ------------------------------------------------------------------ */
/* Open / close / verify                                               */
/* ------------------------------------------------------------------ */

async function userName(userId) {
  const u = await User.findById(userId).select('firstName lastName email').lean();
  return fullName(u) || (u && u.email) || 'Staff';
}

/** Branch-scope check for one session (staff: own branch only). */
function assertSessionBranch(access, session) {
  if (access.isSuperAdmin) return;
  if (!sameId(session.branch, access.userBranchId)) throw httpError(404, 'Till session not found');
}

async function openSession(req, { counterId, denominations, note } = {}) {
  const access = req.access;
  const userId = access.userId;
  const branchId = String(await resolveWriteBranch(req));
  const float = parseCashCount(denominations || {}, await getDenominations());

  const counters = await SaleCounter.find({ branch: toId(branchId), isActive: true }).lean();
  let counter = null;
  if (counterId) {
    counter = counters.find((c) => sameId(c._id, counterId));
    if (!counter) throw httpError(404, 'That counter is not active.');
  } else if (counters.length === 1) {
    counter = counters[0];
  } else if (counters.length > 1) {
    throw httpError(400, 'Pick the counter you are opening.', 'COUNTER_REQUIRED');
  }
  if (
    counter &&
    (counter.assignedUsers || []).length &&
    !access.isSuperAdmin &&
    !access.can('till_verify', 'edit') &&
    !counter.assignedUsers.some((u) => sameId(u, userId))
  ) {
    throw httpError(403, `You are not assigned to ${counter.name}. Ask the admin.`);
  }

  const mine = await CashSession.findOne({ cashier: userId, status: 'open' }).lean();
  if (mine) throw httpError(409, `Your till is already open (${mine.sessionNo}). Close it first.`, 'TILL_ALREADY_OPEN');
  if (counter) {
    const busy = await CashSession.findOne({ counter: counter._id, status: 'open' }).lean();
    if (busy) throw httpError(409, `${counter.name} is already open by ${busy.cashierName || 'another cashier'}.`, 'COUNTER_BUSY');
  }

  const now = new Date();
  const tz = await getTimeZone();
  const local = zonedParts(now, tz);
  const cutoff = counter ? hhmmToMinutes(counter.openCutoff) : null;
  const lateOpen = cutoff !== null && local.minutes > cutoff;
  const cashierName = await userName(userId);

  let session;
  try {
    session = await CashSession.create({
      sessionNo: await nextNumber('TILL'),
      branch: branchId,
      counter: counter ? counter._id : null,
      counterName: counter ? counter.name : '',
      cashier: userId,
      cashierName,
      status: 'open',
      openedAt: now,
      openingFloat: float,
      openNote: typeof note === 'string' ? note.trim().slice(0, 500) : '',
      lateOpen,
      history: [{ at: now, by: userId, action: 'open', note: `Opening float Rs ${float.total}` }],
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const byCounter = err.keyPattern && err.keyPattern.counter;
      throw httpError(
        409,
        byCounter ? 'This counter was just opened by someone else.' : 'Your till is already open.',
        byCounter ? 'COUNTER_BUSY' : 'TILL_ALREADY_OPEN'
      );
    }
    throw err;
  }

  if (lateOpen) {
    await notificationService.notify({
      type: 'till_late_open',
      level: 'warning',
      title: `${counter.name} opened late`,
      message: `${cashierName} opened ${counter.name} at ${formatHHMM(local.minutes)} (cut-off ${counter.openCutoff}).`,
      link: `/admin/till?session=${session._id}`,
      branchId,
      audience: 'till_verify',
      meta: { sessionId: session._id, counterId: counter._id },
    });
  }
  return session.toObject({ flattenMaps: true });
}

async function closeSession(req, id, { denominations, note } = {}) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  const own = sameId(session.cashier, access.userId);
  if (!own && !access.can('till_verify', 'edit')) throw httpError(403, 'You can only close your own till.');
  if (session.status !== 'open') throw httpError(409, 'This till is already closed.', 'TILL_ALREADY_CLOSED');

  const count = parseCashCount(denominations || {}, await getDenominations());
  const closedAt = new Date();
  const { expected } = await computeExpected(session, closedAt);
  const variance = round2(count.total - expected.expectedCash);

  // Late close: after the counter's close cut-off, or on a later day than it opened.
  let lateClose = false;
  const counter = session.counter
    ? await SaleCounter.findById(session.counter).setOptions({ withDeleted: true }).lean()
    : null;
  const cutoff = counter ? hhmmToMinutes(counter.closeCutoff) : null;
  if (cutoff !== null) {
    const tz = await getTimeZone();
    const local = zonedParts(closedAt, tz);
    lateClose = local.dayKey > zonedParts(session.openedAt, tz).dayKey || local.minutes > cutoff;
  }

  const closerNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  const updated = await CashSession.findOneAndUpdate(
    { _id: session._id, status: 'open' },
    {
      $set: {
        status: 'closed',
        closedAt,
        closedBy: access.userId,
        closingCount: count,
        closeNote: closerNote,
        expected,
        variance,
        lateClose,
      },
      $push: {
        history: { at: closedAt, by: access.userId, action: own ? 'close' : 'close_by_admin', note: closerNote },
      },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This till is already closed.', 'TILL_ALREADY_CLOSED');

  const off = Math.abs(variance) >= 1;
  await notificationService.notify({
    type: 'till_closed',
    level: off ? 'warning' : 'info',
    title: `Cash closing to verify: ${updated.counterName || updated.sessionNo}`,
    message:
      `${updated.cashierName} closed ${updated.sessionNo}. Counted Rs ${count.total}, expected Rs ${expected.expectedCash}` +
      (off ? ` (${variance < 0 ? 'short' : 'over'} Rs ${Math.abs(variance)}).` : ' (matches).'),
    link: `/admin/till?session=${updated._id}`,
    branchId: updated.branch,
    audience: 'till_verify',
    meta: { sessionId: updated._id, variance },
  });
  return updated;
}

/** verify | dispute a closed session (admin side). */
async function reviewSession(req, id, { action, note } = {}) {
  const access = req.access;
  if (!['verify', 'dispute'].includes(action)) throw httpError(400, 'Unknown action');
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  if (sameId(session.cashier, access.userId) && !access.isSuperAdmin) {
    throw httpError(403, 'You cannot verify your own till. Ask another admin.');
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  if (action === 'dispute' && !cleanNote) throw httpError(400, 'Write what is wrong (note is required to dispute).');

  const from = action === 'verify' ? ['closed', 'disputed'] : ['closed'];
  if (!from.includes(session.status)) {
    throw httpError(409, session.status === 'open' ? 'Close the till first.' : `This till is already ${session.status}.`);
  }
  const status = action === 'verify' ? 'verified' : 'disputed';
  const now = new Date();
  const updated = await CashSession.findOneAndUpdate(
    { _id: session._id, status: { $in: from } },
    {
      $set: { status, verifiedBy: access.userId, verifiedAt: now, verifyNote: cleanNote },
      $push: { history: { at: now, by: access.userId, action, note: cleanNote } },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This till was just changed by someone else. Refresh.');

  // Payroll hook: a verified short closing becomes a till-shortage deduction for
  // the cashier (one per session; never blocks verifying).
  if (status === 'verified' && Number(updated.variance) < 0) {
    try {
      await require('./hr/payrollService').recordTillShortage(updated, { userId: access.userId });
    } catch (err) {
      console.error('[till] till-shortage deduction failed:', err && err.message);
    }
  }

  await notificationService.notify({
    type: action === 'verify' ? 'till_verified' : 'till_disputed',
    level: action === 'verify' ? 'info' : 'warning',
    title: action === 'verify' ? `Your till ${updated.sessionNo} was verified` : `Your till ${updated.sessionNo} was disputed`,
    message: cleanNote,
    link: '/admin/till',
    userId: updated.cashier,
    branchId: updated.branch,
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/* Cashier status (POS strip / my till)                                */
/* ------------------------------------------------------------------ */

async function myStatus(req) {
  const access = req.access;
  const userId = access.userId;
  const branchId = String(await resolveWriteBranch(req));
  const [session, required, counters, denominations] = await Promise.all([
    CashSession.findOne({ cashier: userId, status: 'open' }).lean(),
    isTillRequired(branchId),
    SaleCounter.find({ branch: toId(branchId), isActive: true }).sort({ name: 1 }).lean(),
    getDenominations(),
  ]);
  const busy = counters.length
    ? await CashSession.find({ counter: { $in: counters.map((c) => c._id) }, status: 'open' })
        .select('counter cashier cashierName')
        .lean()
    : [];
  const busyBy = new Map(busy.map((b) => [String(b.counter), b]));
  const inThisBranch = !!session && sameId(session.branch, branchId);
  return {
    required,
    open: inThisBranch,
    openElsewhere: !!session && !inThisBranch,
    session: serializeSession(session),
    branch: branchId,
    denominations,
    counters: counters.map((c) => {
      const b = busyBy.get(String(c._id));
      const assigned = (c.assignedUsers || []).length === 0 || c.assignedUsers.some((u) => sameId(u, userId));
      return {
        _id: c._id,
        name: c.name,
        code: c.code,
        defaultFloat: round2(c.defaultFloat),
        openCutoff: c.openCutoff || '',
        closeCutoff: c.closeCutoff || '',
        busy: !!b,
        busyBy: b ? b.cashierName : '',
        mine: !!b && sameId(b.cashier, userId),
        allowed: assigned || access.isSuperAdmin || access.can('till_verify', 'edit'),
      };
    }),
    canOpen: access.can('till', 'create'),
    canClose: access.can('till', 'edit'),
  };
}

/* ------------------------------------------------------------------ */
/* Cut-off notifications                                               */
/* ------------------------------------------------------------------ */

/**
 * For every active counter with cut-offs (store time zone):
 *   - not opened at all today after its openCutoff  -> 'counter_not_opened' (once per counter per day)
 *   - a session still open after its closeCutoff, or open since an earlier
 *     day                                           -> 'counter_still_open' (once per counter per day)
 */
async function checkCutoffs(now = new Date()) {
  const tz = await getTimeZone();
  const local = zonedParts(now, tz);
  const dayStart = zonedDayStart(local.dayKey, tz);
  const counters = await SaleCounter.find({
    isActive: true,
    $or: [{ openCutoff: { $nin: ['', null] } }, { closeCutoff: { $nin: ['', null] } }],
  }).lean();
  const result = { day: local.dayKey, time: formatHHMM(local.minutes), checked: counters.length, notified: 0 };
  if (!counters.length) return result;

  const ids = counters.map((c) => c._id);
  const [openSessions, openedToday] = await Promise.all([
    CashSession.find({ counter: { $in: ids }, status: 'open' }).select('counter openedAt cashierName sessionNo').lean(),
    CashSession.distinct('counter', { counter: { $in: ids }, openedAt: { $gte: dayStart, $lte: now } }),
  ]);
  const openBy = new Map(openSessions.map((s) => [String(s.counter), s]));
  const openedSet = new Set(openedToday.map(String));

  for (const c of counters) {
    const id = String(c._id);
    const open = openBy.get(id);
    const openCut = hhmmToMinutes(c.openCutoff);
    if (openCut !== null && local.minutes > openCut && !open && !openedSet.has(id)) {
      const n = await notificationService.notify({
        type: 'counter_not_opened',
        level: 'warning',
        title: `${c.name} not opened`,
        message: `${c.name} was not opened by its ${c.openCutoff} cut-off today (${local.dayKey}).`,
        link: '/admin/till',
        branchId: c.branch,
        audience: 'till_verify',
        dedupeKey: `cutoff:open:${id}:${local.dayKey}`,
        meta: { counterId: c._id, day: local.dayKey },
      });
      if (n) result.notified += 1;
    }
    const closeCut = hhmmToMinutes(c.closeCutoff);
    if (open && closeCut !== null) {
      const openedEarlier = zonedParts(open.openedAt, tz).dayKey < local.dayKey;
      if (local.minutes > closeCut || openedEarlier) {
        const n = await notificationService.notify({
          type: 'counter_still_open',
          level: 'warning',
          title: `${c.name} still open`,
          message: `${c.name} (${open.sessionNo}, ${open.cashierName}) is still open after its ${c.closeCutoff} cut-off.`,
          link: `/admin/till?session=${open._id}`,
          branchId: c.branch,
          audience: 'till_verify',
          dedupeKey: `cutoff:close:${id}:${local.dayKey}`,
          meta: { counterId: c._id, sessionId: open._id, day: local.dayKey },
        });
        if (n) result.notified += 1;
      }
    }
  }
  return result;
}

// Lazy check when someone loads notifications (each server instance at most every 5 min).
const LAZY_EVERY_MS = 5 * 60 * 1000;
let lastLazyCheck = 0;
async function maybeCheckCutoffs() {
  if (Date.now() - lastLazyCheck < LAZY_EVERY_MS) return null;
  lastLazyCheck = Date.now();
  try {
    return await checkCutoffs(new Date());
  } catch (err) {
    console.error('[till] cut-off check failed:', err && err.message);
    return null;
  }
}

module.exports = {
  resolveSaleSession,
  attachOrder,
  // till workflow
  openSession,
  closeSession,
  reviewSession,
  computeExpected,
  myStatus,
  serializeSession,
  canSeeExpected,
  assertSessionBranch,
  isTillRequired,
  getDenominations,
  parseCashCount,
  cashPart,
  // cut-offs
  checkCutoffs,
  maybeCheckCutoffs,
  // store time helpers
  getTimeZone,
  zonedParts,
  zonedDayStart,
  dayRange,
  hhmmToMinutes,
  DEFAULT_DENOMINATIONS,
};
