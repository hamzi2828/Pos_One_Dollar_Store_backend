// src/middleware/purchasingLogger.js
// Records every non-GET request of the Purchasing & Vendors area into
// PurchasingLog (success and failure). Mounted once at /api in
// routes/modules/index.js, before the module routers.
//
// - Matching + plain-English text: services/purchasingLog/routes.js
// - For edits a small "before" snapshot is read first, so the row can show
//   before → after. The row itself is written after the answer is sent.
// - Logging never breaks a request: every step is in try/catch.
// - A handler may add detail with res.locals.purchasingLog = { summary, refs, changes }.
const { match, isId } = require('../services/purchasingLog/routes');

const SECRET_KEY = /pass|token|ticket|secret|authorization|otp|pin$/i;
const MAX_REQUEST = 4096;
const BEFORE_TIMEOUT_MS = 1500;

let PurchasingLog = null;
const LogModel = () => PurchasingLog || (PurchasingLog = require('../models/purchasingLog'));

/** Copy of the body without secrets / files, max ~4 KB. */
function sanitize(body, files) {
  const clean = (v, depth = 0) => {
    if (v == null || typeof v !== 'object') return typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v;
    if (depth > 5) return '[…]';
    if (Buffer.isBuffer(v)) return '[file]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = clean(x, depth + 1);
    }
    return out;
  };
  let out = body && typeof body === 'object' && Object.keys(body).length ? clean(body) : null;
  const fileCount = Array.isArray(files) ? files.length : files && typeof files === 'object' ? Object.values(files).flat().length : 0;
  if (fileCount) out = { ...(out || {}), _files: fileCount };
  if (!out) return null;
  const text = JSON.stringify(out);
  return text.length > MAX_REQUEST ? { _cut: true, text: text.slice(0, MAX_REQUEST) } : out;
}

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

/** "Chrome · Android" style short device text. */
function deviceOf(ua) {
  if (!ua) return null;
  const s = String(ua);
  let browser = 'Other';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/chrome\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/electron/i.test(s)) browser = 'Desktop app';
  else if (/node|undici|axios|curl|postman/i.test(s)) browser = 'Script';
  let os = '';
  if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/** Keep only valid ids / plain values in refs (an invalid id would fail the insert). */
const ID_REFS = new Set(['purchaseOrder', 'grn', 'bill', 'vendor', 'product', 'entry', 'item', 'charge', 'payment', 'vendorReturn', 'consignment', 'settlement', 'ledgerEntry', 'labelPrint']);
function cleanRefs(refs) {
  const out = {};
  for (const [k, v0] of Object.entries(refs || {})) {
    if (v0 === undefined || v0 === null || v0 === '') continue;
    const v = v0 && v0._id ? v0._id : v0;
    if (ID_REFS.has(k)) {
      if (isId(v)) out[k] = String(v);
    } else if (k === 'entryNo') {
      if (Number.isFinite(Number(v))) out[k] = Number(v);
    } else {
      out[k] = String(v).slice(0, 200);
    }
  }
  return out;
}

const cleanChanges = (list) =>
  (Array.isArray(list) ? list : []).slice(0, 60).map((c) => {
    const val = (x) => (x === undefined ? null : x && typeof x === 'object' && !(x instanceof Date) ? JSON.stringify(x).slice(0, 300) : x);
    return { field: String(c.field || '').slice(0, 100), from: val(c.from), to: val(c.to) };
  });

async function userOf(req, route, body) {
  const access = req.access;
  if (access && access.userId) {
    let name = '';
    try {
      const { loadUserAccess } = require('./access');
      const info = await loadUserAccess(access.userId);
      const u = info && info.user;
      if (u) name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '';
    } catch {
      /* name is optional */
    }
    return { id: access.userId, name, role: access.roleName || '' };
  }
  if (route.user) {
    try {
      const t = route.user({ body, req });
      if (t) return { id: t.id, name: t.name || '', role: '' };
    } catch {
      /* ignore */
    }
  }
  const u = req.user;
  if (u && (u.id || u._id)) return { id: u.id || u._id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), role: '' };
  return { id: null, name: '', role: '' };
}

function errorOf(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 500);
  const m = body.message || body.error;
  return typeof m === 'string' ? m.slice(0, 500) : null;
}

async function writeRow(req, res, hit, before, resBody, startedAt, closed) {
  const { route, params } = hit;
  const statusCode = closed && !res.headersSent ? 499 : res.statusCode;
  const ok = statusCode < 400;
  const body = req.body || {};
  const data = resBody && typeof resBody === 'object' ? resBody.data : null;

  let described = {};
  if (route.describe) {
    try {
      described = route.describe({ params, body, data, res: resBody, before, ok, req }) || {};
    } catch (err) {
      described = {};
    }
  }
  const extra = (res.locals && res.locals.purchasingLog) || {};
  let summary = extra.summary || described.summary || route.label;
  summary = String(summary || '').replace(/\s+/g, ' ').trim();
  const error = ok ? null : errorOf(resBody) || `HTTP ${statusCode}`;
  if (!ok) summary = `FAILED: ${summary} — ${error}`;

  const who = await userOf(req, route, body);
  const row = {
    at: new Date(startedAt),
    user: isId(who.id) ? String(who.id) : null,
    userName: who.name || '',
    roleName: who.role || '',
    area: route.area,
    action: route.action,
    summary: summary.slice(0, 1000),
    refs: cleanRefs({ ...(described.refs || {}), ...(extra.refs || {}) }),
    changes: ok ? cleanChanges(extra.changes || described.changes) : [],
    method: req.method,
    path: (req.originalUrl || req.url || '').split('?')[0].slice(0, 300),
    request: sanitize(body, req.files),
    ok,
    statusCode,
    error,
    ip: ipOf(req),
    device: deviceOf(req.headers['user-agent']),
    durationMs: Date.now() - startedAt,
  };
  await LogModel().create(row);
}

async function purchasingLogger(req, res, next) {
  let hit = null;
  try {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    hit = match(req.method, req.path);
  } catch {
    hit = null;
  }
  if (!hit) return next();

  const startedAt = Date.now();
  let before = null;
  // Snapshot only for signed-in calls (or the ticketed sticker log).
  if (hit.route.before && (req.headers.authorization || hit.route.user)) {
    try {
      before = await withTimeout(hit.route.before({ params: hit.params, req }), BEFORE_TIMEOUT_MS);
    } catch {
      before = null;
    }
  }

  let resBody = null;
  let written = false;
  try {
    const json = res.json;
    res.json = function capture(b) {
      resBody = b;
      return json.call(this, b);
    };
  } catch {
    /* keep going */
  }
  const finish = (closed) => {
    if (written) return;
    written = true;
    setImmediate(() => {
      writeRow(req, res, hit, before, resBody, startedAt, closed).catch((err) => {
        console.error('[purchasing-log] write failed:', err.message);
      });
    });
  };
  res.on('finish', () => finish(false));
  res.on('close', () => finish(true));
  return next();
}

module.exports = purchasingLogger;
module.exports.sanitize = sanitize;
