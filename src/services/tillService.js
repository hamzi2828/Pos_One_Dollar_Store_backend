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
//   await tillService.findSessionAt(cashierId, at, { branchId }) // offline sales: session open at that time
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

/**
 * Till session of a cashier for a sale made at `at` (offline sales uploaded later):
 * the session that was open at that time (openedAt <= at and not closed before it),
 * else the cashier's session open right now, else null. Branch-limited when given.
 * -> { session, counter, match: 'at_time' | 'open_now' } | null
 */
async function findSessionAt(cashierId, at, { branchId = null } = {}) {
  const cashier = toId(cashierId);
  if (!cashier) return null;
  const when = new Date(at);
  const branch = branchId ? { branch: toId(branchId) } : {};
  let match = 'at_time';
  let session = null;
  if (!Number.isNaN(when.getTime())) {
    session = await CashSession.findOne({
      cashier,
      ...branch,
      openedAt: { $lte: when },
      $or: [{ closedAt: null }, { closedAt: { $gte: when } }],
    })
      .sort({ openedAt: -1 })
      .lean();
  }
  if (!session) {
    match = 'open_now';
    session = await CashSession.findOne({ cashier, ...branch, status: 'open' }).lean();
  }
  if (!session) return null;
  const counter = session.counter ? await SaleCounter.findById(session.counter).setOptions({ withDeleted: true }).lean() : null;
  return { session, counter, match };
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
  'orderNumber total subtotal paymentMethod cashAmount cardAmount changeGiven paidAmount pendingAmount paymentHistory createdAt orderStatus paymentStatus cashier cashSession refundedAt refundedBy refundMethod customerInfo.name isDeleted deletedAt';

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
/**
 * Money paid out of the till: expenses (not shop use) and vendor payments made
 * in cash. Owner's rule (2026-11-08): what is paid after one till closes, up to
 * when the next till closes, comes off that next till.
 *   - Time of a payout = when it was entered. If it is dated an EARLIER day
 *     (entered late), midday of that day is used, so it lands on that day's till.
 *   - The till = the first one (this branch) to close at or after that time
 *     (a still-open till closes "last"); ties go to the till opened first.
 * Vendor payments made at the market on a purchase trip are not from the till.
 */
const PAYOUT_LOOKBACK_MS = 3 * 86400000;

/**
 * Tills closed before payoutIds were saved: the expenses they took off, by the
 * old rule (expenses DATED the day the till opened; with several tills that day,
 * the one open when it was entered, else the first). They never counted vendor payments.
 */
async function legacyPayoutIds(t, tz) {
  const day = zonedParts(t.openedAt, tz).dayKey;
  const dayDate = new Date(`${day}T00:00:00.000Z`);
  const rows = await mongoose.connection.db
    .collection('expenses')
    .find({ date: { $gte: dayDate, $lt: new Date(dayDate.getTime() + 86400000) }, isDeleted: { $ne: true }, source: { $ne: 'shop_use' }, fromPersonal: { $ne: true }, paymentMethod: { $ne: 'Bank Transfer' } }) // bank-paid: not from the counter cash
    .project({ createdAt: 1, branch: 1 })
    .toArray();
  if (!rows.length) return [];
  const start = zonedDayStart(day, tz);
  const sameDay = await CashSession.find({ branch: toId(t.branch), openedAt: { $gte: start, $lt: new Date(start.getTime() + 86400000) } })
    .select('openedAt closedAt')
    .sort({ openedAt: 1 })
    .lean();
  const list = sameDay.length ? sameDay : [t];
  const owner = (x) => {
    const at = new Date(x.createdAt).getTime();
    const hit = list.find((s) => at >= new Date(s.openedAt).getTime() && (!s.closedAt || at <= new Date(s.closedAt).getTime()));
    return String((hit || list[0])._id);
  };
  return rows.filter((x) => !x.branch || String(x.branch) === String(t.branch)).filter((x) => owner(x) === String(t._id)).map((x) => x._id);
}

async function sessionExpenses(session) {
  const tz = await getTimeZone();
  const branchId = toId(session.branch);
  const from = new Date(new Date(session.openedAt).getTime() - PAYOUT_LOOKBACK_MS);
  const to = new Date(session.closedAt || Date.now());
  const near = { $gte: new Date(from.getTime() - 86400000), $lte: new Date(to.getTime() + 86400000) };
  // Saved at close: this till keeps exactly what it counted.
  const own = Array.isArray(session.payoutIds) ? session.payoutIds.map((x) => String(x)) : null;
  const ownIds = (own || []).map((x) => new mongoose.Types.ObjectId(x));
  const db = mongoose.connection.db;
  const [expenseRows, paymentRows, tripRows] = await Promise.all([
    db
      .collection('expenses')
      .find({ $or: [{ date: near }, { createdAt: near }, { _id: { $in: ownIds } }], isDeleted: { $ne: true }, source: { $ne: 'shop_use' }, fromPersonal: { $ne: true }, paymentMethod: { $ne: 'Bank Transfer' } }) // bank-paid: not from the counter cash
      .project({ title: 1, amount: 1, paymentMethod: 1, createdAt: 1, branch: 1, date: 1, counter: 1, counterName: 1 })
      .toArray(),
    db
      .collection('vendorpayments')
      .find({ $or: [{ date: near }, { createdAt: near }, { _id: { $in: ownIds } }], status: 'active', method: 'cash', branch: branchId, notes: { $not: /^Paid at the market/ } })
      .project({ vendorName: 1, paymentNo: 1, amount: 1, createdAt: 1, date: 1, counter: 1, counterName: 1 })
      .toArray(),
    // Trip costs (owner 2026-11-08): paid from the shop cash on their date.
    db
      .collection('purchaseorders')
      .find({
        status: { $ne: 'cancelled' },
        $or: [{ 'charges.date': near }, { 'charges.createdAt': near }, { 'charges._id': { $in: ownIds } }],
      })
      .project({ poNumber: 1, branch: 1, charges: 1 })
      .toArray(),
  ]);
  const dayOf = (d) => zonedParts(d, tz).dayKey;
  // When the money left the till.
  const timeOf = (x) => {
    const entered = new Date(x.createdAt || x.date);
    if (!x.date) return entered.getTime();
    const day = dayOf(x.date);
    return day < dayOf(entered) ? zonedDayStart(day, tz).getTime() + 12 * 3600000 : entered.getTime();
  };
  const rows = [
    ...expenseRows
      .filter((x) => !x.branch || String(x.branch) === String(branchId))
      .map((x) => ({
        _id: x._id,
        title: x.title || '',
        amount: round2(x.amount),
        paymentMethod: x.paymentMethod || '',
        createdAt: x.createdAt,
        at: timeOf(x),
        kind: 'expense',
        counter: x.counter ? String(x.counter) : null,
        counterName: x.counterName || '',
      })),
    ...paymentRows.map((x) => ({
      _id: x._id,
      title: `Vendor payment: ${x.vendorName || 'vendor'}${x.paymentNo ? ` (${x.paymentNo})` : ''}`,
      amount: round2(x.amount),
      paymentMethod: 'Cash',
      createdAt: x.createdAt,
      at: timeOf(x),
      kind: 'vendor_payment',
      counter: x.counter ? String(x.counter) : null,
      counterName: x.counterName || '',
    })),
    ...tripRows
      .filter((po) => !po.branch || String(po.branch) === String(branchId))
      .flatMap((po) =>
        // Only cash trip costs come off the till ('' = old row, cash).
        (po.charges || []).filter((c) => !c.method || c.method === 'cash').map((c) => ({
          _id: c._id,
          title: `Trip cost ${po.poNumber}: ${String(c.type || 'other').replace(/_/g, ' ')}${c.note ? ` · ${c.note}` : ''}`,
          amount: round2(c.amount),
          paymentMethod: 'Cash',
          createdAt: c.createdAt,
          at: timeOf({ date: c.date, createdAt: c.createdAt }),
          kind: 'trip_cost',
        }))
      ),
  ].filter((x) => x.amount > 0);
  // Money paid before the shop's first till day never comes off a till (shop set-up, opening stock).
  const first = await CashSession.findOne({ branch: branchId }).sort({ openedAt: 1 }).select('openedAt').lean();
  const firstDay = first ? zonedDayStart(dayOf(first.openedAt), tz).getTime() : 0;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].at < firstDay) rows.splice(i, 1);
  if (!rows.length) return [];
  const pick = (x) => ({
    _id: x._id,
    title: x.title,
    amount: x.amount,
    paymentMethod: x.paymentMethod,
    createdAt: x.createdAt,
    kind: x.kind,
    shopUse: false,
    ...(x.counter ? { counter: x.counter, counterName: x.counterName } : {}),
  });
  const mine = new Set(own || []);

  const tills = await CashSession.find({
    branch: branchId,
    openedAt: { $lte: new Date(to.getTime() + 30 * 86400000) },
    $or: [{ closedAt: null }, { closedAt: { $gte: new Date(from.getTime() - PAYOUT_LOOKBACK_MS) } }],
  })
    .select('openedAt closedAt status branch payoutIds counter')
    .lean();
  // Payouts other tills already took off their cash never count again.
  // (id -> tills that took it). A claim by an unverified till of ANOTHER counter is
  // dropped when the expense's counter was changed: it moves to the right till.
  const claimed = new Map();
  for (const t of tills) {
    if (String(t._id) === String(session._id) || t.status === 'open') continue;
    let ids = t.payoutIds;
    if (!Array.isArray(ids)) {
      ids = await legacyPayoutIds(t, tz);
      await CashSession.updateOne({ _id: t._id, payoutIds: { $exists: false } }, { $set: { payoutIds: ids } });
    }
    ids.forEach((x) => {
      const k = String(x);
      if (!claimed.has(k)) claimed.set(k, []);
      claimed.get(k).push(t);
    });
  }
  const sessionCounter = String(session.counter || '');
  const editable = (t) => t.status === 'open' || t.status === 'closed';
  const wrongCounter = (x, t) => !!x.counter && x.counter !== String(t.counter || '');
  const isClaimed = (x) => (claimed.get(String(x._id)) || []).some((t) => !(t.status === 'closed' && wrongCounter(x, t)));
  // Saved on this till, unless it is now paid from another counter (till not verified yet).
  const keepMine = (x) => mine.has(String(x._id)) && !(editable(session) && wrongCounter(x, { counter: sessionCounter }));
  if (!tills.some((t) => String(t._id) === String(session._id))) tills.push(session);
  const closeOf = (t) => (t.closedAt ? new Date(t.closedAt).getTime() : Infinity);
  tills.sort((a, b) => closeOf(a) - closeOf(b) || new Date(a.openedAt) - new Date(b.openedAt));
  // An expense paid from a counter goes only to that counter's tills: the first
  // of them to close after it. Without a counter: the first till of the shop.
  const owner = (at, counter) => {
    const hit = tills.find((t) => closeOf(t) >= at && (!counter || String(t.counter || '') === counter));
    return hit ? String(hit._id) : null;
  };
  return rows
    .filter((x) => keepMine(x) || (!isClaimed(x) && x.at >= from.getTime() && x.at <= to.getTime() && owner(x.at, x.counter) === String(session._id)))
    .sort((a, b) => a.at - b.at)
    .map(pick);
}

/**
 * A closed till not yet verified: expenses can still be added / changed after
 * closing. Bring its saved expenses, expected cash and variance up to date.
 * Verified tills stay as they were verified. Returns the (maybe updated) session.
 */
async function refreshExpenses(session) {
  if (!session || session.status !== 'closed' || !session.expected) return session;
  const expenses = await sessionExpenses(session);
  const total = round2(expenses.reduce((t, x) => t + x.amount, 0));
  const e = session.expected;
  // Keep the saved list in step (a late, backdated payout can join a closed till).
  const payoutIds = expenses.map((x) => x._id);
  const key = (ids) => (ids || []).map(String).sort().join(',');
  if (!Array.isArray(session.payoutIds) || key(session.payoutIds) !== key(payoutIds)) {
    await CashSession.updateOne({ _id: session._id, status: 'closed' }, { $set: { payoutIds } });
    session = { ...session, payoutIds };
  }
  if (Math.abs(total - (Number(e.expenses) || 0)) < 0.01) return session;
  const expectedCash = round2((e.float || 0) + (e.cashSales || 0) + (e.cashReceivedOnCredit || 0) - (e.cashRefunds || 0) - total);
  const variance = round2(((session.closingCount && session.closingCount.total) || 0) - expectedCash);
  await CashSession.updateOne({ _id: session._id, status: 'closed' }, { $set: { 'expected.expenses': total, 'expected.expectedCash': expectedCash, variance } });
  return { ...session, expected: { ...e, expenses: total, expectedCash }, variance };
}

/**
 * A closed (not verified) till after one of its bills changed (e.g. payment
 * method): work out the sales figures again up to its close time. The saved
 * expenses stay. Returns the updated session, or null when not closed.
 */
async function refreshClosedSales(sessionId, { by = null, note = '' } = {}) {
  const session = await CashSession.findById(sessionId).lean();
  if (!session || session.status !== 'closed' || !session.expected || !session.closedAt) return null;
  const { expected: fresh, nonCash } = await computeExpected(session, session.closedAt);
  const e = session.expected;
  const expenses = Number(e.expenses) || 0;
  const expectedCash = round2((e.float || 0) + fresh.cashSales + fresh.cashReceivedOnCredit - fresh.cashRefunds - expenses);
  const set = {
    'expected.cashSales': fresh.cashSales,
    'expected.cashReceivedOnCredit': fresh.cashReceivedOnCredit,
    'expected.cashRefunds': fresh.cashRefunds,
    'expected.billCount': fresh.billCount,
    'expected.card': round2(nonCash.card),
    'expected.bankTransfer': round2(nonCash.bank_transfer),
    'expected.expectedCash': expectedCash,
    variance: round2(((session.closingCount && session.closingCount.total) || 0) - expectedCash),
  };
  return CashSession.findOneAndUpdate(
    { _id: session._id, status: 'closed' },
    { $set: set, $push: { history: { at: new Date(), by, action: 'bill_changed', note } } },
    { new: true }
  ).lean();
}

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
    // Refund given in cash: everything paid on the bill leaves this till, even a bank / card bill.
    // Given back by bank / card: nothing leaves the drawer. Not recorded (old refunds): the bill's cash part.
    const paid = round2((o.paymentHistory || []).reduce((s, e) => s + Math.max(0, Number(e.amount) || 0), 0)) || round2(Number(o.paidAmount) || 0);
    const cash =
      o.refundMethod === 'cash'
        ? paid
        : o.refundMethod
          ? 0
          : round2((o.paymentHistory || []).reduce((s, e) => s + cashPart(e, o), 0));
    if (!cash) continue;
    cashRefunds += cash;
    const b = bill(o);
    b.cashRefund = round2(b.cashRefund + cash);
  }

  cashSales = round2(cashSales);
  cashReceivedOnCredit = round2(cashReceivedOnCredit);
  cashRefunds = round2(cashRefunds);
  const list = [...bills.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const expenses = await sessionExpenses(session);
  const expenseTotal = round2(expenses.reduce((t, x) => t + x.amount, 0));
  return {
    expected: {
      float,
      cashSales,
      cashReceivedOnCredit,
      cashRefunds,
      expenses: expenseTotal,
      expectedCash: round2(float + cashSales + cashReceivedOnCredit - cashRefunds - expenseTotal),
      billCount: list.length,
    },
    bills: list,
    voided,
    nonCash,
    expenses,
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
    drawerCount: countView(s.drawerCount),
    dayCash: countView(s.dayCash),
    dayCashAt: s.dayCashAt || null,
    cardTotal: s.cardTotal ?? null,
    bankTransferTotal: s.bankTransferTotal ?? null,
    closeNote: s.closeNote || '',
    draft: s.draft
      ? {
          denominations: s.draft.denominations instanceof Map ? Object.fromEntries(s.draft.denominations) : s.draft.denominations || {},
          drawerTotal: round2(s.draft.drawerTotal),
          dayCashTotal: round2(s.draft.dayCashTotal),
          dayCashDenominations:
            s.draft.dayCashDenominations instanceof Map ? Object.fromEntries(s.draft.dayCashDenominations) : s.draft.dayCashDenominations || {},
          cardTotal: s.draft.cardTotal ?? null,
          bankTransferTotal: s.draft.bankTransferTotal ?? null,
          note: s.draft.note || '',
          savedAt: s.draft.savedAt || null,
        }
      : null,
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
  let float = parseCashCount(denominations || {}, await getDenominations());

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

  // Fixed float: the counter's notes, whatever was typed.
  const fixedFloat = !!(counter && counter.floatFixed && counter.floatDenominations && Object.keys(counter.floatDenominations).length);
  if (fixedFloat) float = parseCashCount(counter.floatDenominations, await getDenominations());

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
      history: [{ at: now, by: userId, action: 'open', note: `Opening float Rs ${float.total}${fixedFloat ? ' (fixed float)' : ''}` }],
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

async function closeSession(req, id, { denominations, note, dayCashTotal, dayCashDenominations, cardTotal, bankTransferTotal } = {}) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  const own = sameId(session.cashier, access.userId);
  if (!own && !access.can('till_verify', 'edit')) throw httpError(403, 'You can only close your own till.');
  if (session.status !== 'open') throw httpError(409, 'This till is already closed.', 'TILL_ALREADY_CLOSED');

  const allowedDenoms = await getDenominations();
  const drawer = parseCashCount(denominations || {}, allowedDenoms);
  // Day's sales cash taken out of the drawer: counted note by note, or typed as one total.
  const dayNotes = parseCashCount(dayCashDenominations || {}, allowedDenoms);
  const day = dayNotes.total > 0 ? dayNotes.total : round2(Number(dayCashTotal) || 0);
  if (day < 0 || day > 100000000) throw httpError(400, "Enter a valid total for the day's cash.");
  const dayC = dayNotes.total > 0 ? dayNotes : { denominations: {}, total: day };
  const mergedNotes = { ...drawer.denominations };
  for (const [v, c] of Object.entries(dayC.denominations)) mergedNotes[v] = (mergedNotes[v] || 0) + (Number(c) || 0);
  const count = day > 0 ? { denominations: mergedNotes, total: round2(drawer.total + day) } : drawer;
  const closedAt = new Date();
  const { expected, nonCash, expenses: payouts } = await computeExpected(session, closedAt);
  expected.card = round2(nonCash.card);
  expected.bankTransfer = round2(nonCash.bank_transfer);
  const variance = round2(count.total - expected.expectedCash);
  const money = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const n = round2(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw httpError(400, `Enter a valid ${label} total.`);
    return n;
  };
  const card = money(cardTotal, 'POS machine');
  const bank = money(bankTransferTotal, 'bank transfer');

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
        drawerCount: drawer,
        ...(day > 0 ? { dayCash: dayC, dayCashAt: closedAt } : {}),
        cardTotal: card,
        bankTransferTotal: bank,
        closeNote: closerNote,
        expected,
        payoutIds: (payouts || []).map((x) => x._id),
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

/**
 * Day's cash: after closing, add the sales cash that was taken out of the drawer
 * (handed to the owner). The count becomes drawer + day's cash and the variance is
 * worked out again. Can be entered again (replaces it) until the admin verifies.
 */
async function addDayCash(req, id, { denominations, note, amount, cardTotal, bankTransferTotal } = {}) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  const own = sameId(session.cashier, access.userId);
  if (!own && !access.can('till_verify', 'edit')) throw httpError(403, 'You can only add cash to your own till.');
  if (session.status === 'open') throw httpError(409, 'Close the till first.');
  if (session.status !== 'closed') throw httpError(409, `This till is already ${session.status}.`);

  const allowed = await getDenominations();
  // One typed total (`amount`) or note by note (`denominations`).
  const notes = parseCashCount(denominations || {}, allowed);
  const cash = notes.total > 0 ? notes : Number(amount) > 0 ? { denominations: {}, total: round2(Number(amount)) } : notes;
  const extra = {};
  for (const [k, v] of [['cardTotal', cardTotal], ['bankTransferTotal', bankTransferTotal]]) {
    if (v === undefined || v === null || v === '') continue;
    const n = round2(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw httpError(400, 'Enter a valid amount.');
    extra[k] = n;
  }
  if (!(cash.total > 0) && !Object.keys(extra).length) throw httpError(400, "Enter the day's cash.");
  const drawer = session.drawerCount || session.closingCount || { denominations: {}, total: 0 };
  const merged = {};
  const plain = (m) => (m instanceof Map ? Object.fromEntries(m) : m || {});
  // Only card / bank given: keep the day's cash already entered.
  const dayC = cash.total > 0 ? cash : session.dayCash || { denominations: {}, total: 0 };
  for (const src of [plain(drawer.denominations), plain(dayC.denominations)])
    for (const [v, c] of Object.entries(src)) merged[v] = (merged[v] || 0) + (Number(c) || 0);
  const closingCount = { denominations: merged, total: round2((Number(drawer.total) || 0) + (Number(dayC.total) || 0)) };
  const variance = round2(closingCount.total - (Number(session.expected && session.expected.expectedCash) || 0));
  const now = new Date();
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  // Tills closed before card / bank were recorded: work out the system figures now.
  if (session.expected && session.expected.card === undefined && session.closedAt) {
    const { nonCash } = await computeExpected(session, session.closedAt);
    extra['expected.card'] = round2(nonCash.card);
    extra['expected.bankTransfer'] = round2(nonCash.bank_transfer);
  }
  const updated = await CashSession.findOneAndUpdate(
    { _id: session._id, status: 'closed' },
    {
      $set: {
        drawerCount: { denominations: plain(drawer.denominations), total: round2(drawer.total) },
        ...(cash.total > 0 ? { dayCash: cash, dayCashAt: now } : {}),
        ...extra,
        dayCashNote: cleanNote,
        closingCount,
        variance,
      },
      $push: { history: { at: now, by: access.userId, action: 'day_cash', note: `Day's cash Rs ${cash.total}${cleanNote ? ` · ${cleanNote}` : ''}` } },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This till was just changed. Refresh.');

  const off = Math.abs(variance) >= 1;
  await notificationService.notify({
    type: 'till_closed',
    level: off ? 'warning' : 'info',
    title: `Day's cash added: ${updated.counterName || updated.sessionNo}`,
    message:
      `${updated.cashierName} added Rs ${cash.total} day's cash to ${updated.sessionNo}. Counted now Rs ${closingCount.total}, expected Rs ${updated.expected ? updated.expected.expectedCash : 0}` +
      (off ? ` (${variance < 0 ? 'short' : 'over'} Rs ${Math.abs(variance)}).` : ' (matches).'),
    link: `/admin/till?session=${updated._id}`,
    branchId: updated.branch,
    audience: 'till_verify',
    meta: { sessionId: updated._id, variance },
  });
  return updated;
}

/**
 * Card (POS machine) and bank transfer taken by the system on this till, so the
 * till report can start with them filled in (owner, 2026-11-08). Not cash, so the
 * blind cash count is not affected.
 */
async function nonCashTotals(req, id) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  if (!sameId(session.cashier, access.userId) && !access.can('till_verify', 'view')) throw httpError(403, 'You can only see your own till.');
  const e = session.expected || {};
  if (session.status !== 'open' && e.card !== undefined && e.card !== null) {
    return { card: round2(e.card), bankTransfer: round2(e.bankTransfer || 0) };
  }
  const { nonCash } = await computeExpected(session, session.status === 'open' ? new Date() : session.closedAt || new Date());
  return { card: round2(nonCash.card), bankTransfer: round2(nonCash.bank_transfer) };
}

/** Save the till report without submitting: the till stays open and can still be edited. */
async function saveDraft(req, id, { denominations, dayCashTotal, dayCashDenominations, cardTotal, bankTransferTotal, note } = {}) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  if (!sameId(session.cashier, access.userId) && !access.can('till_verify', 'edit')) throw httpError(403, 'You can only save your own till.');
  if (session.status !== 'open') throw httpError(409, 'This till is already submitted.');
  const allowedDenoms = await getDenominations();
  const drawer = parseCashCount(denominations || {}, allowedDenoms);
  const dayNotes = parseCashCount(dayCashDenominations || {}, allowedDenoms);
  const money = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = round2(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw httpError(400, 'Enter valid amounts.');
    return n;
  };
  const draft = {
    denominations: drawer.denominations,
    drawerTotal: drawer.total,
    dayCashTotal: dayNotes.total > 0 ? dayNotes.total : money(dayCashTotal) || 0,
    dayCashDenominations: dayNotes.denominations,
    cardTotal: money(cardTotal),
    bankTransferTotal: money(bankTransferTotal),
    note: typeof note === 'string' ? note.trim().slice(0, 500) : '',
    savedAt: new Date(),
  };
  const updated = await CashSession.findOneAndUpdate(
    { _id: session._id, status: 'open' },
    { $set: { draft }, $push: { history: { at: draft.savedAt, by: access.userId, action: 'report_saved', note: `Saved, not submitted: cash ${draft.drawerTotal + draft.dayCashTotal}` } } },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This till was just submitted.');
  return updated;
}

/** verify | dispute a closed session (admin side). */
/**
 * Delete a till the shop does not need (e.g. a test till). Only a closed /
 * verified / disputed till; it is hidden from every list and report, the
 * record stays. What it took off its cash stays with it (never moves to another till).
 */
async function deleteSession(req, id, { reason } = {}) {
  const access = req.access;
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(404, 'Till session not found');
  const session = await CashSession.findById(id).lean();
  if (!session) throw httpError(404, 'Till session not found');
  assertSessionBranch(access, session);
  if (session.status === 'deleted') return session;
  if (session.status === 'open') throw httpError(409, 'Close this till first, then delete it.');
  // Keep its payouts claimed, so they never land on another till.
  if (!Array.isArray(session.payoutIds)) {
    const payouts = await sessionExpenses(session);
    await CashSession.updateOne({ _id: session._id }, { $set: { payoutIds: payouts.map((x) => x._id) } });
  }
  const now = new Date();
  const why = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  const updated = await CashSession.findOneAndUpdate(
    { _id: session._id, status: { $ne: 'open' } },
    {
      $set: { status: 'deleted', deletedAt: now, deletedBy: access.userId, deleteReason: why },
      $push: { history: { at: now, by: access.userId, action: 'deleted', note: `Deleted (was ${session.status})${why ? `: ${why}` : ''}` } },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This till was just changed. Refresh.');
  return updated;
}

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

/** Receipt printing between counters, for the open till's counter. */
async function printRouting(counterId) {
  const out = { printOn: null, printsFor: [] };
  if (!counterId) return out;
  const counter = await SaleCounter.findOne({ _id: counterId }).select('printOnCounter').lean();
  if (!counter) return out;
  if (counter.printOnCounter) {
    const target = await SaleCounter.findOne({ _id: counter.printOnCounter }).select('name').lean();
    if (target) out.printOn = { counterId: String(target._id), counterName: target.name };
  }
  const others = await SaleCounter.find({ printOnCounter: counter._id }).select('name').sort({ name: 1 }).lean();
  out.printsFor = others.map((c) => c.name);
  return out;
}

async function myStatus(req) {
  const access = req.access;
  const userId = access.userId;
  const branchId = String(await resolveWriteBranch(req));
  const [session, required, counters, denominations, lastClosed] = await Promise.all([
    CashSession.findOne({ cashier: userId, status: 'open' }).lean(),
    isTillRequired(branchId),
    SaleCounter.find({ branch: toId(branchId), isActive: true }).sort({ name: 1 }).lean(),
    getDenominations(),
    // Last closed (not yet verified) till: the cashier can still add the day's cash.
    CashSession.findOne({ cashier: userId, status: 'closed', closedAt: { $gte: new Date(Date.now() - 36 * 3600 * 1000) } })
      .sort({ closedAt: -1 })
      .lean(),
  ]);
  const busy = counters.length
    ? await CashSession.find({ counter: { $in: counters.map((c) => c._id) }, status: 'open' })
        .select('counter cashier cashierName')
        .lean()
    : [];
  const busyBy = new Map(busy.map((b) => [String(b.counter), b]));
  const inThisBranch = !!session && sameId(session.branch, branchId);
  const { printOn, printsFor } = await printRouting(session && session.counter);
  return {
    required,
    printOn,
    printsFor,
    open: inThisBranch,
    openElsewhere: !!session && !inThisBranch,
    session: serializeSession(session),
    lastClosed: serializeSession(lastClosed),
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
        floatFixed: !!c.floatFixed,
        floatDenominations: c.floatDenominations || {},
        openCutoff: c.openCutoff || '',
        closeCutoff: c.closeCutoff || '',
        busy: !!b,
        busyBy: b ? b.cashierName : '',
        mine: !!b && sameId(b.cashier, userId),
        assignedToMe: (c.assignedUsers || []).some((u) => sameId(u, userId)),
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
  findSessionAt,
  attachOrder,
  // till workflow
  openSession,
  closeSession,
  saveDraft,
  addDayCash,
  nonCashTotals,
  reviewSession,
  computeExpected,
  sessionExpenses,
  refreshExpenses,
  refreshClosedSales,
  deleteSession,
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
