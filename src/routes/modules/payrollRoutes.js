// Payroll: advances, deductions (till shortage), staff tips (/api/staff-tips), payroll runs, payslips (/api/payroll/..., /api/salary-advances, /api/payroll-deductions). OWNER: Payroll module.
// Mounted at /api by routes/modules/index.js — define sub-paths relative to /api.
//
// Permission `payroll`: GET view, POST create, PUT edit, DELETE delete, CSV export.
// Decisions need `edit`: approve / pay / reopen a run, approve / waive a deduction,
// cancel an advance. Reopen is super admin only.
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access');
const runs = require('../../controller/store/payrollController');
const advances = require('../../controller/store/salaryAdvanceController');
const deductions = require('../../controller/store/payrollDeductionController');
const tips = require('../../controller/store/staffTipController');

const router = express.Router();

// ----- Staff picker -----
router.get('/payroll/employees', ...staff, can('payroll', 'view'), handle(runs.employees));

// ----- Payroll runs -----
router.get('/payroll/to-date', ...staff, can('payroll', 'view'), handle(runs.toDate));
router.get('/payroll/runs', ...staff, can('payroll', 'view'), handle(runs.list));
router.post('/payroll/runs', ...staff, can('payroll', 'create'), handle(runs.generate));
router.get('/payroll/runs/:id', ...staff, can('payroll', 'view'), handle(runs.get));
router.delete('/payroll/runs/:id', ...staff, can('payroll', 'delete'), handle(runs.remove));
router.post('/payroll/runs/:id/regenerate', ...staff, can('payroll', 'create'), handle(runs.regenerate));
router.put('/payroll/runs/:id/lines/:lineId', ...staff, can('payroll', 'edit'), handle(runs.updateLine));
router.post('/payroll/runs/:id/approve', ...staff, can('payroll', 'edit'), handle(runs.approve));
router.post('/payroll/runs/:id/reopen', ...staff, can('payroll', 'edit'), superAdmin, handle(runs.reopen));
router.post('/payroll/runs/:id/pay', ...staff, can('payroll', 'edit'), handle(runs.pay));
router.get('/payroll/runs/:id/export', ...staff, can('payroll', 'export'), handle(runs.exportCsv));
router.get('/payroll/runs/:id/lines/:lineId/payslip', ...staff, can('payroll', 'view'), handle(runs.payslip));
router.get('/payroll/runs/:id/lines/:lineId/days', ...staff, can('payroll', 'view'), handle(runs.lineDays));

// ----- Salary advances -----
router.get('/salary-advances', ...staff, can('payroll', 'view'), handle(advances.list));
router.post('/salary-advances', ...staff, can('payroll', 'create'), handle(advances.create));
router.get('/salary-advances/:id', ...staff, can('payroll', 'view'), handle(advances.get));
router.post('/salary-advances/:id/cancel', ...staff, can('payroll', 'edit'), handle(advances.cancel));

// ----- Deductions -----
router.get('/payroll-deductions', ...staff, can('payroll', 'view'), handle(deductions.list));
router.post('/payroll-deductions', ...staff, can('payroll', 'create'), handle(deductions.create));
router.post('/payroll-deductions/:id/approve', ...staff, can('payroll', 'edit'), handle(deductions.approve));
router.post('/payroll-deductions/:id/waive', ...staff, can('payroll', 'edit'), handle(deductions.waive));

// ----- Staff tips (each one is an expense in "Staff Tips", not salary) -----
router.get('/staff-tips', ...staff, can('payroll', 'view'), handle(tips.list));
router.post('/staff-tips', ...staff, can('payroll', 'create'), handle(tips.create));
router.delete('/staff-tips/:id', ...staff, can('payroll', 'delete'), handle(tips.remove));

module.exports = router;
