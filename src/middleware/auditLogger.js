const AuditLog = require('../models/auditLog');

// Named actions for known admin routes (nicer labels in the Activity Log).
const ROUTE_ACTION_MAP = {
  // Auth
  'POST /user/login':           'login',
  'PUT /user/change-password':  'change_password',

  // Products
  'GET /products/:id':          'view_product',

  // Admin user management
  'PUT /update/status/:id':     'admin_update_user_status',
  'PUT /update/role/:id':       'admin_update_user_role',
  'DELETE /delete/:id':         'admin_delete_user',
  'GET /get/allUsers':          'admin_view_users',

  // Admin roles
  'GET /admin/roles':              'admin_view_roles',
  'GET /admin/roles/:id':          'admin_view_role',
  'POST /admin/roles':             'admin_create_role',
  'POST /admin/roles/defaults':    'admin_create_default_roles',
  'PUT /admin/roles/:id':          'admin_update_role',
  'PUT /admin/roles/:id/permissions': 'admin_update_role_permissions',
  'DELETE /admin/roles/:id':       'admin_delete_role',

  // Staff users
  'POST /admin/staff':                     'admin_create_staff',
  'PUT /admin/staff/:id':                  'admin_update_staff',
  'POST /admin/staff/:id/reset-password':  'admin_reset_staff_password',
  'DELETE /admin/staff/:id':               'admin_delete_staff',
  'POST /api/employees/:id/login':         'admin_create_employee_login',
  'DELETE /api/employees/:id/login':       'admin_unlink_employee_login',

  // Stock
  'POST /products/:id/stock/receive':      'receive_stock',
};

// Actions with elevated severity — audit-relevant / security-sensitive.
const SEVERITY_MAP = {
  login:                    'warn',
  change_password:          'critical',
  admin_delete_user:        'critical',
  admin_update_user_status: 'critical',
  admin_update_user_role:   'critical',
  admin_create_role:        'warn',
  admin_create_default_roles: 'warn',
  admin_update_role:        'warn',
  admin_update_role_permissions: 'critical',
  admin_delete_role:        'critical',
  admin_create_staff:       'warn',
  admin_update_staff:       'critical',
  admin_reset_staff_password: 'critical',
  admin_delete_staff:       'critical',
  admin_create_employee_login: 'warn',
  admin_unlink_employee_login: 'warn',
};

// Routes to completely skip (health, static, audit logs themselves)
// '/api/public': anonymous reads by the public marketing website (would flood the log).
const SKIP_PREFIXES = ['/uploads', '/health', '/admin/audit-logs', '/favicon', '/api/public'];

const AUTH_ACTIONS = new Set(['login']);
const SENSITIVE_QUERY_KEYS = new Set(['password', 'token', 'secret', 'apikey', 'api_key', 'authorization']);

function normalizePathForMatching(path) {
  return path
    .replace(/\/[a-f0-9]{24}/g, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/** Get client IP respecting X-Forwarded-For (first in the list is the client). */
function extractIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.connection?.remoteAddress || null;
}

/** Minimal UA parser — good enough for filtering without pulling in a package. */
function parseUserAgent(ua) {
  if (!ua) return { browser: null, os: null, device: null };
  const s = String(ua);
  const lower = s.toLowerCase();

  let device = 'desktop';
  if (/bot|spider|crawler|slurp|bingpreview|facebookexternalhit/i.test(s)) device = 'bot';
  else if (/tablet|ipad/i.test(s)) device = 'tablet';
  else if (/mobile|android|iphone|ipod/i.test(s)) device = 'mobile';

  let os = null;
  if (lower.includes('windows nt 10')) os = 'Windows 10/11';
  else if (lower.includes('windows'))  os = 'Windows';
  else if (/mac os x|macintosh/.test(lower)) os = 'macOS';
  else if (lower.includes('android'))  os = 'Android';
  else if (/iphone|ipad|ipod/.test(lower)) os = 'iOS';
  else if (lower.includes('linux'))    os = 'Linux';

  let browser = null;
  if (/edg\//i.test(s))         browser = 'Edge';
  else if (/opr\/|opera/i.test(s))  browser = 'Opera';
  else if (/chrome\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/postman/i.test(s))  browser = 'Postman';
  else if (/curl|wget|axios|node-fetch/i.test(s)) browser = 'CLI';

  return { browser, os, device };
}

/** Extract the most likely "resource id" touched by this request. */
function extractResourceId(req) {
  const p = req.params || {};
  return p.id || p.productId || p.orderId || p.userId || p.roleId || p.categoryId || p.vendorId || null;
}

/** Strip secrets out of ?query=... so we never persist them. */
function sanitizeQuery(query) {
  if (!query || typeof query !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(query)) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) continue;
    // keep scalars + short arrays; drop objects
    if (Array.isArray(v)) out[k] = v.slice(0, 5).map(String);
    else if (v != null && typeof v !== 'object') out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

/** If body is an object with a known error-ish shape, pull a short message out. */
function extractErrorMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 500);
  if (typeof body !== 'object') return null;
  const candidate = body.message || body.error || body.msg;
  if (typeof candidate === 'string') return candidate.slice(0, 500);
  if (candidate && typeof candidate === 'object') {
    try { return JSON.stringify(candidate).slice(0, 500); } catch { return null; }
  }
  return null;
}

/** Try to coerce a response chunk (string/Buffer) into JSON if applicable. */
function tryParseBody(chunk, contentType) {
  if (chunk == null) return null;
  if (typeof chunk === 'object' && !Buffer.isBuffer(chunk)) return chunk;
  const asString = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (!contentType || !contentType.includes('json')) {
    // non-JSON body (html, file, redirect) — keep just the first 500 chars as a string
    return asString.slice(0, 500);
  }
  try { return JSON.parse(asString); } catch { return asString.slice(0, 500); }
}

function buildDetails(action, req, responseBody) {
  const d = {};

  switch (action) {
    case 'login':
      d.email = req.body?.email || responseBody?.data?.email || null;
      break;
    case 'admin_update_user_status':
      d.targetUserId = req.params?.id || null;
      d.isActive = req.body?.isActive;
      break;
    case 'admin_update_user_role':
      d.targetUserId = req.params?.id || null;
      d.newRole = req.body?.role || null;
      break;
    case 'admin_delete_user':
      d.targetUserId = req.params?.id || null;
      break;
    case 'admin_create_role':
    case 'admin_update_role':
      d.name = req.body?.name || null;
      break;
    case 'admin_update_role_permissions': {
      const perms = req.body?.permissions || {};
      d.groupCount = Object.keys(perms).length;
      d.actionCount = Object.values(perms).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      );
      break;
    }
    case 'admin_create_staff':
      d.email = req.body?.email || null;
      d.isSuperAdmin = req.body?.isSuperAdmin === true;
      d.staffRole = req.body?.staffRole || null;
      break;
    case 'admin_update_staff':
      d.targetUserId = req.params?.id || null;
      d.fields = Object.keys(req.body || {}).filter((k) => !/password/i.test(k));
      if (req.body?.staffRole !== undefined) d.staffRole = req.body.staffRole;
      if (req.body?.isActive !== undefined) d.isActive = req.body.isActive;
      if (req.body?.isSuperAdmin !== undefined) d.isSuperAdmin = req.body.isSuperAdmin;
      break;
    case 'admin_reset_staff_password':
    case 'admin_delete_staff':
      d.targetUserId = req.params?.id || null;
      break;
    case 'admin_create_employee_login':
      d.employeeId = req.params?.id || null;
      d.email = req.body?.email || null;
      d.staffRole = req.body?.roleId || null;
      break;
    case 'admin_unlink_employee_login':
      d.employeeId = req.params?.id || null;
      break;
    case 'receive_stock':
      d.productId = req.params?.id || null;
      d.variantId = req.body?.variantId || null;
      d.quantity = req.body?.quantity ?? null;
      break;
    case 'view_product':
      d.slug = req.params?.id || req.path.split('/').pop() || null;
      break;
    default:
      break;
  }

  return Object.keys(d).length > 0 ? d : null;
}

/**
 * Audit every request — not just the ones that answer via res.json().
 * We hook res.send / res.end so redirects, file downloads, and error
 * responses are captured too.
 */
function auditLogger(req, res, next) {
  const method = req.method.toUpperCase();

  if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const startedAt = Date.now();
  const normalizedPath = normalizePathForMatching(req.path);
  const key = `${method} ${normalizedPath}`;
  const action = ROUTE_ACTION_MAP[key] || `${method.toLowerCase()} ${normalizedPath}`;

  let logged = false;
  let capturedBody = null;

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  res.json = function (body) {
    capturedBody = body;
    writeLog();
    return originalJson(body);
  };
  res.send = function (body) {
    if (capturedBody == null) {
      capturedBody = tryParseBody(body, res.getHeader('content-type'));
    }
    writeLog();
    return originalSend(body);
  };
  res.end = function (chunk, encoding, cb) {
    if (capturedBody == null && chunk != null) {
      capturedBody = tryParseBody(chunk, res.getHeader('content-type'));
    }
    writeLog();
    return originalEnd(chunk, encoding, cb);
  };

  res.on('close', () => {
    // Client closed the connection before we responded — still capture it.
    if (!logged) writeLog(true);
  });

  function writeLog(connectionClosed = false) {
    if (logged) return;
    logged = true;

    let userId = req.user?.id || req.user?._id || null;
    if (!userId && AUTH_ACTIONS.has(action) && capturedBody?.data?._id) {
      userId = capturedBody.data._id;
    }

    const statusCode = res.statusCode || (connectionClosed ? 499 : null);
    const failed = statusCode && statusCode >= 400;
    const severity = SEVERITY_MAP[action] || (failed ? 'warn' : 'info');
    const { browser, os, device } = parseUserAgent(req.headers['user-agent']);

    const cacheHeader = res.getHeader('X-Cache') || res.getHeader('x-cache') || null;

    const entry = {
      userId,
      action,
      method,
      path: req.path,
      details: buildDetails(action, req, capturedBody),
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'] || null,
      browser,
      os,
      device,
      referer: req.headers['referer'] || req.headers['referrer'] || null,
      queryParams: sanitizeQuery(req.query),
      resourceId: extractResourceId(req),
      errorMessage: failed ? extractErrorMessage(capturedBody) : null,
      cacheStatus: cacheHeader ? String(cacheHeader) : null,
      responseSize: typeof capturedBody === 'string'
        ? Buffer.byteLength(capturedBody)
        : (capturedBody ? Buffer.byteLength(JSON.stringify(capturedBody)) : null),
      severity,
      statusCode,
      durationMs: Date.now() - startedAt,
    };

    const marker = failed ? '⚠️' : severity === 'critical' ? '🔒' : '📋';
    console.log(
      `${marker} Audit: ${action} | ${method} ${req.path} | user: ${userId || 'guest'} | ${statusCode || '—'}`
      + (failed && entry.errorMessage ? ` | ${entry.errorMessage}` : '')
    );

    AuditLog.create(entry).catch((err) => {
      console.error('Audit log write error:', err.message);
    });
  }

  next();
}

module.exports = auditLogger;
