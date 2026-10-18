// Shared access helpers for the module route files (same rules as allRoutes.js):
//   router.get('/racks', ...staff, can('racks', 'view'), handler)
// HTTP method -> action: GET view, POST create, PUT/PATCH edit, DELETE delete, exports export.
const auth = require('../../middleware/auth');
const { loadAccess, requirePermission, requireSuperAdmin } = require('../../middleware/access');

// Logged-in staff: verify JWT, then load role/permissions into req.access.
const staff = [auth, loadAccess];

// Permission check (any of the keys with this action). Tagged for route tests.
const can = (keys, action = 'view') => {
  const mw = requirePermission(keys, action);
  mw.permission = { keys: [].concat(keys), action };
  return mw;
};

const superAdmin = requireSuperAdmin;

// Wrap async handlers: errors with err.status become JSON responses.
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    const status = Number(err.status) || 500;
    if (status >= 500) console.error('[api]', req.method, req.originalUrl, err);
    if (!res.headersSent) {
      res.status(status).json({
        success: false,
        message: status >= 500 ? 'Something went wrong' : err.message,
        code: err.code || undefined,
        error: status >= 500 ? err.message : undefined,
        ...(err.available !== undefined ? { available: err.available } : {}),
      });
    }
  }
};

module.exports = { staff, can, superAdmin, handle };
