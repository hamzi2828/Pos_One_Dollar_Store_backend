// POS Routes — mounted at /api/pos from allRoutes.js
//
// Every route: auth (JWT) + loadAccess (role/branch/permissions) + a permission:
//   pos        = the selling screen (products, customers, new sale, held carts)
//   pos_orders = POS order history (list, refund = edit, delete = delete)
// Branch scoping (which branch's stock/orders) happens in the controllers via
// req.access (branchFilter / resolveWriteBranch).
const express = require('express');
const router = express.Router();
const posController = require('../controller/posController');
const heldOrderController = require('../controller/heldOrderController');
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
router.post('/customers/:id/cars', can(['pos', 'customers'], 'create'), posController.addCustomerCar);
router.get('/customers/:id', can(['pos', 'customers', 'pos_orders'], 'view'), posController.getCustomerById);
router.get('/customers/:id/pending', can(['pos', 'pos_orders'], 'view'), posController.getCustomerPendingOrders);

// Orders
router.post('/orders', can('pos', 'create'), posController.createOrder);
router.get('/orders', can('pos_orders', 'view'), posController.getOrders);
router.get('/orders/pending', can(['pos', 'pos_orders'], 'view'), posController.getPendingOrders);
router.get('/orders/:id', can(['pos', 'pos_orders'], 'view'), posController.getOrderById);
router.post('/orders/:id/payment', can(['pos', 'pos_orders'], 'edit'), posController.addPayment);
router.post('/orders/:id/refund', can('pos_orders', 'edit'), posController.refundOrder); // puts stock back once
router.delete('/orders/:id', can('pos_orders', 'delete'), posController.deleteOrder);

// Dashboard
router.get('/dashboard/stats', can(['pos', 'dashboard'], 'view'), posController.getDashboardStats);
router.get('/dashboard/sales-chart', can(['pos', 'dashboard'], 'view'), posController.getSalesChart);

// Held orders (parked carts of the POS screen)
router.get('/held-orders', can('pos', 'view'), heldOrderController.getAllHeldOrders);
router.get('/held-orders/my', can('pos', 'view'), heldOrderController.getMyHeldOrders);
router.get('/held-orders/:id', can('pos', 'view'), heldOrderController.getHeldOrderById);
router.post('/held-orders', can('pos', 'create'), heldOrderController.createHeldOrder);
router.post('/held-orders/:id/retrieve', can('pos', 'create'), heldOrderController.retrieveHeldOrder);
router.delete('/held-orders/:id', can('pos', 'delete'), heldOrderController.deleteHeldOrder);
router.delete('/held-orders', can('pos', 'delete'), heldOrderController.clearAllHeldOrders);

// Uploads
router.post('/upload/screenshot', can('pos', 'create'), uploadSingle('screenshot'), posController.uploadScreenshot);

module.exports = router;
