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


// Partial / full payment of a NEW sale from the server total.
const paymentPlan = ({ total, paymentMethod, isPartialPayment, paidAmount, cashAmount }) => {
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
  } else if (paymentMethod === 'bank_transfer') {
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

const PAYMENT_METHODS = ['cash', 'card', 'split', 'bank_transfer'];

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
  PAYMENT_METHODS,
  paymentPlan,
  pricingInput,
  orderMovement,
  loadOrderForResponse,
  queueReceipt,
};
