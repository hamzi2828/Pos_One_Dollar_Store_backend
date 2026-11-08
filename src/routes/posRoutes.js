// POS Routes — mounted at /api/pos from allRoutes.js
//
// Every route: auth (JWT) + loadAccess (role/permissions) + a permission:
//   pos        = the selling screen (products, customers, new sale, held carts)
//   pos_orders = POS order history (list, refund = edit, delete = delete)
//   desktop_pos = selling on the counter PC without internet (view = catalogue, create = upload sales)
// Sales figures (dashboard stats, sales chart, order history) are NOT for the
// plain `pos` cashier: they need dashboard / pos_orders / till_verify view
// (the shift salesman must not see today's sale before cash closing).
const express = require('express');
const router = express.Router();
const posController = require('../controller/posController');
const heldOrderController = require('../controller/heldOrderController');
const offlineSaleController = require('../controller/offlineSaleController');
const posActivityController = require('../controller/posActivityController');
const auth = require('../middleware/auth');
const { loadAccess, requirePermission } = require('../middleware/access');
const { uploadSingle } = require('../helper/upload');

// Permission check (any of the keys with this action). Tagged for the route tests.
const can = (keys, action = 'view') => {
  const mw = requirePermission(keys, action);
  mw.permission = { keys: [].concat(keys), action };
  return mw;
};

router.use(auth);
router.use(loadAccess);

// Products
router.get('/products', can('pos', 'view'), posController.getProducts);
router.get('/products/barcode/:barcode', can('pos', 'view'), posController.getProductByBarcode);
router.get('/categories', can('pos', 'view'), posController.getCategories);

// Customers (POS customer picker; also usable with the customers permission)
router.get('/customers', can(['pos', 'customers'], 'view'), posController.getCustomers);
router.get('/customers/search', can(['pos', 'customers'], 'view'), posController.searchCustomers);
router.post('/customers', can(['pos', 'customers'], 'create'), posController.createOrFindCustomer);
router.get('/customers/:id', can(['pos', 'customers', 'pos_orders'], 'view'), posController.getCustomerById);
router.get('/customers/:id/pending', can(['pos', 'pos_orders'], 'view'), posController.getCustomerPendingOrders);

// Who may see sales figures (not the plain cashier).
const SALES_VIEWERS = ['dashboard', 'pos_orders', 'till_verify'];

// Cart preview: the server prices the cart exactly like createOrder will.
router.post('/quote', can('pos', 'view'), posController.quote);

// Orders
router.post('/orders', can('pos', 'create'), posController.createOrder);
router.get('/orders', can(SALES_VIEWERS, 'view'), posController.getOrders);
router.get('/orders/pending', can(['pos', 'pos_orders'], 'view'), posController.getPendingOrders);
router.get('/orders/:id', can(['pos', ...SALES_VIEWERS], 'view'), posController.getOrderById);
router.post('/orders/:id/payment', can(['pos', 'pos_orders'], 'edit'), posController.addPayment);
router.post('/orders/:id/whatsapp', can(['pos', 'pos_orders'], 'create'), posController.resendWhatsapp); // resend slip
router.post('/orders/:id/discount', can('pos_orders', 'edit'), posController.giveDiscount); // discount after the sale
router.post('/orders/:id/payment-method', can('pos_orders', 'edit'), posController.changePaymentMethod); // fix cash / card / bank
router.post('/orders/:id/refund', can('pos_orders', 'edit'), posController.refundOrder); // puts stock back once
router.delete('/orders/:id', can('pos_orders', 'delete'), posController.deleteOrder);

// Dashboard (sales figures)
router.get('/dashboard/stats', can(SALES_VIEWERS, 'view'), posController.getDashboardStats);
router.get('/dashboard/sales-chart', can(SALES_VIEWERS, 'view'), posController.getSalesChart);

// Held orders (parked carts of the POS screen)
router.get('/held-orders', can('pos', 'view'), heldOrderController.getAllHeldOrders);
router.get('/held-orders/my', can('pos', 'view'), heldOrderController.getMyHeldOrders);
router.get('/held-orders/:id', can('pos', 'view'), heldOrderController.getHeldOrderById);
router.post('/held-orders', can('pos', 'create'), heldOrderController.createHeldOrder);
router.post('/held-orders/:id/retrieve', can('pos', 'create'), heldOrderController.retrieveHeldOrder);
router.delete('/held-orders/:id', can('pos', 'delete'), heldOrderController.deleteHeldOrder);
router.delete('/held-orders', can('pos', 'delete'), heldOrderController.clearAllHeldOrders);

// Offline selling on the counter PC (docs/OFFLINE_SALES.md).
// Uploading also needs `pos` create: offline sales are still sales.
router.get('/offline/catalog', can('desktop_pos', 'view'), offlineSaleController.catalog);
router.post('/offline/orders', can('desktop_pos', 'create'), can('pos', 'create'), offlineSaleController.uploadOrders);

// Activity log of the selling screen (scans / clicks per cart).
// The cashier only writes it; the order history viewers read it.
router.post('/activity', can('pos', 'view'), posActivityController.record);
router.get('/activity', can('pos_orders', 'view'), posActivityController.list);
router.get('/activity/by-order/:orderId', can('pos_orders', 'view'), posActivityController.getByOrder);
router.get('/activity/:cartId', can('pos_orders', 'view'), posActivityController.getByCart);

// Uploads
router.post('/upload/screenshot', can('pos', 'create'), uploadSingle('screenshot'), posController.uploadScreenshot);

module.exports = router;
