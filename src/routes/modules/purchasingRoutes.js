// Purchase orders, builty & goods receiving (/api/purchase-orders, /api/receiving). OWNER: Purchasing module.
// Mounted at /api by routes/modules/index.js.
//
// Permissions: `purchase_orders` (view / create / edit; cancel = delete) and
// `goods_receiving` (view / edit). Every query is branch scoped (req.access).
// Permission checks run BEFORE the upload middleware.
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access');
const { uploadArray } = require('../../helper/upload');
const po = require('../../controller/store/purchaseOrderController');
const grn = require('../../controller/store/receivingController');

const router = express.Router();

const PO = 'purchase_orders';
const GRN = 'goods_receiving';

// ----- Purchase orders (static paths before /:id)
router.get('/purchase-orders/meta', ...staff, can(PO, 'view'), handle(po.meta));
// Owner-only rules (e.g. someone other than the buyer must receive the goods).
router.get('/purchase-orders/settings', ...staff, can([PO, GRN], 'view'), handle(po.settings));
router.put('/purchase-orders/settings', ...staff, superAdmin, handle(po.updateSettings));
router.get('/purchase-orders/product-search', ...staff, can(PO, 'view'), handle(po.productSearch));
router.get('/purchase-orders', ...staff, can(PO, 'view'), handle(po.list));
router.post('/purchase-orders', ...staff, can(PO, 'create'), handle(po.create));
router.get('/purchase-orders/:id', ...staff, can(PO, 'view'), handle(po.get));
router.put('/purchase-orders/:id', ...staff, can(PO, 'edit'), handle(po.update));
router.get('/purchase-orders/:id/costing', ...staff, can(PO, 'view'), handle(po.costing));

// Vendor bills (multipart: `photos` up to 5 per request) and their items
router.post('/purchase-orders/:id/bills', ...staff, can(PO, 'edit'), uploadArray('photos', 5), handle(po.addBill));
router.put('/purchase-orders/:id/bills/:billId', ...staff, can(PO, 'edit'), uploadArray('photos', 5), handle(po.updateBill));
router.delete('/purchase-orders/:id/bills/:billId', ...staff, can(PO, 'edit'), handle(po.removeBill));
router.post('/purchase-orders/:id/bills/:billId/items', ...staff, can(PO, 'edit'), handle(po.addItems));
router.post('/purchase-orders/:id/bills/:billId/new-product', ...staff, can(PO, 'edit'), handle(po.addNewProduct));
router.put('/purchase-orders/:id/bills/:billId/items/:itemId', ...staff, can(PO, 'edit'), handle(po.updateItem));
router.delete('/purchase-orders/:id/bills/:billId/items/:itemId', ...staff, can(PO, 'edit'), handle(po.removeItem));

// Trip charges (car rent, builty freight, loading, landing, misc...)
router.post('/purchase-orders/:id/charges', ...staff, can(PO, 'edit'), handle(po.addCharge));
router.put('/purchase-orders/:id/charges/:chargeId', ...staff, can(PO, 'edit'), handle(po.updateCharge));
router.delete('/purchase-orders/:id/charges/:chargeId', ...staff, can(PO, 'edit'), handle(po.removeCharge));

// Workflow (multipart builty photos: `photos`)
router.post('/purchase-orders/:id/close', ...staff, can(PO, 'edit'), uploadArray('photos', 5), handle(po.close));
router.post('/purchase-orders/:id/reopen', ...staff, can(PO, 'edit'), handle(po.reopen));
router.post('/purchase-orders/:id/cancel', ...staff, can(PO, 'delete'), handle(po.cancel));

// ----- Goods receiving (GRN)
router.get('/receiving', ...staff, can(GRN, 'view'), handle(grn.list));
router.get('/receiving/:id', ...staff, can(GRN, 'view'), handle(grn.get));
router.post('/receiving/:id/start', ...staff, can(GRN, 'edit'), handle(grn.start));
router.put('/receiving/:id/lines', ...staff, can(GRN, 'edit'), handle(grn.saveCounts));
router.post('/receiving/:id/scan', ...staff, can(GRN, 'edit'), handle(grn.scan));
router.post('/receiving/:id/photos', ...staff, can(GRN, 'edit'), uploadArray('photos', 5), handle(grn.addPhotos));
router.post('/receiving/:id/complete', ...staff, can(GRN, 'edit'), handle(grn.complete));
// Simple buying flow: check boxes → enter goods (stock in per entry, shelf optional) → finish
router.post('/receiving/:id/boxes', ...staff, can(GRN, 'edit'), handle(grn.checkBoxes));
router.post('/receiving/:id/boxes/done', ...staff, can(GRN, 'edit'), handle(grn.markBox));
router.get('/receiving/:id/lookup', ...staff, can(GRN, 'edit'), handle(grn.lookup));
router.post('/receiving/:id/new-product', ...staff, can(GRN, 'edit'), handle(grn.newProduct));
router.post('/receiving/:id/entries', ...staff, can(GRN, 'edit'), handle(grn.addEntry));
router.delete('/receiving/:id/entries/:entryId', ...staff, can(GRN, 'edit'), handle(grn.undoEntry));

module.exports = router;
