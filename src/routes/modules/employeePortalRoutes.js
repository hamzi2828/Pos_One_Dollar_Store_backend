// Employee Portal (/api/me/portal/...): a staff login sees only its own HR data. Read only.
// Any valid login (no role permission). The employee comes from the login
// (Employee.user), never from the request. Logic: services/hr/portalService.js.
const express = require('express');
const { staff, handle } = require('./_access');
const svc = require('../../services/hr/portalService');

const router = express.Router();
// Private data: never cached by the browser.
const ok = (res, data) => res.set('Cache-Control', 'no-store').json({ success: true, data });

router.get('/me/portal/profile', ...staff, handle(async (req, res) => ok(res, await svc.profile(req.access.userId))));
router.get('/me/portal/attendance', ...staff, handle(async (req, res) => ok(res, await svc.attendance(req.access.userId, req.query.month))));
router.get('/me/portal/payslips', ...staff, handle(async (req, res) => ok(res, await svc.payslips(req.access.userId))));
router.get('/me/portal/payslips/:runId', ...staff, handle(async (req, res) => ok(res, await svc.payslip(req.access.userId, req.params.runId))));
router.get('/me/portal/money', ...staff, handle(async (req, res) => ok(res, await svc.money(req.access.userId))));

module.exports = router;
