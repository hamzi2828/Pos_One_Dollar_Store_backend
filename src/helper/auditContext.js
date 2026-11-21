// Who is making this change? Request context for the data change log.
//
// The first middleware in index.js runs every request inside an
// AsyncLocalStorage store. Anything that runs for that request (controllers,
// services, Mongoose hooks) can then ask getActor() for the user, IP and
// request id without passing `req` around.
// Code that runs outside a request (scripts, timers) gets source 'system'.
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const als = new AsyncLocalStorage();

function extractIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || null;
}

/** Express middleware: give every request an id and an audit context. */
function auditContextMiddleware(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.requestId = /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  als.run({ req }, () => next());
}

/** Run `fn` with a named non-request actor (scripts, scheduled jobs). */
function runAsSystem(name, fn) {
  return als.run({ system: name || 'system' }, fn);
}

/** Snapshot of who/where for the current async context. Never throws. */
function getActor() {
  const store = als.getStore();
  if (!store) return { source: 'system', actorName: 'system' };
  if (store.system) return { source: 'system', actorName: store.system };
  const req = store.req;
  // req.user is set later by the auth middleware; it is read lazily here.
  const u = req.user || {};
  const isPortal = u.kind === 'portal';
  const rawId = isPortal ? null : (req.access?.userId || u.id || u._id || null);
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return {
    source: 'api',
    userId: rawId ? String(rawId) : null,
    employeeId: isPortal ? String(u.emp || u.id || '') || null : null,
    actorKind: isPortal ? 'portal' : (rawId ? 'staff' : 'guest'),
    actorName: name || u.email || null,
    actorEmail: u.email || null,
    ipAddress: extractIp(req),
    userAgent: req.headers['user-agent'] || null,
    method: req.method,
    path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
    requestId: req.requestId || null,
  };
}

module.exports = { auditContextMiddleware, runAsSystem, getActor, als };
