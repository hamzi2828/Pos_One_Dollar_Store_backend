// src/controller/store/stockMovementController.js
// /api/stock-movements — ledger list / CSV and the product timeline.
// Logic lives in services/stockops/movementLedgerService.js.
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');
const ledger = require('../../services/stockops/movementLedgerService');
const { sendCsv } = require('../../services/stockops/common');

module.exports = {
  async list(req, res) {
    const out = await ledger.list(req.query, branchFilter(req));
    res.json({ success: true, ...out });
  },

  async exportCsv(req, res) {
    const { filename, csv } = await ledger.csv(req.query, branchFilter(req));
    sendCsv(res, filename, csv);
  },

  // The shop.
  async timeline(req, res) {
    const branchId = req.access.branchId || (await resolveWriteBranch(req));
    const data = await ledger.timeline(req.params.productId, { variantId: req.query.variantId || null, branchId });
    res.json({ success: true, data });
  },
};
