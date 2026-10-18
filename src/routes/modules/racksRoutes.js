// Racks, shelves & stock locations (/api/racks, /api/locations). OWNER: Racks & Warehouse module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here.
//
// Permissions:
//   racks          view/create/edit/delete  rack & shelf management, labels
//   stock_putaway  view/create              warehouse list, put-away, move, home shelf
//   Reading racks / locations: racks OR stock_putaway (view).
//   Shelf picker + scan are also open to the screens that pick a shelf
//   (receiving, damages, adjustments, shop use, vendor returns...).
//
// Every call works on the shop's racks (meta.branch = the shop).
const express = require('express');
const { staff, can, handle } = require('./_access');
const racks = require('../../controller/store/racksController');
const locations = require('../../controller/store/locationsController');

const router = express.Router();

const VIEW = ['racks', 'stock_putaway'];
const PICKER = [
  ...VIEW,
  'goods_receiving',
  'purchase_orders',
  'damages',
  'stock_adjustments',
  'shop_use',
  'stock_movements',
  'vendor_returns',
  'consignment',
];

// ---- Racks & shelves (fixed paths before /racks/:id) ----
router.get('/racks', ...staff, can(VIEW, 'view'), handle(racks.list));
router.post('/racks/generate', ...staff, can('racks', 'create'), handle(racks.generate));
router.get('/racks/labels', ...staff, can('racks', 'view'), handle(racks.labels));
router.put('/racks/shelves/:shelfId', ...staff, can('racks', 'edit'), handle(racks.updateShelf));
router.patch('/racks/shelves/:shelfId', ...staff, can('racks', 'edit'), handle(racks.updateShelf));
router.delete('/racks/shelves/:shelfId', ...staff, can('racks', 'delete'), handle(racks.deleteShelf));
router.post('/racks', ...staff, can('racks', 'create'), handle(racks.create));
router.get('/racks/:id', ...staff, can(VIEW, 'view'), handle(racks.get));
router.put('/racks/:id', ...staff, can('racks', 'edit'), handle(racks.update));
router.patch('/racks/:id', ...staff, can('racks', 'edit'), handle(racks.update));
router.delete('/racks/:id', ...staff, can('racks', 'delete'), handle(racks.remove));
router.post('/racks/:id/shelves', ...staff, can('racks', 'create'), handle(racks.addShelf));

// ---- Locations ----
router.get('/locations/shelves', ...staff, can(PICKER, 'view'), handle(locations.shelves));
router.get('/locations/shelves/:shelfId', ...staff, can(VIEW, 'view'), handle(locations.shelf));
router.get('/locations/scan/:code', ...staff, can(PICKER, 'view'), handle(locations.scan));
router.get('/locations/products', ...staff, can(VIEW, 'view'), handle(locations.searchProducts));
router.get('/locations/products/:productId', ...staff, can(VIEW, 'view'), handle(locations.product));
router.get('/locations/warehouse', ...staff, can(VIEW, 'view'), handle(locations.warehouse));
router.get('/locations/activity', ...staff, can(VIEW, 'view'), handle(locations.activity));
router.post('/locations/putaway', ...staff, can('stock_putaway', 'create'), handle(locations.putaway));
router.post('/locations/putaway/bulk', ...staff, can('stock_putaway', 'create'), handle(locations.putaway));
router.post('/locations/move', ...staff, can('stock_putaway', 'create'), handle(locations.move));
router.post('/locations/home-shelf', ...staff, can('stock_putaway', 'create'), handle(locations.homeShelf));

module.exports = router;
