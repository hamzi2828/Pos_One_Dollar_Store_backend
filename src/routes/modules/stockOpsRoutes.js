// Damages, shop use, adjustments, movements, product insights (/api/damages, /api/shop-use, /api/stock-adjustments, /api/stock-movements, /api/product-insights). OWNER: Stock operations module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access');
const { uploadArray } = require('../../helper/upload');
const damages = require('../../controller/store/damageController');
const shopUse = require('../../controller/store/shopUseController');
const adjustments = require('../../controller/store/stockAdjustmentController');
const movements = require('../../controller/store/stockMovementController');
const insights = require('../../controller/store/productInsightController');

const router = express.Router();

// ---- Scan / search a unit (damage, shop-use and count screens) ----
const STOCK_OPS_READ = ['damages', 'shop_use', 'stock_adjustments', 'stock_movements', 'report_stock_movement'];
router.get('/stock-ops/lookup/:code', ...staff, can(STOCK_OPS_READ, 'view'), handle(insights.lookup));
router.get('/stock-ops/products', ...staff, can(STOCK_OPS_READ, 'view'), handle(insights.search));

// ---- Damages (edit = approve / reject) ----
router.get('/damages', ...staff, can('damages', 'view'), handle(damages.list));
router.get('/damages/daily', ...staff, can('damages', 'view'), handle(damages.daily));
router.get('/damages/daily/export', ...staff, can('damages', 'export'), handle(damages.dailyExport));
router.get('/damages/settings', ...staff, can('damages', 'view'), handle(damages.getSettings));
router.put('/damages/settings', ...staff, superAdmin, handle(damages.setSettings));
router.get('/damages/:id', ...staff, can('damages', 'view'), handle(damages.get));
router.post('/damages', ...staff, can('damages', 'create'), uploadArray('photos', 5), handle(damages.create));
router.post('/damages/:id/approve', ...staff, can('damages', 'edit'), handle(damages.approve));
router.post('/damages/:id/reject', ...staff, can('damages', 'edit'), handle(damages.reject));
router.delete('/damages/:id', ...staff, can('damages', 'delete'), handle(damages.remove));

// ---- Shop use (delete = void) ----
router.get('/shop-use', ...staff, can('shop_use', 'view'), handle(shopUse.list));
router.get('/shop-use/:id', ...staff, can('shop_use', 'view'), handle(shopUse.get));
router.post('/shop-use', ...staff, can('shop_use', 'create'), handle(shopUse.create));
router.post('/shop-use/:id/void', ...staff, can('shop_use', 'delete'), handle(shopUse.void));
router.delete('/shop-use/:id', ...staff, can('shop_use', 'delete'), handle(shopUse.void));

// ---- Stock adjustments / counts (the role only has view + create) ----
router.get('/stock-adjustments', ...staff, can('stock_adjustments', 'view'), handle(adjustments.list));
router.get('/stock-adjustments/:id', ...staff, can('stock_adjustments', 'view'), handle(adjustments.get));
router.post('/stock-adjustments', ...staff, can('stock_adjustments', 'create'), handle(adjustments.create));
router.put('/stock-adjustments/:id', ...staff, can('stock_adjustments', 'create'), handle(adjustments.update));
router.post('/stock-adjustments/:id/apply', ...staff, can('stock_adjustments', 'create'), handle(adjustments.apply));
router.post('/stock-adjustments/:id/cancel', ...staff, can('stock_adjustments', 'create'), handle(adjustments.cancel));

// ---- Stock movement ledger + product timeline ----
router.get('/stock-movements', ...staff, can('stock_movements', 'view'), handle(movements.list));
router.get('/stock-movements/export', ...staff, can('stock_movements', 'export'), handle(movements.exportCsv));
router.get('/stock-movements/timeline/:productId', ...staff, can(['report_stock_movement', 'stock_movements'], 'view'), handle(movements.timeline));

// ---- Product insight panel ----
router.get('/product-insights/:productId', ...staff, can(['products', 'pos', 'stock_movements', 'report_stock_movement'], 'view'), handle(insights.insights));

module.exports = router;
