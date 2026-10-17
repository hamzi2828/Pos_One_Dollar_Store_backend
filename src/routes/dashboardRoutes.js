// Admin dashboard — mounted at /dashboard from index.js.
// Every route: auth (JWT) + loadAccess + permission `dashboard` (export: dashboard:export).
const express = require('express');
const router = express.Router();
const dashboardController = require('../controller/dashboardController');
const auth = require('../middleware/auth');
const { loadAccess, requirePermission } = require('../middleware/access');

// Permission check. Tagged for the route tests.
const can = (keys, action = 'view') => {
  const mw = requirePermission(keys, action);
  mw.permission = { keys: [].concat(keys), action };
  return mw;
};
const view = can('dashboard', 'view');

router.use(auth);
router.use(loadAccess);

router.get('/', view, dashboardController.getDashboardData);

router.get('/stats', view, dashboardController.getDashboardStats);

router.get('/recent-orders', view, dashboardController.getRecentOrders);

router.get('/quick-stats', view, dashboardController.getQuickStats);

router.get('/sales-trend', view, dashboardController.getSalesTrend);

router.get('/top-products', view, dashboardController.getTopProducts);

router.get('/recent-activity', view, dashboardController.getRecentActivity);

router.get('/customer-distribution', view, dashboardController.getCustomerDistribution);

router.get('/analytics', view, dashboardController.getAnalytics);

router.get('/report', view, dashboardController.generateReport);

router.get('/export', can('dashboard', 'export'), dashboardController.exportData);

router.post('/refresh', view, dashboardController.refreshDashboard);

router.get('/notifications', view, dashboardController.getNotifications);

router.patch('/notifications/:notificationId/read', view, dashboardController.markNotificationAsRead);

router.get('/metrics/:metricType', view, dashboardController.getMetrics);

router.get('/revenue-breakdown', view, dashboardController.getRevenueBreakdown);

router.get('/inventory-status', view, dashboardController.getInventoryStatus);

router.get('/performance-metrics', view, dashboardController.getPerformanceMetrics);

module.exports = router;
