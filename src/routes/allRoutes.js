// src/routes/allRoutes.js
// Admin panel API of the DOLLAR & Co POS (one shop, no customer website).
//
// Access control
// - Public: POST /user/login and GET /settings/public (login page branding).
// - Every other route: `...staff` (= auth + loadAccess) and then either
//   `can(key, action)` (permission from the user's Role, see
//   constants/rolePermissions.js; the super admin passes every check) or
//   `superAdmin` (super admin only).
// - HTTP method -> action: GET view, POST create, PUT/PATCH edit, DELETE delete,
//   export endpoints export.
// - Permission checks run BEFORE upload middleware so refused requests don't upload.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { loadAccess, requirePermission, requireSuperAdmin } = require('../middleware/access');
const { cache } = require('../middleware/cache');
const { uploadSingle, uploadFields } = require('../helper/upload');
const userController = require('../controller/userController');
const categoryController = require('../controller/categoryController');
const colorController = require('../controller/colorController');
const sizeController = require('../controller/sizeController');
const productController = require('../controller/productController');
const labelController = require('../controller/labelController');
const inventoryController = require('../controller/inventoryController');
const settingsController = require('../controller/settingsController');
const vendorController = require('../controller/vendorController');
const purchaseController = require('../controller/purchaseController');
const auditLogController = require('../controller/auditLogController');
const bankController = require('../controller/bankController');
const assetController = require('../controller/assetController');
const expenseController = require('../controller/expenseController');
const roleController = require('../controller/roleController');
const staffController = require('../controller/staffController');
const reportsController = require('../controller/reportsController');

const SEVEN_DAYS = 7 * 24 * 60 * 60;

// ----- access helpers ---------------------------------------------------------
// Logged-in staff: verify JWT, then load role/permissions into req.access.
const staff = [auth, loadAccess];
// Permission check (any of the keys with this action). Tagged for the route tests.
const can = (keys, action = 'view') => {
  const mw = requirePermission(keys, action);
  mw.permission = { keys: [].concat(keys), action };
  return mw;
};
const superAdmin = requireSuperAdmin;

// Read-only lookups shared by several screens (product form, POS, receive stock).
const PRODUCT_READ = ['products', 'pos', 'product_stock', 'stock_receive'];
const ATTRIBUTE_READ = ['product_attributes', 'products'];
const PRODUCT_UPLOADS = uploadFields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banners', maxCount: 10 },
  { name: 'colorThumbnail', maxCount: 10 },
  { name: 'colorBanner', maxCount: 20 },
]);

// ----- Auth -----
router.post('/user/login', userController.loginUser);
router.put('/user/change-password', ...staff, userController.changePassword);

// ----- Users page (customers + staff accounts) -----
router.get('/get/allUsers', ...staff, can('customers', 'view'), userController.getAllUsers);
// Staff accounts: super admin only (enforced in the controller).
router.put('/update/status/:id', ...staff, can('customers', 'edit'), userController.updateUserStatusById);
// Setting role 'admin' gives admin-panel access -> super admin only.
router.put('/update/role/:id', ...staff, superAdmin, userController.updateUserRoleById);
router.delete('/delete/:id', ...staff, can('customers', 'delete'), userController.deleteUserById);

// ----- Me / staff logins ------------------------------------------------------
// What the logged-in user is and can do.
router.get('/me/access', ...staff, staffController.me);

// Staff users (super admin, or permission `staff` — see staffController).
router.get('/admin/staff', ...staff, can('staff', 'view'), staffController.list);
router.post('/admin/staff', ...staff, can('staff', 'create'), staffController.create);
router.post('/admin/staff/:id/reset-password', ...staff, can('staff', 'edit'), staffController.resetPassword);
router.get('/admin/staff/:id', ...staff, can('staff', 'view'), staffController.getById);
router.put('/admin/staff/:id', ...staff, can('staff', 'edit'), staffController.update);
router.delete('/admin/staff/:id', ...staff, can('staff', 'delete'), staffController.remove);

// ----- Categories -----
router.get('/categories', ...staff, categoryController.listCategories); // any staff screen may list them
router.post('/categories', ...staff, can('product_categories', 'create'), uploadFields([
  { name: 'thumbnail', maxCount: 10 },
  { name: 'banner', maxCount: 1 },
]), categoryController.createCategory);
router.put('/categories/reorder', ...staff, can('product_categories', 'edit'), categoryController.reorderCategories);
router.put('/categories/:id', ...staff, can('product_categories', 'edit'), uploadFields([
  { name: 'thumbnail', maxCount: 10 },
  { name: 'banner', maxCount: 1 },
]), categoryController.updateCategory);
router.delete('/categories/:id', ...staff, can('product_categories', 'delete'), categoryController.deleteCategory);

// ----- Colors / sizes (product attributes) -----
router.get('/colors', ...staff, can(ATTRIBUTE_READ, 'view'), colorController.listColors);
router.post('/colors', ...staff, can('product_attributes', 'create'), colorController.createColor);
router.put('/colors/:id', ...staff, can('product_attributes', 'edit'), colorController.updateColor);
router.delete('/colors/:id', ...staff, can('product_attributes', 'delete'), colorController.deleteColor);
router.get('/sizes', ...staff, can(ATTRIBUTE_READ, 'view'), sizeController.listSizes);
router.post('/sizes', ...staff, can('product_attributes', 'create'), sizeController.createSize);
router.put('/sizes/:id', ...staff, can('product_attributes', 'edit'), sizeController.updateSize);
router.delete('/sizes/:id', ...staff, can('product_attributes', 'delete'), sizeController.deleteSize);

// ----- Products -----
router.get('/products', ...staff, can(PRODUCT_READ, 'view'), productController.listProducts);
// Codes + stock receiving. Must sit before /products/:id.
router.get('/products/codes/check', ...staff, can('products', 'view'), inventoryController.checkCode);
router.get('/products/codes/new-short-code', ...staff, can('products', 'view'), inventoryController.generateShortCode);
router.get('/products/codes/lookup/:code', ...staff, can(PRODUCT_READ, 'view'), inventoryController.lookupCode);
router.post('/products/:id/stock/receive', ...staff, can('stock_receive', 'create'), inventoryController.receiveStock);
// Barcode stickers (HTML page to print, JSON for a picker). Must sit before /products/:id.
router.post('/products/labels/print', ...staff, can('products', 'view'), labelController.printBulk);
router.get('/products/:id/labels', ...staff, can('products', 'view'), labelController.printLabels);
router.get('/products/:id/label-data', ...staff, can('products', 'view'), labelController.getLabelData);
router.get('/products/:id', ...staff, can(PRODUCT_READ, 'view'), productController.getProductById);
// multipart form-data: thumbnail (1), banners (up to 10), colorThumbnail / colorBanner (per colour)
router.post('/products', ...staff, can('products', 'create'), PRODUCT_UPLOADS, productController.createProduct);
router.put('/products/:id', ...staff, can('products', 'edit'), PRODUCT_UPLOADS, productController.updateProduct);
router.delete('/products/:id', ...staff, can('products', 'delete'), productController.deleteProduct);

// ----- Settings (reads: settings:view; every write: super admin) -----
// Public: shop name, logo, favicon and currency for the login page.
router.get('/settings/public', cache(SEVEN_DAYS, 'settings:public'), settingsController.getPublicSettings);
router.get('/settings', ...staff, can('settings', 'view'), settingsController.getSettings);
router.put('/settings', ...staff, superAdmin, settingsController.updateSettings);
router.post('/settings/logo', ...staff, superAdmin, uploadFields([{ name: 'logo', maxCount: 1 }]), settingsController.uploadLogo);
router.delete('/settings/logo', ...staff, superAdmin, settingsController.removeLogo);
router.post('/settings/favicon', ...staff, superAdmin, uploadFields([{ name: 'favicon', maxCount: 1 }]), settingsController.uploadFavicon);
router.delete('/settings/favicon', ...staff, superAdmin, settingsController.removeFavicon);
router.post('/settings/reset', ...staff, superAdmin, settingsController.resetSettings);
router.post('/settings/cache/reset', ...staff, superAdmin, settingsController.resetCaches);

// ----- Procurement (older vendor / purchase screens) -----
router.get('/admin/procurement/vendors', ...staff, can('procurement', 'view'), vendorController.list);
router.get('/admin/procurement/vendors/:id', ...staff, can('procurement', 'view'), vendorController.getById);
router.get('/admin/procurement/vendors/:id/ledger', ...staff, can('procurement', 'view'), vendorController.ledger);
router.post('/admin/procurement/vendors', ...staff, can('procurement', 'create'), vendorController.create);
router.put('/admin/procurement/vendors/:id', ...staff, can('procurement', 'edit'), vendorController.update);
router.put('/admin/procurement/vendors/:id/status', ...staff, can('procurement', 'edit'), vendorController.toggleStatus);
router.delete('/admin/procurement/vendors/:id', ...staff, can('procurement', 'delete'), vendorController.softDelete);
router.get('/admin/procurement/summary', ...staff, can('procurement', 'view'), purchaseController.summary);
router.get('/admin/procurement/transactions', ...staff, can('procurement', 'view'), purchaseController.listTransactions);
router.get('/admin/procurement/products/search', ...staff, can('procurement', 'view'), purchaseController.searchProducts);
router.get('/admin/procurement/purchases', ...staff, can('procurement', 'view'), purchaseController.list);
router.get('/admin/procurement/purchases/:id', ...staff, can('procurement', 'view'), purchaseController.getById);
router.post('/admin/procurement/purchases', ...staff, can('procurement', 'create'), purchaseController.create);
router.put('/admin/procurement/purchases/:id', ...staff, can('procurement', 'edit'), purchaseController.update);
router.delete('/admin/procurement/purchases/:id', ...staff, can('procurement', 'delete'), purchaseController.softDelete);
router.post('/admin/procurement/purchases/:id/payments', ...staff, can('procurement', 'edit'), purchaseController.addPayment);
router.delete('/admin/procurement/purchases/:id/payments/:paymentId', ...staff, can('procurement', 'edit'), purchaseController.removePayment);

// ----- Activity log (activity_log; clearing everything: super admin) -----
router.get('/admin/audit-logs', ...staff, can('activity_log', 'view'), auditLogController.getAllAuditLogs);
router.delete('/admin/audit-logs', ...staff, superAdmin, auditLogController.clearAllAuditLogs);
router.get('/admin/audit-logs/analytics', ...staff, can('activity_log', 'view'), auditLogController.getAuditAnalytics);
router.get('/admin/audit-logs/top-users', ...staff, can('activity_log', 'view'), auditLogController.getTopUsers);
router.get('/admin/audit-logs/user/:userId', ...staff, can('activity_log', 'view'), auditLogController.getUserAuditLogs);
router.get('/admin/audit-logs/user/:userId/summary', ...staff, can('activity_log', 'view'), auditLogController.getUserAuditSummary);

// ----- Finance: banks, assets (old register), expenses -----
router.get('/banks', ...staff, can('banks', 'view'), bankController.getAllBanks);
router.get('/banks/:id', ...staff, can('banks', 'view'), bankController.getBankById);
router.post('/banks', ...staff, can('banks', 'create'), bankController.createBank);
router.put('/banks/:id', ...staff, can('banks', 'edit'), bankController.updateBank);
router.put('/banks/:id/status', ...staff, can('banks', 'edit'), bankController.updateBankStatus);
router.delete('/banks/:id', ...staff, can('banks', 'delete'), bankController.deleteBank);

router.get('/assets', ...staff, can('assets', 'view'), assetController.getAllAssets);
router.get('/assets/:id', ...staff, can('assets', 'view'), assetController.getAssetById);
router.post('/assets', ...staff, can('assets', 'create'), assetController.createAsset);
router.put('/assets/:id', ...staff, can('assets', 'edit'), assetController.updateAsset);
router.put('/assets/:id/status', ...staff, can('assets', 'edit'), assetController.updateAssetStatus);
router.delete('/assets/:id', ...staff, can('assets', 'delete'), assetController.deleteAsset);

router.get('/expenses', ...staff, can('expenses', 'view'), expenseController.getAllExpenses);
router.get('/expenses/summary', ...staff, can('expenses', 'view'), expenseController.getExpenseSummary);
router.get('/expenses/categories', ...staff, can('expenses', 'view'), expenseController.getAllCategories);
router.post('/expenses/categories', ...staff, can('expenses', 'create'), expenseController.createCategory);
router.delete('/expenses/categories/:id', ...staff, can('expenses', 'delete'), expenseController.deleteCategory);
router.get('/expenses/:id', ...staff, can('expenses', 'view'), expenseController.getExpenseById);
router.post('/expenses', ...staff, can('expenses', 'create'), uploadSingle('receipt'), expenseController.createExpense);
router.put('/expenses/:id', ...staff, can('expenses', 'edit'), uploadSingle('receipt'), expenseController.updateExpense);
router.put('/expenses/:id/status', ...staff, can('expenses', 'edit'), expenseController.updateExpenseStatus);
router.delete('/expenses/:id', ...staff, can('expenses', 'delete'), expenseController.deleteExpense);

// ----- Roles & Permissions -----
// Reading: roles:view or staff:view (staff managers need the role list to
// assign roles); every change: super admin only.
router.get('/admin/roles/catalogue', ...staff, can(['roles', 'staff'], 'view'), roleController.getCatalogue);
router.get('/admin/roles', ...staff, can(['roles', 'staff'], 'view'), roleController.getAllRoles);
router.post('/admin/roles/defaults', ...staff, superAdmin, roleController.createDefaults);
router.get('/admin/roles/:id', ...staff, can(['roles', 'staff'], 'view'), roleController.getRoleById);
router.post('/admin/roles', ...staff, superAdmin, roleController.createRole);
router.put('/admin/roles/:id/permissions', ...staff, superAdmin, roleController.updatePermissions);
router.put('/admin/roles/:id', ...staff, superAdmin, roleController.updateRole);
router.delete('/admin/roles/:id', ...staff, superAdmin, roleController.deleteRole);

// Cache reset telemetry — when was each cache tag last invalidated
router.get('/admin/cache/resets', ...staff, can('settings', 'view'), async (req, res) => {
  const { getResetTimestamps } = require('../middleware/cache');
  return res.status(200).json({ success: true, data: await getResetTimestamps() });
});

// ----- POS — Point of Sale (auth + loadAccess + per-route permissions inside) -----
router.use('/api/pos', require('./posRoutes'));

// ----- Reports — server-side aggregations for the admin Reports section -----
router.get('/api/reports/cash-in-hand', ...staff, can('report_cash_in_hand', 'view'), reportsController.cashInHand);
router.get('/api/reports/sales-summary', ...staff, can('report_sales', 'view'), reportsController.salesSummary);
router.get('/api/reports/purchases-summary', ...staff, can('report_purchases', 'view'), reportsController.purchasesSummary);
router.get('/api/reports/cost-analysis', ...staff, can('report_cost_analysis', 'view'), reportsController.costAnalysis);
router.get('/api/reports/stock', ...staff, can('report_stock', 'view'), reportsController.stock);
router.get('/api/reports/expenses', ...staff, can('report_expenses', 'view'), reportsController.expensesReport);
router.get('/api/reports/vendor-payments', ...staff, can('report_vendor_payments', 'view'), reportsController.vendorPaymentsReport);

// Store operations (racks & shelves, purchasing, vendors, cash/till, analytics,
// stock ops, HR & assets) — one route file per module in routes/modules/.
router.use(require('./modules'));

module.exports = router;
