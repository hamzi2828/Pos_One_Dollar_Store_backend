// Admin dashboard — mounted at /dashboard from index.js.
// auth (JWT) + loadAccess + permission `dashboard` view.
const express = require('express');
const dashboardController = require('../controller/dashboardController');
const auth = require('../middleware/auth');
const { loadAccess, requirePermission } = require('../middleware/access');

const router = express.Router();

router.get('/', auth, loadAccess, requirePermission('dashboard', 'view'), dashboardController.getDashboardData);

module.exports = router;
