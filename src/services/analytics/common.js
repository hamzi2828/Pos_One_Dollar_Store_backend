// src/services/analytics/common.js
// Small helpers shared by the report services (report scope, sale filters,
// numbers, pagination, names).
const mongoose = require('mongoose');
const Branch = require('../../models/branch');
const { getMainBranchId } = require('../../helper/productCodes');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// Whole pieces needed for a quantity (ignores float noise: 20.000000000000004 -> 20).
const ceilQty = (n) => Math.max(0, Math.ceil((Number(n) || 0) - 1e-9));
const pct = (part, whole) => (Number(whole) > 0 ? round1((Number(part) / Number(whole)) * 100) : null);

const httpError = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

const isId = (v) => !!v && /^[0-9a-fA-F]{24}$/.test(String(v));
const toId = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : null);
const idStr = (v) => (v === undefined || v === null ? '' : String(v));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ?page&limit -> { page, limit, skip } (limit capped). */
function pageParams(query = {}, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(maxLimit, limit);
  return { page, limit, skip: (page - 1) * limit };
}

const pageMeta = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

/** Number from the query within [min, max], else the fallback. */
function numParam(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(`Value "${value}" must be between ${min} and ${max}`);
  return n;
}

/**
 * Scope of a report. One shop: every record counts (old rows without a branch
 * belong to the shop), so there is no branch condition:
 *   scope.branchId     null (no branch filter); mainBranchId = the shop
 *   salesMatch         filter for POSOrder / Expense / FootfallEntry
 *   stockMatch         filter for StockMovement / LocationStock
 */
async function reportScope() {
  const mainBranchId = await getMainBranchId();
  return {
    allBranches: true,
    branchId: null,
    mainBranchId,
    isMain: false,
    salesMatch: {},
    stockMatch: {},
    mainBranchOid: toId(mainBranchId),
  };
}

// Bills that count as sales: not deleted, not refunded / cancelled.
const SALE_MATCH = {
  isDeleted: { $ne: true },
  orderStatus: { $nin: ['refunded', 'cancelled'] },
  paymentStatus: { $ne: 'refunded' },
};

// Item lines that are products (skips odd old lines saved without one).
const PRODUCT_LINE_MATCH = { 'items.product': { $ne: null } };

/** Map id -> { id, name, code } for branch ids found on rows (deleted ones included). */
async function branchNames(ids) {
  const list = [...new Set(ids.filter(isId).map(String))];
  if (!list.length) return new Map();
  const rows = await Branch.find({ _id: { $in: list.map(toId) } }).setOptions({ withDeleted: true }).select('name code').lean();
  return new Map(rows.map((b) => [String(b._id), { id: String(b._id), name: b.name || 'Shop', code: b.code || '' }]));
}

/** Map id -> name for any model with a `name` (vendors, ...). Deleted rows included. */
async function namesById(Model, ids, field = 'name') {
  const list = [...new Set(ids.filter(isId).map(String))];
  if (!list.length) return new Map();
  let q = Model.find({ _id: { $in: list.map(toId) } }).select(field);
  if (typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  const rows = await q.lean();
  return new Map(rows.map((r) => [String(r._id), r[field]]));
}

/** Run async `fn` over items with at most `limit` running at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

module.exports = {
  round2,
  round1,
  ceilQty,
  pct,
  httpError,
  isId,
  toId,
  idStr,
  escapeRegex,
  pageParams,
  pageMeta,
  numParam,
  reportScope,
  SALE_MATCH,
  PRODUCT_LINE_MATCH,
  branchNames,
  namesById,
  mapLimit,
  chunk,
};
