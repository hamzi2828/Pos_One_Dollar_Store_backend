// src/services/investmentService.js
// Investment = money put into the shop, one entry per bill, each put in by a
// partner. A bill has a total and can be paid in parts (each payment kept with
// its date); "invested" is what was actually paid, "balance" what is left.
// Simple list + totals, and each partner's total and share.
const mongoose = require('mongoose');
const Investment = require('../models/investment');
const Partner = require('../models/investmentPartner');
const T = require('./analytics/time');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `Rs ${round2(n).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f\d]{24}$/i.test(String(v));
const CHANGED = 'This bill was just changed. Refresh and try again.';

// Bills saved before part payments existed were paid in full: give each one
// payment for its amount (on the bill date). Runs once per server start; the
// payment reuses the bill's id (ids only need to be unique inside the bill).
let backfill = null;
function backfillOldBills() {
  if (!backfill) {
    backfill = Investment.updateMany(
      { paidAmount: { $exists: false } },
      [{
        $set: {
          paidAmount: '$amount',
          balance: 0,
          payments: [{ _id: '$_id', amount: '$amount', date: '$date', note: '', createdBy: '$createdBy', createdAt: '$createdAt' }],
        },
      }],
      { withDeleted: true, timestamps: false }
    ).exec().catch((err) => {
      backfill = null; // try again on the next request
      throw err;
    });
  }
  return backfill;
}

/** 'YYYY-MM-DD' (00:00 shop time) or any date string; empty = now. */
function parseDate(v) {
  const d = v ? (T.isDayKey(String(v)) ? T.dayStart(String(v)) : new Date(v)) : new Date();
  if (Number.isNaN(d.getTime())) throw httpError(400, 'Invalid date');
  return d;
}

/** A payment date: not after today (shop time). */
function paymentDate(v) {
  const d = parseDate(v);
  if (d >= T.dayStart(T.addDays(T.dayKey(new Date()), 1))) throw httpError(400, 'The payment date cannot be in the future');
  return d;
}

// ---------------------------------------------------------------- partners

/** Partners A-Z with what each has paid in, still has to pay, and their share. */
async function listPartners() {
  await backfillOldBills();
  const [partners, sums] = await Promise.all([
    Partner.find({}).sort({ name: 1 }).lean(),
    Investment.aggregate([{ $group: { _id: '$partner', paid: { $sum: '$paidAmount' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } }]),
  ]);
  const byId = new Map(sums.map((s) => [String(s._id), s]));
  const total = sums.reduce((t, s) => t + s.paid, 0);
  return partners.map((p) => {
    const s = byId.get(String(p._id)) || { paid: 0, balance: 0, count: 0 };
    return {
      ...p,
      invested: round2(s.paid),
      balance: round2(s.balance),
      bills: s.count,
      share: total > 0 ? Math.round((s.paid / total) * 1000) / 10 : 0, // % with 1 decimal
    };
  });
}

function cleanPartner(body = {}) {
  const name = str(body.name, 120).replace(/\s+/g, ' ');
  if (!name) throw httpError(400, "Write the partner's name");
  return { name, phone: str(body.phone, 40), note: str(body.note, 500) };
}

async function assertUniqueName(name, exceptId = null) {
  const f = { name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
  if (exceptId) f._id = { $ne: exceptId };
  if (await Partner.exists(f)) throw httpError(409, `A partner called "${name}" already exists`);
}

async function getPartner(id) {
  if (!isId(id)) throw httpError(400, 'Invalid partner');
  const p = await Partner.findById(id).lean();
  if (!p) throw httpError(404, 'Partner not found');
  return p;
}

async function createPartner(body, { userId }) {
  const data = cleanPartner(body);
  await assertUniqueName(data.name);
  const doc = await Partner.create({ ...data, createdBy: userId || null });
  return doc.toObject();
}

async function updatePartner(id, body, { userId }) {
  await getPartner(id);
  const data = cleanPartner(body);
  await assertUniqueName(data.name, id);
  return Partner.findByIdAndUpdate(id, { $set: { ...data, updatedBy: userId || null } }, { new: true }).lean();
}

/** Only a partner with no bills can be removed (their bills would lose their owner). */
async function removePartner(id, { userId }) {
  const p = await getPartner(id);
  const bills = await Investment.countDocuments({ partner: p._id });
  if (bills) {
    throw httpError(409, `${p.name} has ${bills} investment bill${bills === 1 ? '' : 's'}. Move or delete them first.`);
  }
  await Partner.softDeleteById(id, userId);
  return { id: String(id) };
}

// ---------------------------------------------------------------- investments

/** Validate + clean a create / update body. `partial` for updates. */
async function clean(body = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    out.title = str(body.title);
    if (!out.title) throw httpError(400, 'Write what the investment was for');
  }
  if (!partial || body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Bill total must be more than 0');
    out.amount = round2(amount);
  }
  if (!partial || body.date !== undefined) out.date = parseDate(body.date);
  if (!partial || body.partner !== undefined) {
    if (!body.partner) throw httpError(400, 'Pick the partner who put this money in');
    out.partner = (await getPartner(body.partner))._id;
  }
  for (const [k, max] of [['billNo', 80], ['paidTo', 120], ['note', 1000]]) {
    if (!partial || body[k] !== undefined) out[k] = str(body[k], max);
  }
  return out;
}

async function listFilter(query = {}) {
  const f = {};
  if (query.partner) {
    if (query.partner === 'none') f.partner = null;
    else if (isId(query.partner)) f.partner = new mongoose.Types.ObjectId(String(query.partner));
    else throw httpError(400, 'Invalid partner');
  }
  if (query.status === 'due') f.balance = { $gt: 0 };
  else if (query.status === 'paid') f.balance = { $lte: 0 };
  else if (query.status) throw httpError(400, 'Status must be due or paid');
  const range = {};
  if (query.from && T.isDayKey(String(query.from))) range.$gte = T.dayStart(String(query.from));
  if (query.to && T.isDayKey(String(query.to))) range.$lt = new Date(T.dayStart(String(query.to)).getTime() + T.DAY_MS);
  if (Object.keys(range).length) f.date = range;
  const q = str(query.search, 100);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    const partnerIds = await Partner.distinct('_id', { name: rx });
    f.$or = [{ title: rx }, { billNo: rx }, { paidTo: rx }, { note: rx }, { partner: { $in: partnerIds } }];
  }
  return f;
}

const PARTNER_FIELDS = 'name phone';

/** Payments oldest first (1st, 2nd, 3rd...), so the page can show the balance after each. */
function withSortedPayments(row) {
  if (!row) return row;
  const payments = [...(row.payments || [])].sort(
    (a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  return { ...row, payments };
}

const sumStage = { $group: { _id: null, amount: { $sum: '$amount' }, paid: { $sum: '$paidAmount' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } };

/** List (newest first) + totals for the current filter and overall, and the partners. */
async function list(query = {}) {
  await backfillOldBills();
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const filter = await listFilter(query);
  const monthStart = T.monthStart(T.monthKey(new Date()));
  const [rows, total, filtered, overall, due, noPartner, thisMonth, partners] = await Promise.all([
    Investment.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate({ path: 'partner', select: PARTNER_FIELDS, options: { withDeleted: true } }).lean(),
    Investment.countDocuments(filter),
    Investment.aggregate([{ $match: filter }, sumStage]),
    Investment.aggregate([{ $group: { ...sumStage.$group, first: { $min: '$date' } } }]),
    Investment.countDocuments({ balance: { $gt: 0 } }),
    Investment.aggregate([{ $match: { partner: null } }, sumStage]),
    // Money paid this month (by payment date, so later part payments count in their month).
    Investment.aggregate([
      { $match: { 'payments.date': { $gte: monthStart } } },
      { $unwind: '$payments' },
      { $match: { 'payments.date': { $gte: monthStart } } },
      { $group: { _id: null, amount: { $sum: '$payments.amount' } } },
    ]),
    listPartners(),
  ]);
  const all = overall[0] || { amount: 0, paid: 0, balance: 0, count: 0, first: null };
  const shown = filtered[0] || { amount: 0, paid: 0, balance: 0 };
  const orphan = noPartner[0] || { paid: 0, count: 0 };
  return {
    data: rows.map(withSortedPayments),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        // Money actually paid into the shop.
        totalInvested: round2(all.paid),
        billsTotal: round2(all.amount),
        balance: round2(all.balance),
        dueBills: due,
        entries: all.count,
        since: all.first,
        thisMonth: round2(thisMonth[0] ? thisMonth[0].amount : 0),
        filteredTotal: round2(shown.paid),
        filteredBillsTotal: round2(shown.amount),
        filteredBalance: round2(shown.balance),
        // Bills saved before partners existed: shown so they can be given one.
        noPartner: round2(orphan.paid),
        noPartnerBills: orphan.count,
      },
      partners,
    },
  };
}

async function get(id) {
  if (!isId(id)) throw httpError(400, 'Invalid id');
  await backfillOldBills();
  const row = await Investment.findById(id).populate({ path: 'partner', select: PARTNER_FIELDS, options: { withDeleted: true } }).lean();
  if (!row) throw httpError(404, 'Investment not found');
  return withSortedPayments(row);
}

/**
 * New bill. `paidAmount` = paid now (0 .. bill total); left out = paid in full.
 * What is paid now becomes the first payment, on the bill date.
 */
async function create(body, { userId, attachments = [] }) {
  const data = await clean(body);
  let paid = data.amount;
  if (body.paidAmount !== undefined && body.paidAmount !== null && body.paidAmount !== '') {
    paid = Number(body.paidAmount);
    if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'Paid now cannot be less than 0');
    paid = round2(paid);
    if (paid > data.amount) throw httpError(400, `Paid now (${rs(paid)}) is more than the bill total (${rs(data.amount)})`);
  }
  const payments = paid > 0 ? [{ amount: paid, date: data.date, createdBy: userId || null }] : [];
  const doc = await Investment.create({ ...data, payments, paidAmount: paid, attachments, createdBy: userId || null });
  return get(doc._id);
}

/**
 * Edit the bill. `paidAmount` (optional) = what is paid on it, for a bill with
 * at most one payment (the "paid now" from Add): that payment is changed,
 * added or removed. A bill paid in parts changes its payments one by one
 * (pay / edit / remove payment); then the total cannot go below what is paid.
 */
async function update(id, body, { userId, attachments = [] }) {
  const current = await get(id);
  const set = { ...(await clean(body, { partial: true })), updatedBy: userId || null };
  const total = set.amount !== undefined ? set.amount : current.amount;
  const billDate = set.date || current.date;
  let payments = null; // new payments list, when it changes
  let paid = current.paidAmount;

  if (body.paidAmount !== undefined && body.paidAmount !== null && body.paidAmount !== '') {
    const want = round2(Number(body.paidAmount));
    if (!Number.isFinite(want) || want < 0) throw httpError(400, 'Paid cannot be less than 0');
    if (want > total) throw httpError(400, `Paid (${rs(want)}) is more than the bill total (${rs(total)})`);
    if (want !== current.paidAmount) {
      const n = current.payments.length;
      if (n > 1) throw httpError(400, `This bill has ${n} payments. Change them in its payment history.`);
      const first = current.payments[0];
      payments = want > 0 ? [first ? { ...first, amount: want } : { amount: want, date: billDate, createdBy: userId || null }] : [];
      paid = want;
    }
  }
  if (total < paid) {
    throw httpError(400, `${rs(paid)} is already paid on this bill, so the total cannot be less. Remove or change a payment first.`);
  }
  // A lone payment made on the bill date moves with the bill date.
  if (set.date && current.payments.length === 1) {
    const p = (payments || current.payments)[0];
    if (p && new Date(current.payments[0].date).getTime() === new Date(current.date).getTime()) {
      payments = [{ ...p, date: set.date }];
    }
  }
  if (payments) {
    set.payments = payments;
    set.paidAmount = paid;
  }
  set.balance = round2(total - paid);
  // Keep the bills the user did not remove (`keepAttachments` = JSON array of urls).
  let keep = null;
  if (body.keepAttachments !== undefined) {
    try {
      keep = Array.isArray(body.keepAttachments) ? body.keepAttachments : JSON.parse(body.keepAttachments || '[]');
    } catch {
      throw httpError(400, 'keepAttachments must be a JSON list');
    }
  }
  const files = current.attachments || [];
  const kept = keep ? files.filter((u) => keep.includes(u)) : files;
  set.attachments = [...kept, ...attachments];
  // Only if no payment changed meanwhile (the balance is worked out from them).
  const res = await Investment.updateOne(
    { _id: current._id, paidAmount: current.paidAmount, payments: { $size: current.payments.length } },
    { $set: set }
  );
  if (!res.matchedCount) throw httpError(409, CHANGED);
  return get(id);
}

async function remove(id, { userId }) {
  await get(id);
  await Investment.softDeleteById(id, userId);
  return { id: String(id) };
}

// ---------------------------------------------------------------- payments

/** Pay part (or all) of what is left on a bill: { amount, date?, note? }. */
async function addPayment(id, body = {}, { userId }) {
  const bill = await get(id);
  if (bill.balance <= 0) throw httpError(409, 'This bill is already paid in full');
  const amount = round2(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Enter an amount more than 0');
  if (amount > bill.balance) throw httpError(400, `Only ${rs(bill.balance)} is left to pay on this bill`);
  const date = paymentDate(body.date);
  const paidAmount = round2(bill.paidAmount + amount);
  const res = await Investment.updateOne(
    { _id: bill._id, amount: bill.amount, paidAmount: bill.paidAmount },
    {
      $push: { payments: { amount, date, note: str(body.note, 300), createdBy: userId || null } },
      $set: { paidAmount, balance: round2(bill.amount - paidAmount), updatedBy: userId || null },
    }
  );
  if (!res.modifiedCount) throw httpError(409, CHANGED);
  return get(id);
}

/** Fix a payment: { amount?, date?, note? }. Paid can never go above the bill total. */
async function editPayment(id, paymentId, body = {}, { userId }) {
  const bill = await get(id);
  const payment = isId(paymentId) && bill.payments.find((p) => String(p._id) === String(paymentId));
  if (!payment) throw httpError(404, 'Payment not found');
  const set = { updatedBy: userId || null };
  let paidAmount = bill.paidAmount;
  if (body.amount !== undefined) {
    const amount = round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Enter an amount more than 0');
    paidAmount = round2(bill.paidAmount - payment.amount + amount);
    if (paidAmount > bill.amount) {
      throw httpError(400, `That makes ${rs(paidAmount)} paid on a ${rs(bill.amount)} bill. At most ${rs(bill.amount - bill.paidAmount + payment.amount)} for this payment.`);
    }
    set['payments.$.amount'] = amount;
    set.paidAmount = paidAmount;
    set.balance = round2(bill.amount - paidAmount);
  }
  if (body.date !== undefined) set['payments.$.date'] = paymentDate(body.date);
  if (body.note !== undefined) set['payments.$.note'] = str(body.note, 300);
  const res = await Investment.updateOne(
    { _id: bill._id, amount: bill.amount, paidAmount: bill.paidAmount, 'payments._id': payment._id },
    { $set: set }
  );
  if (!res.matchedCount) throw httpError(409, CHANGED);
  return get(id);
}

/** Undo a payment saved by mistake: the balance goes back up. */
async function removePayment(id, paymentId, { userId }) {
  const bill = await get(id);
  const payment = isId(paymentId) && bill.payments.find((p) => String(p._id) === String(paymentId));
  if (!payment) throw httpError(404, 'Payment not found');
  const paidAmount = round2(bill.paidAmount - payment.amount);
  const res = await Investment.updateOne(
    { _id: bill._id, amount: bill.amount, paidAmount: bill.paidAmount, 'payments._id': payment._id },
    {
      $pull: { payments: { _id: payment._id } },
      $set: { paidAmount, balance: round2(bill.amount - paidAmount), updatedBy: userId || null },
    }
  );
  if (!res.modifiedCount) throw httpError(409, CHANGED);
  return get(id);
}

// ---------------------------------------------------------------- export

function toCsv(rows) {
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Date', 'What', 'Partner', 'Bill total (Rs)', 'Paid (Rs)', 'Balance (Rs)', 'Payments', 'Bill no', 'Paid to', 'Note'];
  const lines = [head.map(esc).join(',')];
  for (const r of rows.map(withSortedPayments)) {
    const payments = r.payments.map((p) => `${T.dayKey(p.date)}: ${round2(p.amount)}${p.note ? ` (${p.note})` : ''}`).join('; ');
    lines.push([
      T.dayKey(r.date), r.title, r.partner ? r.partner.name : '', r.amount, r.paidAmount, r.balance, payments, r.billNo, r.paidTo, r.note,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

async function exportCsv(query = {}) {
  await backfillOldBills();
  const rows = await Investment.find(await listFilter(query)).sort({ date: -1 })
    .populate({ path: 'partner', select: 'name', options: { withDeleted: true } }).lean();
  return toCsv(rows);
}

module.exports = {
  list, get, create, update, remove, exportCsv,
  addPayment, editPayment, removePayment,
  listPartners, createPartner, updatePartner, removePartner,
};
