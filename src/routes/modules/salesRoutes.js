// Discount rules & price tiers (/api/discount-rules, /api/price-tiers). OWNER: POS & Pricing module. (POS sale routes stay in routes/posRoutes.js.)
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
const express = require('express');
const { staff, can, handle } = require('./_access');
const rules = require('../../controller/store/discountRuleController');
const tiers = require('../../controller/store/priceTierController');

const router = express.Router();

// ----- Bill discount rules (permission: discounts)
router.get('/discount-rules', ...staff, can('discounts', 'view'), handle(rules.list));
router.get('/discount-rules/preview', ...staff, can('discounts', 'view'), handle(rules.preview));
router.get('/discount-rules/:id', ...staff, can('discounts', 'view'), handle(rules.get));
router.post('/discount-rules', ...staff, can('discounts', 'create'), handle(rules.create));
router.put('/discount-rules/:id', ...staff, can('discounts', 'edit'), handle(rules.update));
router.patch('/discount-rules/:id/active', ...staff, can('discounts', 'edit'), handle(rules.setActive));
router.delete('/discount-rules/:id', ...staff, can('discounts', 'delete'), handle(rules.remove));

// ----- Price tiers / dollar-store price points (permission: price_tiers)
router.get('/price-tiers', ...staff, can('price_tiers', 'view'), handle(tiers.list));
router.get('/price-tiers/candidates', ...staff, can('price_tiers', 'view'), handle(tiers.candidates));
// The product form shows the tier select to anyone who can open products.
router.get('/price-tiers/product/:productId', ...staff, can(['price_tiers', 'products'], 'view'), handle(tiers.ofProduct));
router.get('/price-tiers/:id', ...staff, can('price_tiers', 'view'), handle(tiers.detail));
router.post('/price-tiers', ...staff, can('price_tiers', 'create'), handle(tiers.create));
router.post('/price-tiers/unassign', ...staff, can('price_tiers', 'edit'), handle(tiers.unassign));
router.post('/price-tiers/:id/assign', ...staff, can('price_tiers', 'edit'), handle(tiers.assign));
router.put('/price-tiers/:id', ...staff, can('price_tiers', 'edit'), handle(tiers.update));
router.delete('/price-tiers/:id', ...staff, can('price_tiers', 'delete'), handle(tiers.remove));

module.exports = router;
