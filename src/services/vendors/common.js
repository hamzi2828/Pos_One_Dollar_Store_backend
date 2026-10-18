// src/services/vendors/common.js
// Small helpers shared by the Vendors module services (vendors, payments,
// returns, consignment): errors, ids, money rounding, Pakistan dates,
// pagination, branch checks, product unit lookup and CSV.
const mongoose = require('mongoose');
const { branchFilter } = require('../../middleware/access');
const { pickUnit } = require('../stockService');
const { variantLabel } = require('../../helper/productCodes');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** Error with an HTTP status (routes/modules/_access.js `handle` turns it into JSON). */
const httpError = (message, status = 400, code, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
};

const isId = (v) => !!v && /^[0-9a-fA-F]{24}$/.test(String(v && v._id ? v._id : v));
const oid = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v && v._id ? v._id : v)) : null);
const requireId = (v, label = 'id') => {
  const id = oid(v);
  if (!id) throw httpError(`Invalid ${label}`, 400, 'INVALID_ID');
  return id;
};
const sameId = (a, b) => !!a && !!b && String(a._id || a) === String(b._id || b);

/** Trimmed string, cut to `max` characters. */
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

/** Whole positive pieces or throws. */
const pieces = (v, label = 'Quantity') => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) throw httpError(`${label} must be a whole number of at least 1`);
  return n;
};

/** Money >= 0 (or > 0 when `positive`) or throws. */
const money = (v, label = 'Amount', { positive = false } = {}) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || (positive && n <= 0)) {
    throw httpError(`${label} must be ${positive ? 'greater than 0' : '0 or more'}`);
  }
  if (n > 1e10) throw httpError(`${label} is too large`);
  return round2(n);
};

const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

// ---------- Dates: the shop works in Pakistan time (UTC+5, no DST) ----------
const PK_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RX = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-18" -> Date of 00:00 that day in Pakistan. Full ISO strings are kept. */
const dayStart = (v) => {
  if (!v) return null;
  const m = DAY_RX.exec(String(v).trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - PK_OFFSET_MS);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(`Invalid date "${v}"`);
  return d;
};
/** "2026-10-18" -> last millisecond of that day in Pakistan. */
const dayEnd = (v) => {
  if (!v) return null;
  if (DAY_RX.test(String(v).trim())) return new Date(dayStart(v).getTime() + DAY_MS - 1);
  return dayStart(v);
};
/** Today's date in Pakistan as "YYYY-MM-DD". */
const pkToday = (now = new Date()) => new Date(now.getTime() + PK_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Date of a document (payment date, return date...). Empty / today -> now;
 * another day -> noon of that day (Pakistan). Future days are refused.
 */
const docDate = (v, now = new Date()) => {
  if (!v) return now;
  const s = String(v).trim();
  if (DAY_RX.test(s)) {
    if (s === pkToday(now)) return now;
    if (s > pkToday(now)) throw httpError('The date cannot be in the future');
    return new Date(dayStart(s).getTime() + DAY_MS / 2);
  }
  const d = dayStart(s);
  if (d.getTime() > now.getTime() + 5 * 60 * 1000) throw httpError('The date cannot be in the future');
  return d;
};

/** { $gte, $lte } for ?from=&to= (either may be empty) or null. */
const dateRange = (from, to) => {
  const range = {};
  if (from) range.$gte = dayStart(from);
  if (to) range.$lte = dayEnd(to);
  return Object.keys(range).length ? range : null;
};

// ---------- Lists ----------
const pageParams = (q = {}, { defaultLimit = 25, maxLimit = 200 } = {}) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(q.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};
const pageMeta = (page, limit, total, extra = {}) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), ...extra });

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchRx = (s) => (str(s, 100) ? new RegExp(escapeRx(str(s, 100)), 'i') : null);

// ---------- Scope (one shop: every document) ----------
/** Mongo filter for lists (middleware/access.js branchFilter). */
const scope = (req, field = 'branch') => branchFilter(req, field);

/** 404 when a document is outside the request's scope (branchFilter). */
const assertInScope = (req, doc, label = 'Document') => {
  const f = branchFilter(req);
  if (f.branch && !sameId(f.branch, doc.branch)) throw httpError(`${label} not found`, 404);
};

// ---------- Products ----------
/**
 * The unit (product or one variant) a line means:
 * { unit, variantId (string|null — the variant's variantId), label, code, name }.
 */
const unitOf = (product, variantId) => {
  let picked;
  try {
    picked = pickUnit(product, variantId || null);
  } catch (e) {
    throw httpError(e.message, e.status || 400);
  }
  const variant = picked.variant;
  return {
    unit: picked.unit,
    variant,
    variantId: variant ? String(variant.variantId) : null,
    label: variant ? variantLabel(variant) : '',
    code: (picked.unit && (picked.unit.shortCode || picked.unit.sku)) || product.shortCode || product.sku || '',
    name: product.name,
  };
};

// ---------- People ----------
/** Map userId -> "First Last" for a list of ids. */
async function userNames(ids) {
  const User = require('../../models/user');
  const list = [...new Set(ids.filter(Boolean).map(String))].filter(isId);
  if (!list.length) return new Map();
  const users = await User.find({ _id: { $in: list } }).select('firstName lastName email').lean();
  return new Map(users.map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '']));
}

/** Map branchId -> { name, code } for a list of ids. */
async function branchNames(ids) {
  const Branch = require('../../models/branch');
  const list = [...new Set(ids.filter(Boolean).map(String))].filter(isId);
  if (!list.length) return new Map();
  let q = Branch.find({ _id: { $in: list } });
  if (typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  const rows = await q.select('name code').lean();
  return new Map(rows.map((b) => [String(b._id), { name: b.name, code: b.code }]));
}

// ---------- CSV ----------
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** columns: [{ key | value(row), label }] -> CSV text with a BOM (opens in Excel). */
const toCsv = (rows, columns) => {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value ? c.value(r) : r[c.key])).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
};

const historyRow = (userId, action, note = '') => ({ at: new Date(), by: oid(userId), action, note: str(note, 500) });

module.exports = {
  round2,
  round4,
  httpError,
  isId,
  oid,
  requireId,
  sameId,
  str,
  pieces,
  money,
  bool,
  PK_OFFSET_MS,
  dayStart,
  dayEnd,
  pkToday,
  docDate,
  dateRange,
  pageParams,
  pageMeta,
  escapeRx,
  searchRx,
  scope,
  assertInScope,
  unitOf,
  userNames,
  branchNames,
  toCsv,
  historyRow,
};
