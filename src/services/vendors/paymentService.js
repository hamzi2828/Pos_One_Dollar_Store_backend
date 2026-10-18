// src/services/vendors/paymentService.js
// Vendor payments ("VP-2026-00001"). Recording a payment posts ONE `payment`
// debit row in the vendor ledger (unique per payment, safe to retry); voiding
// it voids that row. Both stay visible in the statement.
const VendorPayment = require('../../models/vendorPayment');
const Bank = require('../../models/bank');
const ledger = require('../vendorLedgerService');
const { nextNumber } = require('../sequenceService');
const { loadVendor } = require('./vendorService');
const {
  round2,
  httpError,
  oid,
  requireId,
  str,
  money,
  docDate,
  dateRange,
  pageParams,
  pageMeta,
  searchRx,
  scope,
  assertInScope,
  userNames,
  branchNames,
  historyRow,
} = require('./common');

const METHOD_LABELS = { cash: 'Cash', bank: 'Bank transfer', cheque: 'Cheque', easypaisa: 'Easypaisa', jazzcash: 'JazzCash', other: 'Other' };

const notify = async (payload) => {
  try {
    await require('../notificationService').notify(payload);
  } catch (_) {
    /* never fails a payment */
  }
};

/**
 * Record a payment (also used by consignment settlements "pay now").
 * @returns the saved payment (plain) with `ledgerEntry` set
 */
async function recordPayment({ vendorId, branchId, amount, method, bankId, reference, date, notes, attachments = [], settlementId = null, userId }) {
  const vendor = await loadVendor(vendorId);
  const value = money(amount, 'Amount', { positive: true });
  const m = String(method || '').toLowerCase();
  if (!VendorPayment.METHODS.includes(m)) throw httpError(`Payment method must be one of: ${VendorPayment.METHODS.join(', ')}`);
  const ref = str(reference, 100);
  if (m === 'cheque' && !ref) throw httpError('Please enter the cheque number');
  let bank = null;
  if (bankId) {
    bank = await Bank.findOne({ _id: requireId(bankId, 'bank'), isDeleted: { $ne: true } }).select('name accountTitle accountNumber').lean();
    if (!bank) throw httpError('Bank account not found', 404);
  }
  const branch = requireId(branchId, 'branch');
  const when = docDate(date);
  const paymentNo = await nextNumber('VP');

  const payment = await VendorPayment.create({
    paymentNo,
    vendor: vendor._id,
    vendorName: vendor.name,
    branch,
    amount: value,
    method: m,
    bank: bank ? bank._id : null,
    reference: ref,
    date: when,
    attachments: (attachments || []).filter(Boolean),
    notes: str(notes, 1000),
    settlement: oid(settlementId),
    createdBy: oid(userId),
    history: [historyRow(userId, 'created', `${METHOD_LABELS[m]} Rs ${value}`)],
  });

  let entry;
  try {
    entry = await ledger.post({
      vendorId: vendor._id,
      type: 'payment',
      debit: value,
      date: when,
      branchId: branch,
      method: m,
      bankId: bank ? bank._id : null,
      reference: ref,
      attachments: payment.attachments,
      refType: 'VendorPayment',
      refId: payment._id,
      refNo: paymentNo,
      description: str(notes, 300) || `${METHOD_LABELS[m]} payment${bank ? ` from ${bank.name}` : ''}`,
      userId,
      unique: true,
    });
  } catch (e) {
    // No ledger row -> no payment.
    await VendorPayment.deleteOne({ _id: payment._id });
    throw e;
  }
  await VendorPayment.updateOne({ _id: payment._id }, { $set: { ledgerEntry: entry._id } });

  notify({
    type: 'vendor_payment',
    title: `Vendor paid: ${vendor.name}`,
    message: `${paymentNo} · Rs ${value.toLocaleString('en-PK')} by ${METHOD_LABELS[m]}`,
    level: 'info',
    link: `/admin/vendors/${vendor._id}`,
    branchId: branch,
    audience: 'vendor_payments',
  });
  return { ...payment.toObject(), ledgerEntry: entry._id };
}

/** POST /api/vendor-payments (multipart: up to 5 `attachments` photos). */
async function create(req, body = {}, attachments = []) {
  const { resolveWriteBranch } = require('../../middleware/access');
  const branchId = await resolveWriteBranch(req);
  const payment = await recordPayment({
    vendorId: body.vendorId || body.vendor,
    branchId,
    amount: body.amount,
    method: body.method,
    bankId: body.bankId || body.bank,
    reference: body.reference,
    date: body.date,
    notes: body.notes,
    attachments,
    userId: req.access.userId,
  });
  return getById(req, payment._id);
}

const decorate = async (rows) => {
  const [users, branches] = await Promise.all([
    userNames(rows.flatMap((r) => [r.createdBy, r.voidedBy])),
    branchNames(rows.map((r) => r.branch)),
  ]);
  const bankIds = [...new Set(rows.map((r) => r.bank && String(r.bank)).filter(Boolean))];
  const banks = bankIds.length ? await Bank.find({ _id: { $in: bankIds } }).select('name accountTitle accountNumber').lean() : [];
  const bankMap = new Map(banks.map((b) => [String(b._id), b]));
  return rows.map((r) => ({
    ...r,
    methodLabel: METHOD_LABELS[r.method] || r.method,
    bankName: r.bank && bankMap.get(String(r.bank)) ? bankMap.get(String(r.bank)).name : '',
    branchName: r.branch && branches.get(String(r.branch)) ? branches.get(String(r.branch)).name : '',
    createdByName: r.createdBy ? users.get(String(r.createdBy)) || '' : '',
    voidedByName: r.voidedBy ? users.get(String(r.voidedBy)) || '' : '',
  }));
};

/** GET /api/vendor-payments?vendor&method&status&from&to&search — list + summary. */
async function list(req, query = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope(req) };
  const vendor = query.vendor || query.vendorId;
  if (vendor) filter.vendor = requireId(vendor, 'vendor');
  if (query.method) {
    if (!VendorPayment.METHODS.includes(query.method)) throw httpError('Unknown payment method');
    filter.method = query.method;
  }
  if (query.status && ['active', 'voided'].includes(query.status)) filter.status = query.status;
  const range = dateRange(query.from, query.to);
  if (range) filter.date = range;
  const rx = searchRx(query.search);
  if (rx) filter.$or = [{ paymentNo: rx }, { reference: rx }, { vendorName: rx }, { notes: rx }];

  const [rows, total, sums] = await Promise.all([
    VendorPayment.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    VendorPayment.countDocuments(filter),
    VendorPayment.aggregate([
      { $match: filter },
      { $group: { _id: { status: '$status', method: '$method' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);
  const summary = { total: 0, count: 0, voidedCount: 0, voidedAmount: 0, byMethod: {} };
  for (const s of sums) {
    if (s._id.status === 'voided') {
      summary.voidedCount += s.count;
      summary.voidedAmount = round2(summary.voidedAmount + s.amount);
      continue;
    }
    summary.total = round2(summary.total + s.amount);
    summary.count += s.count;
    summary.byMethod[s._id.method] = { amount: round2(s.amount), count: s.count };
  }
  return { data: await decorate(rows), meta: pageMeta(page, limit, total, { summary }) };
}

async function getById(req, id) {
  const p = await VendorPayment.findById(requireId(id, 'payment')).lean();
  if (!p) throw httpError('Payment not found', 404);
  assertInScope(req, p, 'Payment');
  const [row] = await decorate([p]);
  return row;
}

/** POST /api/vendor-payments/:id/void { reason } — payment + its ledger row voided, both kept. */
async function voidPayment(req, id, body = {}) {
  const p = await VendorPayment.findById(requireId(id, 'payment')).lean();
  if (!p) throw httpError('Payment not found', 404);
  assertInScope(req, p, 'Payment');
  if (p.status === 'voided') throw httpError('This payment is already voided', 409, 'ALREADY_VOIDED');
  const reason = str(body.reason, 500);
  if (reason.length < 3) throw httpError('Please write why this payment is voided');
  const userId = req.access.userId;
  const updated = await VendorPayment.findOneAndUpdate(
    { _id: p._id, status: 'active' },
    {
      $set: { status: 'voided', voidedAt: new Date(), voidedBy: oid(userId), voidReason: reason },
      $push: { history: historyRow(userId, 'voided', reason) },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError('This payment is already voided', 409, 'ALREADY_VOIDED');
  await ledger.voidByRef('VendorPayment', p._id, { userId, reason: `Payment voided: ${reason}` });
  return getById(req, p._id);
}

/** Active bank accounts for the payment form (no `banks` permission needed). */
async function bankOptions() {
  return Bank.find({ isDeleted: { $ne: true }, isActive: { $ne: false } })
    .select('name accountTitle accountNumber')
    .sort({ name: 1 })
    .lean();
}

module.exports = { METHOD_LABELS, recordPayment, create, list, getById, voidPayment, bankOptions };
