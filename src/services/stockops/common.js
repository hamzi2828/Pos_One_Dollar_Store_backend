// src/services/stockops/common.js
// Small helpers shared by the stock-operations services (damages, shop use,
// adjustments, movement ledger, product insights).
const mongoose = require('mongoose');
const Product = require('../../models/product');
const { variantLabel, getMainBranchId, unitBranchStock } = require('../../helper/productCodes');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** Error with an HTTP status (handled by routes/modules/_access.js `handle`). */
const httpError = (message, status = 400, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const isHexId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);
const toObjectId = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const raw = typeof v === 'object' && v._id ? String(v._id) : String(v);
  return isHexId(raw) ? new mongoose.Types.ObjectId(raw) : null;
};

const toInt = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Pakistan time (UTC+5, no daylight saving) ----------
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-10-18" for the PKT calendar day of `date` (default now). */
const pktDateString = (date = new Date()) => new Date(new Date(date).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);

/** { start, end, date } of one PKT day; bad/missing input = today. */
const pktDayRange = (dateStr) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : pktDateString();
  const start = new Date(`${day}T00:00:00+05:00`);
  if (Number.isNaN(start.getTime())) return pktDayRange(null);
  return { date: day, start, end: new Date(start.getTime() + DAY_MS) };
};

/** Range filter from ?from=YYYY-MM-DD&to=YYYY-MM-DD (PKT days, `to` inclusive). */
const pktRangeFilter = (from, to) => {
  const out = {};
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) out.$gte = pktDayRange(from).start;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) out.$lt = pktDayRange(to).end;
  return Object.keys(out).length ? out : null;
};

const daysBetween = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / DAY_MS) * 10) / 10 : null);

// ---------- paging ----------
const pageParams = (query = {}, { defaultLimit = 25, maxLimit = 200 } = {}) => {
  const page = Math.max(1, toInt(query.page, 1) || 1);
  const limit = Math.min(maxLimit, Math.max(1, toInt(query.limit, defaultLimit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};
const pageMeta = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

// ---------- CSV ----------
const csvCell = (v) => {
  if (v === undefined || v === null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV text from header labels + rows (arrays). BOM so Excel reads UTF-8. */
const toCsv = (headers, rows) => '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
};

/** "Rs 1,234" style date+time for CSV cells, in PKT. */
const pktDateTime = (d) => (d ? new Date(new Date(d).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '');

// ---------- products / units ----------
const loadProductLean = async (productId, select) => {
  const id = toObjectId(productId);
  if (!id) throw httpError('Invalid product id', 400);
  let q = Product.findById(id).setOptions({ withDeleted: true });
  if (select) q = q.select(select);
  const p = await q.lean();
  if (!p) throw httpError('Product not found', 404);
  return p;
};

/**
 * The unit (product or one variant) of a plain product.
 * Returns { unit, variant, variantId (null for single products) } or throws 400/404.
 */
const pickUnit = (product, variantId, { required = true } = {}) => {
  if (product.productType === 'variant') {
    const vs = product.variants || [];
    let v = null;
    if (variantId) v = vs.find((x) => String(x.variantId) === String(variantId) || String(x._id) === String(variantId)) || null;
    else if (vs.length === 1) v = vs[0];
    if (!v) {
      if (!required) return null;
      throw httpError(variantId ? `Variant not found on ${product.name}` : `Choose a variant of ${product.name}`, variantId ? 404 : 400);
    }
    return { unit: v, variant: v, variantId: String(v.variantId) };
  }
  return { unit: product, variant: null, variantId: null };
};

/** Snapshot of a unit for documents (name, label, code, costs, vendor). */
const unitSnapshot = (product, picked) => {
  const { unit, variant } = picked;
  const num = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    product: product._id,
    variantId: picked.variantId,
    productName: product.name || '',
    variantLabel: variant ? variantLabel(variant) : '',
    category: product.category || '',
    code: (unit.shortCode || unit.sku || product.shortCode || product.sku || '').toString(),
    unitCost: num(unit.costPrice) ?? num(product.costPrice) ?? 0,
    salePrice: num(unit.price) ?? num(product.price) ?? 0,
    vendor: unit.lastVendor || product.lastVendor || null,
    vendorName: unit.lastVendorName || product.lastVendorName || '',
  };
};

/** Pieces of a unit in a branch. */
const unitAvailable = async (unit, branchId) => {
  const main = await getMainBranchId();
  return Math.max(0, Number(unitBranchStock(unit, branchId, main)) || 0);
};

const userName = (u) => (u && typeof u === 'object' ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '' : '');

/** Mongo filter for "branch X" that also matches old rows without a branch when X is the main branch. */
const branchMatch = async (branchId, field = 'branch') => {
  if (!branchId) return {};
  const id = toObjectId(branchId);
  const main = await getMainBranchId();
  if (main && String(main) === String(id)) return { $or: [{ [field]: id }, { [field]: null }] };
  return { [field]: id };
};

const historyEntry = (action, userId, note = '') => ({ at: new Date(), by: toObjectId(userId), action, note: note ? String(note) : '' });

// A claim on a document older than this is considered abandoned (crashed request).
const STALE_LOCK_MS = 2 * 60 * 1000;

module.exports = {
  round2,
  round4,
  httpError,
  isHexId,
  toObjectId,
  toInt,
  escapeRegex,
  PKT_OFFSET_MS,
  DAY_MS,
  pktDateString,
  pktDayRange,
  pktRangeFilter,
  pktDateTime,
  daysBetween,
  pageParams,
  pageMeta,
  toCsv,
  sendCsv,
  loadProductLean,
  pickUnit,
  unitSnapshot,
  unitAvailable,
  userName,
  branchMatch,
  historyEntry,
  STALE_LOCK_MS,
};
