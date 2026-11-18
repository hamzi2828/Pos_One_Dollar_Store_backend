// Employee Portal (/api/me/portal/...): an employee sees only its own HR data. Read only.
// Two ways in:
//   - email code (no password): POST /api/portal/login/request-code + /verify
//     give a portal-only token { kind: 'portal', emp } (services/hr/portalLoginService.js)
//   - a staff login (Employee.user = the login), no role permission needed
// The employee comes from the token, never from the request. Logic: services/hr/portalService.js.
const express = require('express');
const auth = require('../../middleware/auth');
const { loadAccess } = require('../../middleware/access');
const { handle } = require('./_access');
const svc = require('../../services/hr/portalService');
const login = require('../../services/hr/portalLoginService');

const router = express.Router();
// Private data: never cached by the browser.
const ok = (res, data) => res.set('Cache-Control', 'no-store').json({ success: true, data });

// Portal token (email code) or a staff login.
const staff = [
  auth,
  (req, res, next) => {
    if (req.user && req.user.kind === 'portal') {
      req.portal = { employeeId: String(req.user.emp || '') };
      return next();
    }
    return loadAccess(req, res, next);
  },
];

// Sign in by email code (public).
router.post(
  '/portal/login/request-code',
  handle(async (req, res) => ok(res, await login.requestCode((req.body || {}).email)))
);
router.post(
  '/portal/login/verify',
  handle(async (req, res) => {
    const b = req.body || {};
    ok(res, await login.verifyCode(b.email, b.code));
  })
);

// Whose portal: the employee of a portal token, the login's own, or (admin preview, owner 2026-11-17) ?as=<employeeId>
// for someone who can view employees AND payroll. Read only either way.
function who(req) {
  const as = String(req.query.as || '').trim();
  if (req.portal) {
    if (as) throw Object.assign(new Error('You cannot view other staff portals'), { status: 403 });
    if (!/^[a-f\d]{24}$/i.test(req.portal.employeeId)) throw Object.assign(new Error('Please sign in again'), { status: 401 });
    return { employeeId: req.portal.employeeId, activeOnly: true };
  }
  if (!as) return req.access.userId;
  const a = req.access || {};
  const allowed = a.isSuperAdmin || (typeof a.can === 'function' && a.can('employees', 'view') && a.can('payroll', 'view'));
  if (!allowed) throw Object.assign(new Error('You cannot view other staff portals'), { status: 403 });
  if (!/^[a-f\d]{24}$/i.test(as)) throw Object.assign(new Error('Invalid employee'), { status: 400 });
  return { employeeId: as };
}

router.get('/me/portal/profile', ...staff, handle(async (req, res) => ok(res, await svc.profile(who(req)))));
router.get('/me/portal/attendance', ...staff, handle(async (req, res) => ok(res, await svc.attendance(who(req), req.query.month))));
router.get('/me/portal/payslips', ...staff, handle(async (req, res) => ok(res, await svc.payslips(who(req)))));
router.get('/me/portal/payslips/:runId', ...staff, handle(async (req, res) => ok(res, await svc.payslip(who(req), req.params.runId))));
router.get('/me/portal/money', ...staff, handle(async (req, res) => ok(res, await svc.money(who(req)))));
// Late note: the employee's own reason (never in admin preview).
router.put(
  '/me/portal/attendance/:date/late-note',
  ...staff,
  handle(async (req, res) => {
    if (req.query.as) throw Object.assign(new Error('Admin preview is read only'), { status: 403 });
    ok(res, await svc.saveLateNote(who(req), req.params.date, req.body || {}));
  })
);

module.exports = router;
