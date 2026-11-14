// src/services/refundExpenseLink.js
// Expenses with the category "Refund" give money back on a POS bill.
//   - The bill is picked by its number (at least 3 characters typed).
//   - All refund expenses of one bill together never go over what was PAID on it.
//   - A bill refunded in full from the POS (orderStatus 'refunded') cannot get more.
//   - Only the money is recorded: the bill and its stock stay as they are.
// The till takes the cash off like any other cash expense of its counter.

const mongoose = require('mongoose');
const POSOrder = require('../models/posOrder');
const Expense = require('../models/expense');
const ExpenseCategory = require('../models/expenseCategory');

const REFUND_CATEGORY = 'Refund';
const MIN_SEARCH = 3;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Categories as a list ("A, B" string or array) -> true when one of them is Refund. */
function isRefund(categories) {
  const list = Array.isArray(categories) ? categories : String(categories || '').split(',');
  return list.some((c) => String(c).trim().toLowerCase() === REFUND_CATEGORY.toLowerCase());
}

/** Money taken on the bill that can be given back (0 = nothing). */
function paidOn(o) {
  if (!o || o.isDeleted || o.orderStatus === 'cancelled') return 0;
  if (o.orderStatus === 'refunded' || o.paymentStatus === 'refunded') return 0;
  const paid = Number(o.paidAmount) || 0;
  if (paid > 0) return round2(paid);
  // Old bills without paidAmount: paid in full unless marked pending / partial.
  return ['pending', 'partial'].includes(o.paymentStatus) ? 0 : round2(o.total);
}

/** { orderId: amount already refunded by expenses } (deleted expenses do not count). */
async function refundedByExpenses(orderIds, excludeExpenseId = null) {
  const ids = orderIds.filter((x) => mongoose.isValidObjectId(String(x))).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return new Map();
  const match = { posOrder: { $in: ids }, isDeleted: { $ne: true } };
  if (excludeExpenseId && mongoose.isValidObjectId(String(excludeExpenseId))) {
    match._id = { $ne: new mongoose.Types.ObjectId(String(excludeExpenseId)) };
  }
  const rows = await Expense.aggregate([{ $match: match }, { $group: { _id: '$posOrder', total: { $sum: '$amount' } } }]);
  return new Map(rows.map((r) => [String(r._id), round2(r.total)]));
}

const view = (o, refunded) => {
  const paid = paidOn(o);
  return {
    _id: o._id,
    orderNumber: o.orderNumber,
    offlineNumber: (o.offline && o.offline.number) || '',
    createdAt: o.createdAt,
    total: round2(o.total),
    paid,
    refunded: round2(refunded || 0),
    refundable: Math.max(0, round2(paid - (refunded || 0))),
    orderStatus: o.orderStatus,
    paymentMethod: o.paymentMethod,
    customerName: (o.customerInfo && o.customerInfo.name) || '',
  };
};

const ORDER_FIELDS = 'orderNumber offline.number createdAt total paidAmount paymentStatus orderStatus paymentMethod customerInfo.name isDeleted';

/** Bills whose number contains `q` (at least 3 characters), newest first. */
async function searchBills(q, limit = 10) {
  const text = String(q || '').trim();
  if (text.length < MIN_SEARCH) throw httpError(400, `Type at least ${MIN_SEARCH} characters of the bill number`);
  const rx = new RegExp(escapeRegex(text.slice(0, 60)), 'i');
  const orders = await POSOrder.find({
    isDeleted: { $ne: true },
    orderStatus: { $ne: 'cancelled' },
    $or: [{ orderNumber: rx }, { 'offline.number': rx }],
  })
    .select(ORDER_FIELDS)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 20))
    .lean();
  const done = await refundedByExpenses(orders.map((o) => o._id));
  return orders.map((o) => view(o, done.get(String(o._id))));
}

/** One bill with what is left to refund (null when not found). */
async function billInfo(orderId, excludeExpenseId = null) {
  if (!orderId || !mongoose.isValidObjectId(String(orderId))) return null;
  const o = await POSOrder.findOne({ _id: orderId, isDeleted: { $ne: true } }).select(ORDER_FIELDS).lean();
  if (!o) return null;
  const done = await refundedByExpenses([o._id], excludeExpenseId);
  return view(o, done.get(String(o._id)));
}

/**
 * Check a refund of `amount` on the bill. `excludeExpenseId` = the expense being
 * changed (its own old amount does not count). Returns the bill view; throws 400.
 */
async function checkRefund(orderId, amount, excludeExpenseId = null) {
  if (!orderId || orderId === 'null') throw httpError(400, 'Pick the bill (type its number) for this refund');
  const bill = await billInfo(orderId, excludeExpenseId);
  if (!bill) throw httpError(400, 'Bill not found');
  if (bill.orderStatus === 'refunded') throw httpError(400, `Bill ${bill.orderNumber} is already refunded in full`);
  const amt = round2(amount);
  if (!(amt > 0)) throw httpError(400, 'Enter the refund amount');
  if (amt - bill.refundable > 0.009) {
    throw httpError(
      400,
      bill.refundable > 0
        ? `At most Rs ${bill.refundable} can be refunded on bill ${bill.orderNumber} (paid Rs ${bill.paid}${bill.refunded ? `, already refunded Rs ${bill.refunded}` : ''})`
        : `Nothing is left to refund on bill ${bill.orderNumber}`
    );
  }
  return bill;
}

/** Make sure the "Refund" category exists (a deleted one is brought back). Once per process. */
let ensured = false;
async function ensureCategory() {
  if (ensured) return;
  const rx = new RegExp(`^${REFUND_CATEGORY}$`, 'i');
  const live = await ExpenseCategory.findOne({ name: rx, isDeleted: { $ne: true } }).lean();
  if (!live) {
    const old = await ExpenseCategory.findOne({ name: rx });
    if (old) {
      old.isDeleted = false;
      old.isActive = true;
      old.deletedAt = null;
      old.deletedBy = null;
      await old.save();
    } else {
      try {
        await ExpenseCategory.create({ name: REFUND_CATEGORY, description: 'Money given back to a customer on a bill' });
      } catch (e) {
        if (e && e.code !== 11000) throw e; // made at the same time by another request
      }
    }
  } else if (live.isActive === false) {
    await ExpenseCategory.updateOne({ _id: live._id }, { $set: { isActive: true } });
  }
  ensured = true;
}

// How the money went back -> expense payment method. Cash comes off the refunder's
// open till; bank / JazzCash / card never touch the till (tillService skips
// non-cash refund expenses).
const REFUND_METHODS = {
  cash: { paymentMethod: 'Cash', label: 'Cash' },
  bank_transfer: { paymentMethod: 'Bank Transfer', label: 'Bank (UBL)' },
  jazzcash: { paymentMethod: 'Other', label: 'JazzCash' },
  card: { paymentMethod: 'Other', label: 'Card' },
};

/**
 * Part refund from the POS order screen (owner 2026-11-14): the same record as a
 * "Refund" expense typed on Add expense, linked to the bill. Stock is not touched.
 * Cash comes off the refunder's open till; without one (admin) off the counter the bill was
 * sold on (its open till, else its next till to close). Dated that till's opening day.
 * @returns { expense, bill } (bill = what is left to refund after this one)
 */
async function createPartialRefund({ orderId, amount, reason = '', method = 'cash', access, user, branch }) {
  const m = REFUND_METHODS[method];
  if (!m) throw httpError(400, 'Refund method must be cash, bank_transfer, jazzcash or card');
  const amt = round2(amount);
  const bill = await checkRefund(orderId, amt);
  const CashSession = require('../models/cashSession');
  const tillService = require('./tillService');
  const userId = access && access.userId ? access.userId : null;
  // Cash: from the refunder's own open till; someone without one (admin) gives it from the
  // counter the bill was sold on (that counter's open till, else its next till to close).
  let session = null; // the refunder's own till (cashier list shows the refund there)
  let counterTill = null; // open till of the bill's counter (admin refund)
  let counter = null;
  let counterName = '';
  if (method === 'cash') {
    session = userId ? await CashSession.findOne({ cashier: userId, status: 'open' }).select('_id counter counterName openedAt').lean() : null;
    if (session) {
      counter = session.counter || null;
      counterName = session.counterName || '';
    } else {
      const sold = await POSOrder.findById(bill._id).select('counter').lean();
      if (sold && sold.counter) {
        counter = sold.counter;
        counterTill = await CashSession.findOne({ counter: sold.counter, status: 'open' }).select('openedAt counterName').lean();
        const SaleCounter = require('../models/saleCounter');
        const c = await SaleCounter.findById(sold.counter).setOptions({ withDeleted: true }).select('name').lean();
        counterName = (c && c.name) || (counterTill && counterTill.counterName) || '';
      }
    }
  }
  const tz = await tillService.getTimeZone();
  const tillFor = session || counterTill;
  const dayKey = tillService.zonedParts(tillFor ? tillFor.openedAt : new Date(), tz).dayKey;
  await ensureCategory();
  const cleanReason = String(reason || '').trim().slice(0, 300);
  const u = user || {};
  const expense = await Expense.create({
    branch: branch || null,
    title: `Refund: ${bill.orderNumber}`,
    amount: amt,
    category: REFUND_CATEGORY,
    categories: [REFUND_CATEGORY],
    date: new Date(`${dayKey}T00:00:00.000Z`),
    paymentMethod: m.paymentMethod,
    counter,
    counterName,
    posOrder: bill._id,
    posOrderNumber: bill.orderNumber,
    cashSession: session ? session._id : null,
    createdBy: userId,
    createdByName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '',
    notes: [`Part refund from POS orders (${m.label})`, cleanReason].filter(Boolean).join(' · '),
  });
  // A line on the bill so it shows there too (the bill itself stays as sold).
  const line = `Part refund Rs ${amt} (${m.label})${cleanReason ? `: ${cleanReason}` : ''}`;
  const order = await POSOrder.findById(bill._id).select('notes');
  if (order) {
    order.notes = order.notes ? `${order.notes}\n${line}` : line;
    await order.save();
  }
  return { expense, bill: await billInfo(bill._id) };
}

module.exports = {
  REFUND_CATEGORY,
  REFUND_METHODS,
  createPartialRefund,
  MIN_SEARCH,
  isRefund,
  paidOn,
  refundedByExpenses,
  searchBills,
  billInfo,
  checkRefund,
  ensureCategory,
};
