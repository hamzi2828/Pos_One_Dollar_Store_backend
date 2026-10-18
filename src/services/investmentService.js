// src/services/investmentService.js
// Investment = money put into the shop, one entry per bill. Simple list + total.
const mongoose = require('mongoose');
const Investment = require('../models/investment');
const T = require('./analytics/time');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Suggestions for the category box (the shop can type anything).
const SUGGESTED_CATEGORIES = [
  'Renovation',
  'Racks & fixtures',
  'Equipment',
  'Electronics & IT',
  'Signboard & branding',
  'Opening stock',
  'Rent advance / security',
  'Furniture',
  'Licences & fees',
  'Other',
];

/** Validate + clean a create / update body. `partial` for updates. */
function clean(body = {}, { partial = false } = {}) {
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
  for (const [k, max] of [['category', 80], ['billNo', 80], ['paidTo', 120], ['note', 1000]]) {
    if (!partial || body[k] !== undefined) out[k] = str(body[k], max);
  }
  return out;
}

function listFilter(query = {}) {
  const f = {};
  if (query.category) f.category = String(query.category);
  const range = {};
  if (query.from && T.isDayKey(String(query.from))) range.$gte = T.dayStart(String(query.from));
  if (query.to && T.isDayKey(String(query.to))) range.$lt = new Date(T.dayStart(String(query.to)).getTime() + T.DAY_MS);
  if (Object.keys(range).length) f.date = range;
  const q = str(query.search, 100);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    f.$or = [{ title: rx }, { billNo: rx }, { paidTo: rx }, { category: rx }, { note: rx }];
  }
  return f;
}

/** List (newest first) + totals for the current filter and overall. */
async function list(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const filter = listFilter(query);
  const monthStart = T.monthStart(T.monthKey(new Date()));
  const [rows, total, filtered, overall, byCategory, thisMonth] = await Promise.all([
    Investment.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Investment.countDocuments(filter),
    Investment.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
    Investment.aggregate([{ $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 }, first: { $min: '$date' } } }]),
    Investment.aggregate([
      { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Investment.aggregate([{ $match: { date: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
  ]);
  const all = overall[0] || { amount: 0, count: 0, first: null };
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
        byCategory: byCategory.map((c) => ({ category: c._id || 'Uncategorised', amount: round2(c.amount), count: c.count })),
      },
      categories: [...new Set([...SUGGESTED_CATEGORIES, ...byCategory.map((c) => c._id).filter(Boolean)])],
    },
  };
}

async function get(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw httpError(400, 'Invalid id');
  const row = await Investment.findById(id).lean();
  if (!row) throw httpError(404, 'Investment not found');
  return row;
}

async function create(body, { userId, attachments = [] }) {
  const doc = await Investment.create({ ...clean(body), attachments, createdBy: userId || null });
  return doc.toObject();
}

async function update(id, body, { userId, attachments = [] }) {
  await get(id);
  const set = { ...clean(body, { partial: true }), updatedBy: userId || null };
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
  return Investment.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
}

async function remove(id, { userId }) {
  await get(id);
  await Investment.softDeleteById(id, userId);
  return { id: String(id) };
}

function toCsv(rows) {
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Date', 'What', 'Category', 'Amount (Rs)', 'Bill no', 'Paid to', 'Note'].map(esc).join(',')];
  for (const r of rows) {
    lines.push([T.dayKey(r.date), r.title, r.category, r.amount, r.billNo, r.paidTo, r.note].map(esc).join(','));
  }
  return lines.join('\n');
}

async function exportCsv(query = {}) {
  const rows = await Investment.find(listFilter(query)).sort({ date: -1 }).lean();
  return toCsv(rows);
}

module.exports = { list, get, create, update, remove, exportCsv, SUGGESTED_CATEGORIES };
