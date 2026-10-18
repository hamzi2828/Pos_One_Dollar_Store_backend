// src/controller/store/shopUseController.js
// /api/shop-use — items taken from stock for the shop (posted as an expense).
// Logic lives in services/stockops/shopUseService.js.
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');
const shopUseService = require('../../services/stockops/shopUseService');

const scope = (req) => branchFilter(req);

module.exports = {
  async list(req, res) {
    const out = await shopUseService.list(req.query, scope(req));
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await shopUseService.getOne(req.params.id, scope(req)) });
  },

  async create(req, res) {
    const branchId = await resolveWriteBranch(req);
    const doc = await shopUseService.create(req.body || {}, { branchId, userId: req.access.userId });
    res.status(201).json({
      success: true,
      data: await shopUseService.getOne(doc._id),
      message: `${doc.shopUseNo} saved — Rs ${doc.totalCost} added to expenses`,
    });
  },

  async void(req, res) {
    const reason = (req.body && req.body.reason) || req.query.reason || '';
    const doc = await shopUseService.voidRecord(req.params.id, { userId: req.access.userId, scope: scope(req), reason });
    res.json({ success: true, data: await shopUseService.getOne(doc._id), message: `${doc.shopUseNo} voided — stock put back` });
  },
};
