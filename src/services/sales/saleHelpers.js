// src/services/sales/saleHelpers.js
// Pieces of a POS sale shared by posController.createOrder (online sale) and
// offlineSaleService (sales made on the counter PC without internet), so both
// build an order the same way.
//
//   PAYMENT_METHODS, paymentPlan(), pricingInput(), orderMovement(),
//   loadOrderForResponse(id), queueReceipt(order, event),
//   cleanClientId(v), findByClientId(clientId), isClientIdDuplicate(err)
const POSOrder = require('../../models/posOrder');
const { PAYMENT_STATUS } = require('../../constants/paymentNotes');
const notificationService = require('../notificationService');
const pricing = require('./pricingService');

// clientId the POS made for a sale (uuid). Invalid -> '' (ignored).
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const cleanClientId = (v) => {
  const id = v === undefined || v === null ? '' : String(v).trim();
  return CLIENT_ID_RE.test(id) ? id : '';
};
// The order already saved for this clientId (online OR offline upload), or null.
const findByClientId = (clientId, select) => {
  if (!clientId) return Promise.resolve(null);
  let q = POSOrder.findOne({ $or: [{ clientId }, { 'offline.clientId': clientId }] });
  if (select) q = q.select(select);
  return q.lean();
};
// Mongo duplicate-key error on the clientId indexes (two sends of one sale at once).
const isClientIdDuplicate = (err) =>
  !!err && (err.code === 11000 || err.code === 11001) && /clientId/.test(String(err.message || '') + JSON.stringify(err.keyPattern || {}));

const isDuplicate = (err) => !!err && (err.code === 11000 || err.code === 11001);
const dupText = (err) => String(err.message || '') + JSON.stringify(err.keyPattern || {});

/**
 * Save a NEW order. Two sales saved at the same moment can draw the same bill
 * number (count + 1): then try again with the next number. When the same sale
 * (clientId) was sent twice at once and the other copy is saved, returns
 * { winner } instead of saving a second order. -> { winner: null | order }
 */
async function saveNewOrder(doc, clientId, select = '_id') {
  for (let attempt = 1; ; attempt++) {
    try {
      await doc.save();
      return { winner: null };
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const winner = clientId ? await findByClientId(clientId, select) : null;
      if (winner) return { winner };
      if (/orderNumber/.test(dupText(err)) && attempt < 5) {
        doc.orderNumber = await doc.constructor.generateOrderNumber(attempt);
        continue;
      }
      throw err;
    }
  }
}

// Ledger context of an order (StockMovement refType/refId/refNo).
const orderMovement = (order, userId, note) => ({
  refType: 'POSOrder',
  refId: order._id,
  refNo: order.orderNumber,
  userId: userId || null,
  ...(note ? { note } : {}),
});

// Same population everywhere an order is returned.
const loadOrderForResponse = (id) =>
  POSOrder.findById(id)
    .populate('customer', 'firstName lastName email phone')
    .populate('cashier', 'firstName lastName email')
    .populate('items.product', 'name thumbnailUrl bannerUrls price')
    .populate('paymentHistory.receivedBy', 'firstName lastName')
    .populate('branch', 'name code address phone');

// WhatsApp slip: queue it but never let it block or fail the sale / payment.
// The status is written compare-and-set: if the notifications module changed
// it during the call (e.g. to 'sent'), we leave its value alone. A later
// "skipped" (e.g. payment slips switched off) never hides an earlier result.
const WHATSAPP_WAIT_MS = 2500;
const queueReceipt = async (order, event, { resend = false } = {}) => {
  const before = order.whatsappStatus || 'none';
  let result = null;
  try {
    result = await Promise.race([
      notificationService.enqueueOrderReceipt(order, { event, resend }),
      new Promise((resolve) => setTimeout(() => resolve({ queued: false, reason: 'timeout' }), WHATSAPP_WAIT_MS)),
    ]);
  } catch (err) {
    console.error('[pos] whatsapp receipt failed:', err.message);
    result = { queued: false, reason: 'error' };
  }
  const queued = !!(result && result.queued);
  const reason = (result && result.reason) || '';
  const status = queued ? 'queued' : /error|fail|timeout/i.test(reason) ? 'failed' : 'skipped';
  if (before === 'none' || status !== 'skipped' || resend) {
    try {
      const unchanged = before === 'none' ? { $in: [null, 'none'] } : before;
      await POSOrder.updateOne({ _id: order._id, whatsappStatus: unchanged }, { $set: { whatsappStatus: status } });
    } catch (err) {
      console.error('[pos] whatsapp status save failed:', err.message);
    }
  }
  return { queued, reason, status };
};


// Split payment parts (owner 2026-11-14): any mix of cash / card / bank (UBL) / JazzCash.
const SPLIT_METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash'];
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * Body `splits: [{ method, amount }]` -> one amount per method (same method added up),
 * in a fixed order. Throws 400 on a bad list. Empty / missing -> null (old split rule).
 */
function normalizeSplits(splits) {
  if (splits === undefined || splits === null || splits === '') return null;
  let list = splits;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw httpError(400, 'Split payment parts are not valid', 'BAD_SPLIT');
    }
  }
  if (!Array.isArray(list)) throw httpError(400, 'Split payment parts are not valid', 'BAD_SPLIT');
  const by = new Map();
  for (const p of list) {
    const method = String((p && p.method) || '').trim();
    const amount = pricing.round2(Number(p && p.amount) || 0);
    if (!SPLIT_METHODS.includes(method)) throw httpError(400, `Unknown split payment method: ${method || '(none)'}`, 'BAD_SPLIT');
    if (amount < 0) throw httpError(400, 'Split amounts cannot be negative', 'BAD_SPLIT');
    if (amount > 0) by.set(method, pricing.round2((by.get(method) || 0) + amount));
  }
  const out = SPLIT_METHODS.filter((m) => by.has(m)).map((m) => ({ method: m, amount: by.get(m) }));
  if (!out.length) return null;
  return out;
}

// Partial / full payment of a NEW sale from the server total.
const paymentPlan = ({ total, paymentMethod, isPartialPayment, paidAmount, cashAmount, splits }) => {
  // Split with parts: each part is its own payment; extra cash = change.
  if (paymentMethod === 'split') {
    const parts = normalizeSplits(splits);
    if (parts) return splitPlan(total, parts, isPartialPayment);
  }
  let paid = total;
  let status = PAYMENT_STATUS.FULL;
  let orderStatus = 'completed';
  if (isPartialPayment && paidAmount !== undefined && paidAmount !== null && paidAmount !== '') {
    paid = Math.min(total, Math.max(0, pricing.round2(Number(paidAmount) || 0)));
    if (total - paid > 0.004) {
      status = paid > 0 ? PAYMENT_STATUS.PARTIAL : PAYMENT_STATUS.PENDING;
      orderStatus = 'pending';
    } else paid = total;
  }
  const pending = pricing.round2(Math.max(0, total - paid));
  const tendered = Number(cashAmount);
  const out = { paid, pending, status, orderStatus, cashAmount: undefined, cardAmount: undefined, changeGiven: undefined };
  if (paymentMethod === 'cash') {
    out.cashAmount = Number.isFinite(tendered) && tendered > 0 ? pricing.round2(tendered) : paid;
    out.changeGiven = pending > 0 ? 0 : pricing.round2(Math.max(0, out.cashAmount - total));
  } else if (paymentMethod === 'bank_transfer' || paymentMethod === 'jazzcash') {
    // Customer sent more than the bill: the rest given back in cash.
    out.changeGiven = pending === 0 && Number.isFinite(tendered) && tendered > total ? pricing.round2(tendered - total) : undefined;
  } else if (paymentMethod === 'card') {
    out.cardAmount = paid;
  } else if (paymentMethod === 'split') {
    // Split = some cash, the rest by card.
    const cash = Math.min(paid, Math.max(0, pricing.round2(Number.isFinite(tendered) ? tendered : 0)));
    out.cashAmount = cash;
    out.cardAmount = pricing.round2(paid - cash);
  }
  return out;
};

/**
 * Split parts -> plan. Paid = parts applied to the bill. More than the bill is only
 * allowed in cash (change given back); less is a part payment (needs isPartialPayment).
 */
function splitPlan(total, parts, isPartialPayment) {
  const sum = pricing.round2(parts.reduce((t, p) => t + p.amount, 0));
  const cash = parts.find((p) => p.method === 'cash');
  let change = 0;
  if (sum - total > 0.004) {
    change = pricing.round2(sum - total);
    if (!cash || cash.amount - change < -0.004) {
      throw httpError(400, `The parts add up to Rs ${sum}, more than the bill (Rs ${total}). Only cash can be more (change).`, 'BAD_SPLIT');
    }
  }
  const applied = parts
    .map((p) => (p.method === 'cash' && change > 0 ? { ...p, amount: pricing.round2(p.amount - change) } : p))
    .filter((p) => p.amount > 0);
  const paid = pricing.round2(applied.reduce((t, p) => t + p.amount, 0));
  const pending = pricing.round2(Math.max(0, total - paid));
  if (pending > 0.004 && !isPartialPayment) {
    throw httpError(400, `The parts add up to Rs ${paid}; the bill is Rs ${total}. Add the rest (Rs ${pending}).`, 'BAD_SPLIT');
  }
  const amountOf = (m) => (applied.find((p) => p.method === m) || {}).amount || 0;
  const full = pending <= 0.004;
  return {
    paid,
    pending: full ? 0 : pending,
    status: full ? PAYMENT_STATUS.FULL : paid > 0 ? PAYMENT_STATUS.PARTIAL : PAYMENT_STATUS.PENDING,
    orderStatus: full ? 'completed' : 'pending',
    cashAmount: amountOf('cash') + change, // cash handed over (change comes back from it)
    cardAmount: amountOf('card'),
    changeGiven: change > 0 ? change : undefined,
    splits: applied, // what each method paid on the bill
  };
}

// bank_transfer = Bank (UBL); jazzcash = JazzCash wallet, its own method (owner, 2026-11-11).
const PAYMENT_METHODS = ['cash', 'card', 'split', 'bank_transfer', 'jazzcash'];
// Methods that can carry a payment proof photo (bankTransferScreenshot).
const PROOF_METHODS = ['bank_transfer', 'jazzcash'];

// Body -> pricing input (shared by quote and createOrder so they always agree).
// Manual discount: `manualDiscount: { type, value, reason }`; the old body
// (`discount` amount + `discountReason`) still works as a fixed discount.
const pricingInput = (body, branchId, access) => {
  const manualDiscount =
    body.manualDiscount !== undefined
      ? body.manualDiscount
      : Number(body.discount) > 0
      ? { type: 'fixed', value: Number(body.discount), reason: body.discountReason }
      : null;
  return {
    items: body.items,
    branchId,
    access,
    manualDiscount,
    taxIds: body.taxIds,
    appliedTaxes: body.appliedTaxes,
  };
};

module.exports = {
  CLIENT_ID_RE,
  cleanClientId,
  findByClientId,
  isClientIdDuplicate,
  saveNewOrder,
  PAYMENT_METHODS,
  PROOF_METHODS,
  paymentPlan,
  normalizeSplits,
  SPLIT_METHODS,
  pricingInput,
  orderMovement,
  loadOrderForResponse,
  queueReceipt,
};
