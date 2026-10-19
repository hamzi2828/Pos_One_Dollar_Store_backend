// src/services/investmentService.js
// Investment = money put into the shop, one entry per bill, each put in by a
// partner. Simple list + total, and each partner's total and share.
const mongoose = require('mongoose');
const Investment = require('../models/investment');
const Partner = require('../models/investmentPartner');
const T = require('./analytics/time');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f\d]{24}$/i.test(String(v));

// ---------------------------------------------------------------- partners

/** Partners A-Z with what each has put in and their share of the total. */
async function listPartners() {
  const [partners, sums] = await Promise.all([
    Partner.find({}).sort({ name: 1 }).lean(),
    Investment.aggregate([{ $group: { _id: '$partner', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  const byId = new Map(sums.map((s) => [String(s._id), s]));
  const total = sums.reduce((t, s) => t + s.amount, 0);
  return partners.map((p) => {
    const s = byId.get(String(p._id)) || { amount: 0, count: 0 };
    return {
      ...p,
      invested: round2(s.amount),
      bills: s.count,
      share: total > 0 ? Math.round((s.amount / total) * 1000) / 10 : 0, // % with 1 decimal
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
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Amount must be more than 0');
    out.amount = round2(amount);
  }
  if (!partial || body.date !== undefined) {
    const d = body.date ? (T.isDayKey(String(body.date)) ? T.dayStart(String(body.date)) : new Date(body.date)) : new Date();
    if (Number.isNaN(d.getTime())) throw httpError(400, 'Invalid date');
    out.date = d;
  }
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

/** List (newest first) + totals for the current filter and overall, and the partners. */
async function list(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const filter = await listFilter(query);
  const monthStart = T.monthStart(T.monthKey(new Date()));
  const [rows, total, filtered, overall, thisMonth, partners] = await Promise.all([
    Investment.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate({ path: 'partner', select: PARTNER_FIELDS, options: { withDeleted: true } }).lean(),
    Investment.countDocuments(filter),
    Investment.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
    Investment.aggregate([{ $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 }, first: { $min: '$date' } } }]),
    Investment.aggregate([{ $match: { date: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
    listPartners(),
  ]);
  const all = overall[0] || { amount: 0, count: 0, first: null };
  const assigned = partners.reduce((t, p) => t + p.invested, 0);
  return {
    data: rows,
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        totalInvested: round2(all.amount),
        entries: all.count,
        since: all.first,
        thisMonth: round2(thisMonth[0] ? thisMonth[0].amount : 0),
        filteredTotal: round2(filtered[0] ? filtered[0].amount : 0),
        // Bills saved before partners existed: shown so they can be given one.
        noPartner: round2(all.amount - assigned),
      },
      partners,
    },
  };
}

async function get(id) {
  if (!isId(id)) throw httpError(400, 'Invalid id');
  const row = await Investment.findById(id).populate({ path: 'partner', select: PARTNER_FIELDS, options: { withDeleted: true } }).lean();
  if (!row) throw httpError(404, 'Investment not found');
  return row;
}

async function create(body, { userId, attachments = [] }) {
  const doc = await Investment.create({ ...(await clean(body)), attachments, createdBy: userId || null });
  return get(doc._id);
}

async function update(id, body, { userId, attachments = [] }) {
  await get(id);
  const set = { ...(await clean(body, { partial: true })), updatedBy: userId || null };
  // Keep the bills the user did not remove (`keepAttachments` = JSON array of urls).
  let keep = null;
  if (body.keepAttachments !== undefined) {
    try {
      keep = Array.isArray(body.keepAttachments) ? body.keepAttachments : JSON.parse(body.keepAttachments || '[]');
    } catch {
      throw httpError(400, 'keepAttachments must be a JSON list');
    }
  }
  const current = await Investment.findById(id).select('attachments').lean();
  const kept = keep ? (current.attachments || []).filter((u) => keep.includes(u)) : current.attachments || [];
  set.attachments = [...kept, ...attachments];
  await Investment.updateOne({ _id: id }, { $set: set });
  return get(id);
}

async function remove(id, { userId }) {
  await get(id);
  await Investment.softDeleteById(id, userId);
  return { id: String(id) };
}

function toCsv(rows) {
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Date', 'What', 'Partner', 'Amount (Rs)', 'Bill no', 'Paid to', 'Note'].map(esc).join(',')];
  for (const r of rows) {
    lines.push([T.dayKey(r.date), r.title, r.partner ? r.partner.name : '', r.amount, r.billNo, r.paidTo, r.note].map(esc).join(','));
  }
  return lines.join('\n');
}

async function exportCsv(query = {}) {
  const rows = await Investment.find(await listFilter(query)).sort({ date: -1 })
    .populate({ path: 'partner', select: 'name', options: { withDeleted: true } }).lean();
  return toCsv(rows);
}

module.exports = {
  list, get, create, update, remove, exportCsv,
  listPartners, createPartner, updatePartner, removePartner,
};
