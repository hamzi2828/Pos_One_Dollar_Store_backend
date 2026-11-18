// Reports & analytics + category staff (/api/analytics, /api/category-assignments). OWNER: Reports module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access'); // eslint-disable-line no-unused-vars
const ctrl = require('../../controller/store/analyticsController');
const staffCtrl = require('../../controller/store/categoryAssignmentController');

const router = express.Router();

// Any analytics report may read the dropdown options.
const ANY_REPORT = ['report_demand', 'report_trends', 'report_slow_moving', 'report_footfall', 'report_category_performance', 'report_expenses'];
router.get('/analytics/filters', ...staff, can(ANY_REPORT, 'view'), handle(ctrl.filters));

// Demand list (items that fell to the reorder level). Settings: store-wide values
// need report_demand edit; product par levels report_demand or products edit
// (checked again in the controller).
router.get('/analytics/demand', ...staff, can('report_demand', 'view'), handle(ctrl.demand));
router.get('/analytics/demand/export', ...staff, can('report_demand', 'export'), handle(ctrl.demandExport));
router.get('/analytics/demand/settings', ...staff, can('report_demand', 'view'), handle(ctrl.demandSettings));
router.put('/analytics/demand/settings', ...staff, can(['report_demand', 'products'], 'edit'), handle(ctrl.saveDemandSettings));

// Sales trends & seasonality
router.get('/analytics/trends', ...staff, can('report_trends', 'view'), handle(ctrl.trends));
router.get('/analytics/trends/product', ...staff, can('report_trends', 'view'), handle(ctrl.trendsProduct));
router.get('/analytics/trends/export', ...staff, can('report_trends', 'export'), handle(ctrl.trendsExport));

// Slow-moving stock
router.get('/analytics/slow-moving', ...staff, can('report_slow_moving', 'view'), handle(ctrl.slowMoving));
router.get('/analytics/slow-moving/export', ...staff, can('report_slow_moving', 'export'), handle(ctrl.slowMovingExport));
router.put('/analytics/slow-moving/settings', ...staff, can('report_slow_moving', 'edit'), handle(ctrl.saveSlowMovingSettings));

// Expenses by day / week / month (shop use shown separately)
router.get('/analytics/expenses', ...staff, can('report_expenses', 'view'), handle(ctrl.expenses));
// Money left since the owner's starting balance (cash + bank together).
router.get(
  '/analytics/funds',
  ...staff,
  can(['report_cash_in_hand', 'report_expenses'], 'view'), // Cash in Hand report (was Spending)
  handle(async (req, res) => {
    res.json({ success: true, data: await require('../../services/reports/fundsReport').funds() });
  })
);
router.post(
  '/analytics/funds/baseline',
  ...staff,
  superAdmin,
  handle(async (req, res) => {
    res.json({ success: true, data: await require('../../services/reports/fundsReport').setBaseline(req, req.body || {}) });
  })
);
// JazzCash wallet for a period: every JazzCash in / out with a running balance (Cash in Hand tab).
router.get(
  '/analytics/jazzcash',
  ...staff,
  can(['report_cash_in_hand', 'report_expenses'], 'view'),
  handle(async (req, res) => {
    res.json({ success: true, data: await require('../../services/reports/jazzcashReport').jazzcash(req.query || {}) });
  })
);
// Spending: bought from vendors, paid, trip costs, shop expenses for a period.
router.get(
  '/analytics/spending',
  ...staff,
  can(['report_cash_in_hand', 'report_expenses'], 'view'), // Cash in Hand report (was Spending)
  handle(async (req, res) => {
    const data = await require('../../services/reports/spendingReport').spending(req.query || {});
    res.json({ success: true, data });
  })
);
// Financial statements: Income Statement, Balance Sheet, Cash Flow (services/reports/financialStatements.js).
const FIN = () => require('../../services/reports/financialStatements');
router.get('/analytics/financial/income', ...staff, can('report_financial_statements', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await FIN().incomeStatement(req.query || {}) });
}));
router.get('/analytics/financial/balance-sheet', ...staff, can('report_financial_statements', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await FIN().balanceSheet() });
}));
// Partners: capital, share of profit, money taken, balance (owner 2026-11-17).
router.get('/analytics/financial/partners', ...staff, can(['report_financial_statements', 'investments'], 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await FIN().partners() });
}));
router.put('/analytics/financial/partners/:id/share', ...staff, superAdmin, handle(async (req, res) => {
  res.json({ success: true, data: await FIN().setPartnerShare(req.params.id, req.body || {}) });
}));
router.get('/analytics/financial/cash-flow', ...staff, can('report_financial_statements', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await FIN().cashFlow(req.query || {}) });
}));
router.get('/analytics/expenses/export', ...staff, can('report_expenses', 'export'), handle(ctrl.expensesExport));

// Footfall + daily visitor counts
router.get('/analytics/footfall', ...staff, can('report_footfall', 'view'), handle(ctrl.footfall));
router.get('/analytics/footfall/export', ...staff, can('report_footfall', 'export'), handle(ctrl.footfallExport));
router.get('/analytics/footfall/entries', ...staff, can('report_footfall', 'view'), handle(ctrl.footfallEntries));
router.post('/analytics/footfall/entries', ...staff, can('report_footfall', 'create'), handle(ctrl.saveFootfallEntry));
router.put('/analytics/footfall/entries/:id', ...staff, can('report_footfall', 'edit'), handle(ctrl.updateFootfallEntry));
router.delete('/analytics/footfall/entries/:id', ...staff, can('report_footfall', 'delete'), handle(ctrl.deleteFootfallEntry));

// Category performance + employee leaderboard
router.get('/analytics/category-performance', ...staff, can('report_category_performance', 'view'), handle(ctrl.categoryPerformance));
router.get('/analytics/category-performance/export', ...staff, can('report_category_performance', 'export'), handle(ctrl.categoryPerformanceExport));

// Category staff. The catalogue has view + edit for this key, so every write uses edit.
router.get('/category-assignments', ...staff, can('category_assignments', 'view'), handle(staffCtrl.list));
router.get('/category-assignments/employees', ...staff, can('category_assignments', 'view'), handle(staffCtrl.employees));
router.get('/category-assignments/categories', ...staff, can('category_assignments', 'view'), handle(staffCtrl.categories));
router.get('/category-assignments/:id', ...staff, can('category_assignments', 'view'), handle(staffCtrl.get));
router.post('/category-assignments', ...staff, can('category_assignments', 'edit'), handle(staffCtrl.create));
router.put('/category-assignments/:id', ...staff, can('category_assignments', 'edit'), handle(staffCtrl.update));
router.delete('/category-assignments/:id', ...staff, can('category_assignments', 'edit'), handle(staffCtrl.remove));

module.exports = router;
