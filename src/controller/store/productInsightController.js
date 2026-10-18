// src/controller/store/productInsightController.js
// /api/product-insights/:productId — price history, vendors + cheaper-vendor
// recommendation, stock & shelves, sales (ProductInsightPanel).
// /api/stock-ops/lookup/:code and /api/stock-ops/products — scan / search a unit
// for the damage, shop-use and count screens (pieces in the shop).
const { resolveWriteBranch } = require('../../middleware/access');
const insightService = require('../../services/stockops/insightService');
const productLookup = require('../../services/stockops/productLookup');

module.exports = {
  async insights(req, res) {
    // Stock / sales / movements of the shop.
    const data = await insightService.getInsights(req.params.productId, {
      variantId: req.query.variantId || null,
      branchId: req.access.branchId || null,
    });
    res.json({ success: true, data });
  },

  async lookup(req, res) {
    const branchId = await resolveWriteBranch(req);
    res.json({ success: true, data: await productLookup.lookupCode(req.params.code, branchId) });
  },

  async search(req, res) {
    const branchId = await resolveWriteBranch(req);
    const data = await productLookup.searchUnits(req.query.search || req.query.q, branchId, { limit: Number(req.query.limit) || 15 });
    res.json({ success: true, data });
  },
};
