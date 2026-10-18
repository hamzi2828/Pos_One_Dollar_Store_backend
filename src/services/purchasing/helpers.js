// src/services/purchasing/helpers.js
// Small shared helpers for purchase orders and goods receiving.
const mongoose = require('mongoose');
const { round2, round4 } = require('../inventory/costingService');
const { parseMaybeJSON } = require('../../helper/productCodes');

const LOCK_MS = 2 * 60 * 1000; // a lock older than this is treated as abandoned

const httpError = (message, status = 400, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const toId = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : null);
const sameId = (a, b) => !!a && !!b && String(a._id || a) === String(b._id || b);

const has = (v) => v !== undefined && v !== null && v !== '';

/** Number >= 0 or throw 400. `int` for piece counts. Empty -> fallback. */
const toAmount = (value, label, { int = false, fallback = 0, min = 0 } = {}) => {
  if (!has(value)) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw httpError(`${label} must be a number of at least ${min}`);
  if (int && !Number.isInteger(n)) throw httpError(`${label} must be a whole number`);
  return int ? n : round2(n);
};

/** Price per piece (4 decimals, e.g. 1000 / 12 = 83.3333). */
const toPrice = (value, label, fallback = 0) => {
  if (!has(value)) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw httpError(`${label} must be a number of at least 0`);
  return round4(n);
};

const toDate = (value, label) => {
  if (!has(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(`${label} is not a valid date`);
  return d;
};

const toText = (value, max = 500) => (has(value) ? String(value).trim().slice(0, max) : '');

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
};

/** Array from a JSON string (multipart) or an array. */
const toList = (value) => {
  const v = parseMaybeJSON(value);
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
};

const userName = (req) => {
  const u = req.user || {};
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || u.email || 'Staff';
};

const userId = (req) => toId((req.access && req.access.userId) || (req.user && (req.user._id || req.user.id)));

const historyEntry = (req, action, note = '') => ({ at: new Date(), by: userId(req), byName: userName(req), action, note });

const pageParams = (query = {}, { maxLimit = 100, defLimit = 25 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const pageMeta = (page, limit, total, extra = {}) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), ...extra });

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Date range filter { $gte, $lte } from ?from=&to= (to = end of that day). */
const dateRange = (from, to) => {
  const range = {};
  const f = toDate(from, 'from');
  const t = toDate(to, 'to');
  if (f) range.$gte = f;
  if (t) {
    t.setHours(23, 59, 59, 999);
    range.$lte = t;
  }
  return Object.keys(range).length ? range : null;
};

/**
 * Take a short lock on a workflow document (close / cancel / complete) so two
 * clicks or two people cannot post the ledger or stock twice at the same time.
 * Returns the locked document or null when someone else holds the lock.
 */
async function acquireLock(Model, id, filter = {}) {
  const now = new Date();
  return Model.findOneAndUpdate(
    { _id: id, ...filter, $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - LOCK_MS) } }] },
    { $set: { lockedAt: now }, $inc: { __v: 1 } },
    { new: true }
  );
}

const releaseLock = (Model, id) => Model.updateOne({ _id: id }, { $set: { lockedAt: null } }).catch(() => {});

const isLocked = (doc) => !!doc.lockedAt && Date.now() - new Date(doc.lockedAt).getTime() < LOCK_MS;

/** Turn Mongoose concurrency / validation errors into friendly 409 / 400 errors. */
const friendlyDbError = (err) => {
  if (err && err.name === 'VersionError') {
    return httpError('Someone else changed this document at the same time. Reload and try again.', 409, 'CONFLICT');
  }
  if (err && err.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return httpError(first ? first.message : err.message, 400);
  }
  return err;
};

module.exports = {
  LOCK_MS,
  round2,
  round4,
  httpError,
  isId,
  toId,
  sameId,
  has,
  toAmount,
  toPrice,
  toDate,
  toText,
  toBool,
  toList,
  userName,
  userId,
  historyEntry,
  pageParams,
  pageMeta,
  escapeRegex,
  dateRange,
  acquireLock,
  releaseLock,
  isLocked,
  friendlyDbError,
};
