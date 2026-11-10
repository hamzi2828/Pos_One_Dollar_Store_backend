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
/** Cash counter that paid ('' = none). */
async function counterFor(counterId) {
  if (counterId === undefined || counterId === null || counterId === '' || counterId === 'null') return null;
  const SaleCounter = require('../../models/saleCounter');
  const c = await SaleCounter.findOne({ _id: requireId(counterId, 'counter'), isDeleted: { $ne: true } }).select('name isActive').lean();
  if (!c || c.isActive === false) throw httpError('That counter is not active');
  return { _id: c._id, name: c.name };
}

async function recordPayment({ vendorId, branchId, amount, method, bankId, counterId, requireCounter = false, reference, date, notes, attachments = [], settlementId = null, userId }) {
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
  const counter = m === 'cash' ? await counterFor(counterId) : null;
  if (m === 'cash' && !counter && requireCounter) {
    const SaleCounter = require('../../models/saleCounter');
    if ((await SaleCounter.countDocuments({ isActive: true, isDeleted: { $ne: true } })) > 0) throw httpError('Pick which counter paid it (Paid from Counter 1 / Counter 2).');
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
    counter: counter ? counter._id : null,
    counterName: counter ? counter.name : '',
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
    counterId: body.counter,
    requireCounter: true,
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

/**
 * PUT /api/vendor-payments/:id (multipart) — change amount, method, bank,
 * reference, date, notes; add photos (`attachments`) or drop some (`removeAttachments`).
 * The payment's ledger row follows. Every change is written to the payment's history
 * (old -> new), so nothing is lost.
 */
async function updatePayment(req, id, body = {}, newAttachments = []) {
  const p = await VendorPayment.findById(requireId(id, 'payment')).lean();
  if (!p) throw httpError('Payment not found', 404);
  assertInScope(req, p, 'Payment');
  if (p.status !== 'active') throw httpError('A voided payment cannot be edited', 409, 'PAYMENT_VOIDED');
  if (p.settlement) throw httpError('This payment belongs to a consignment settlement; change it there.', 409);

  const has = (k) => body[k] !== undefined && body[k] !== null;
  const next = {};
  if (has('amount')) next.amount = money(body.amount, 'Amount', { positive: true });
  if (has('method')) {
    const m = String(body.method).toLowerCase();
    if (!VendorPayment.METHODS.includes(m)) throw httpError(`Payment method must be one of: ${VendorPayment.METHODS.join(', ')}`);
    next.method = m;
  }
  if (has('reference')) next.reference = str(body.reference, 100);
  if (has('notes')) next.notes = str(body.notes, 1000);
  if (has('date') && body.date !== '') next.date = docDate(body.date);
  const method = next.method || p.method;
  if (has('bankId') || has('method')) {
    const bankId = has('bankId') ? body.bankId : p.bank;
    if (bankId && (method === 'bank' || method === 'cheque')) {
      const bank = await Bank.findOne({ _id: requireId(bankId, 'bank'), isDeleted: { $ne: true } }).select('_id').lean();
      if (!bank) throw httpError('Bank account not found', 404);
      next.bank = bank._id;
    } else {
      next.bank = null;
    }
  }
  if (method === 'cheque' && !(next.reference ?? p.reference)) throw httpError('Please enter the cheque number');
  if (has('counter') || has('method')) {
    const c = method === 'cash' ? await counterFor(has('counter') ? body.counter : p.counter) : null;
    next.counter = c ? c._id : null;
    next.counterName = c ? c.name : '';
  }

  let remove = body.removeAttachments || [];
  if (typeof remove === 'string') {
    try {
      remove = JSON.parse(remove);
    } catch {
      remove = [remove];
    }
  }
  const kept = (p.attachments || []).filter((a) => !remove.includes(a));
  const attachments = [...kept, ...(newAttachments || []).filter(Boolean)];
  if (attachments.length > 10) throw httpError('Up to 10 photos per payment');
  if (attachments.length !== (p.attachments || []).length || kept.length !== (p.attachments || []).length) next.attachments = attachments;

  // What changed, old -> new, for the history.
  const fmt = (k, v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'amount') return `Rs ${Number(v).toLocaleString('en-PK')}`;
    if (k === 'method') return METHOD_LABELS[v] || v;
    if (k === 'date') return new Date(v).toISOString().slice(0, 10);
    return String(v);
  };
  const changes = [];
  for (const k of ['amount', 'method', 'reference', 'notes', 'date']) {
    if (next[k] === undefined) continue;
    const a = fmt(k, p[k]);
    const b = fmt(k, next[k]);
    if (a === b) delete next[k];
    else changes.push(`${k}: ${a} → ${b}`);
  }
  if (next.bank !== undefined) {
    if (String(next.bank || '') === String(p.bank || '')) delete next.bank;
    else changes.push('bank account changed');
  }
  if (next.counter !== undefined) {
    if (String(next.counter || '') === String(p.counter || '')) {
      delete next.counter;
      delete next.counterName;
    } else changes.push(`paid from: ${p.counterName || '—'} → ${next.counterName || '—'}`);
  }
  if (next.attachments) {
    const added = (newAttachments || []).length;
    const dropped = (p.attachments || []).length - kept.length;
    changes.push([added && `${added} photo${added === 1 ? '' : 's'} added`, dropped && `${dropped} photo${dropped === 1 ? '' : 's'} removed`].filter(Boolean).join(', '));
  }
  if (!changes.length) return getById(req, p._id);

  const reason = str(body.reason, 300);
  const userId = req.access.userId;
  const note = `${changes.join('; ')}${reason ? ` (why: ${reason})` : ''}`;
  await VendorPayment.updateOne({ _id: p._id, status: 'active' }, { $set: next, $push: { history: historyRow(userId, 'edited', note) } });

  // Keep the ledger row in step (it is what the balance adds up).
  const VendorLedgerEntry = require('../../models/vendorLedgerEntry');
  const set = {};
  if (next.amount !== undefined) set.debit = next.amount;
  if (next.date !== undefined) set.date = next.date;
  if (next.method !== undefined) set.method = next.method;
  if (next.bank !== undefined) set.bank = next.bank;
  if (next.reference !== undefined) set.reference = next.reference;
  if (next.attachments !== undefined) set.attachments = next.attachments;
  if (next.notes !== undefined && next.notes) set.description = str(next.notes, 300);
  if (Object.keys(set).length) {
    const q = p.ledgerEntry ? { _id: p.ledgerEntry } : { refType: 'VendorPayment', refId: p._id, isVoided: false };
    await VendorLedgerEntry.updateOne(q, { $set: set });
  }
  return getById(req, p._id);
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

module.exports = { METHOD_LABELS, recordPayment, create, list, getById, updatePayment, voidPayment, bankOptions };
