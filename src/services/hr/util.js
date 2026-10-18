// Small helpers shared by the HR & Assets services (employees, contracts, assets).
const mongoose = require('mongoose');
const Branch = require('../../models/branch');
const { resolveWriteBranch } = require('../../middleware/access');
const { escapeRegex } = require('../../helper/paginate');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const idStr = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/** Trimmed string or null ('' -> null). */
const str = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Date from 'YYYY-MM-DD' / ISO / Date. '' or null -> null. Bad value -> 400. */
const date = (v, label = 'date') => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `Invalid ${label}`);
  return d;
};

/** Number >= 0 (or null when empty). Bad value -> 400. */
const money = (v, label = 'amount', { allowNull = true } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (allowNull) return null;
    throw httpError(400, `${label} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${label} must be a number of 0 or more`);
  return round2(n);
};

const CNIC_RE = /^\d{5}-\d{7}-\d$/;
/** "3520212345671" or "35202-1234567-1" -> "35202-1234567-1"; '' -> null; bad -> 400. */
const cnic = (v, label = 'CNIC') => {
  const s = str(v, 30);
  if (!s) return null;
  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digits)) return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  throw httpError(400, `${label} must look like 12345-1234567-1 (13 digits)`, 'INVALID_CNIC');
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = (v, label = 'time') => {
  const s = str(v, 5);
  if (!s) return null;
  if (!TIME_RE.test(s)) throw httpError(400, `${label} must be HH:mm (24 hours), e.g. 09:30`);
  return s;
};

/** Case-insensitive "contains" regex for a search term. */
const containsRe = (term) => new RegExp(escapeRegex(String(term).trim()), 'i');

let mainCache = { at: 0, id: null };
async function mainBranchId() {
  if (Date.now() - mainCache.at < 10 * 1000 && mainCache.id) return mainCache.id;
  const main = await Branch.findOne({ isMain: true }).select('_id').lean();
  mainCache = { at: Date.now(), id: main ? String(main._id) : null };
  return mainCache.id;
}

/** The shop's branch id, stamped on new employees / assets. */
const shopBranch = (req) => resolveWriteBranch(req);

/** ?page=&limit= -> { page, limit, skip } (limit 1..200, default 25). */
function paging(query, defLimit = 25) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}
const pageMeta = ({ page, limit }, total) => ({ page, limit, total, pages: total ? Math.ceil(total / limit) : 0 });

/** ?sort=name / -joiningDate restricted to `allowed` ({ apiName: dbField }). */
function sortOf(raw, allowed, fallback) {
  const s = String(raw || '').trim();
  const desc = s.startsWith('-');
  const key = desc ? s.slice(1) : s;
  if (!allowed[key]) return fallback;
  return { [allowed[key]]: desc ? -1 : 1, _id: desc ? -1 : 1 };
}

const userName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '' : '');

/** One CSV cell: quoted, and protected against spreadsheet formula injection. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

module.exports = {
  httpError,
  round2,
  isId,
  idStr,
  str,
  date,
  money,
  cnic,
  CNIC_RE,
  time,
  containsRe,
  mainBranchId,
  shopBranch,
  paging,
  pageMeta,
  sortOf,
  userName,
  toCsv,
};
