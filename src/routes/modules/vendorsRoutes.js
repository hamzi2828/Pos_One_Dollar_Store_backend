// Vendors, ledger, payments, consignment, vendor returns (/api/vendors, /api/vendor-payments, /api/consignments, /api/vendor-returns). OWNER: Vendors module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
//
// Payments, returns, consignment documents and stock are stamped with the
// shop's branch id (writes: resolveWriteBranch).
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access'); // eslint-disable-line no-unused-vars
const { uploadArray } = require('../../helper/upload');
const vendors = require('../../controller/store/vendorController');
const payments = require('../../controller/store/vendorPaymentController');
const returns = require('../../controller/store/vendorReturnController');
const consignment = require('../../controller/store/consignmentController');

const router = express.Router();

// Vendor pickers are used by purchasing, receiving, payments, returns and consignment.
const VENDOR_READ = ['vendors', 'vendor_payments', 'vendor_returns', 'consignment', 'purchase_orders', 'goods_receiving'];
const PRODUCT_PICK = ['vendor_returns', 'consignment', 'vendors'];

// Receipt photos (optional). Bad files -> 400 JSON instead of an HTML error page.
const photos = (field, max) => {
  const mw = uploadArray(field, max);
  return (req, res, next) =>
    mw(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message || 'Upload failed' }) : next()));
};

// ----- Vendors & ledger -----
router.get('/vendors', ...staff, can(VENDOR_READ, 'view'), handle(vendors.list));
router.post('/vendors', ...staff, can('vendors', 'create'), handle(vendors.create));
router.get('/vendors/:id', ...staff, can(VENDOR_READ, 'view'), handle(vendors.get));
router.put('/vendors/:id', ...staff, can('vendors', 'edit'), handle(vendors.update));
router.patch('/vendors/:id/status', ...staff, can('vendors', 'edit'), handle(vendors.setStatus));
router.delete('/vendors/:id', ...staff, can('vendors', 'delete'), handle(vendors.remove));
router.get('/vendors/:id/ledger', ...staff, can('vendors', 'view'), handle(vendors.ledger));
router.get('/vendors/:id/ledger/export', ...staff, can('vendors', 'export'), handle(vendors.ledgerExport));
router.post('/vendors/:id/ledger/:entryId/void', ...staff, can('vendors', 'edit'), handle(vendors.voidEntry));
router.post('/vendors/:id/adjustments', ...staff, can('vendors', 'edit'), handle(vendors.addAdjustment));
router.get('/vendors/:id/products', ...staff, can('vendors', 'view'), handle(vendors.products));

// Product picker for returns / consignment (stock in the working branch + vendor's last price).
router.get('/vendor-products/search', ...staff, can(PRODUCT_PICK, 'view'), handle(vendors.productSearch));

// ----- Vendor payments -----
router.get('/vendor-payments', ...staff, can('vendor_payments', 'view'), handle(payments.list));
router.get('/vendor-payments/banks', ...staff, can('vendor_payments', 'view'), handle(payments.banks));
router.get('/vendor-payments/:id', ...staff, can('vendor_payments', 'view'), handle(payments.get));
router.post('/vendor-payments', ...staff, can('vendor_payments', 'create'), photos('attachments', 5), handle(payments.create));
router.post('/vendor-payments/:id/void', ...staff, can('vendor_payments', 'delete'), handle(payments.void));

// ----- Vendor returns (debit notes) -----
router.get('/vendor-returns', ...staff, can('vendor_returns', 'view'), handle(returns.list));
router.get('/vendor-returns/:id', ...staff, can('vendor_returns', 'view'), handle(returns.get));
router.post('/vendor-returns', ...staff, can('vendor_returns', 'create'), handle(returns.create));
router.put('/vendor-returns/:id', ...staff, can('vendor_returns', 'edit'), handle(returns.update));
router.post('/vendor-returns/:id/complete', ...staff, can('vendor_returns', 'edit'), handle(returns.complete));
router.post('/vendor-returns/:id/cancel', ...staff, can('vendor_returns', 'delete'), handle(returns.cancel));

// ----- Consignment (sale or return) -----
router.get('/consignments/summary', ...staff, can('consignment', 'view'), handle(consignment.summary));
router.get('/consignments/vendors/:vendorId/stock', ...staff, can('consignment', 'view'), handle(consignment.vendorStock));
router.get('/consignments/settlements', ...staff, can('consignment', 'view'), handle(consignment.listSettlements));
router.get('/consignments/settlements/:id', ...staff, can('consignment', 'view'), handle(consignment.getSettlement));
router.post('/consignments/settlements', ...staff, can('consignment', 'create'), handle(consignment.settle));
router.post('/consignments/settlements/:id/void', ...staff, can('consignment', 'delete'), handle(consignment.voidSettlement));
router.post('/consignments/returns', ...staff, can('consignment', 'create'), handle(consignment.returnItems));
router.get('/consignments', ...staff, can('consignment', 'view'), handle(consignment.list));
router.post('/consignments', ...staff, can('consignment', 'create'), handle(consignment.intake));
router.get('/consignments/:id', ...staff, can('consignment', 'view'), handle(consignment.get));
router.post('/consignments/:id/post', ...staff, can('consignment', 'create'), handle(consignment.retryPost));

module.exports = router;
