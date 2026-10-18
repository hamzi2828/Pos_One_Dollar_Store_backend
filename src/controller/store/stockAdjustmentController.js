// src/controller/store/stockAdjustmentController.js
// /api/stock-adjustments — stock count sheets and manual corrections.
// Logic lives in services/stockops/adjustmentService.js.
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');
const adjustmentService = require('../../services/stockops/adjustmentService');

const scope = (req) => branchFilter(req);
const respond = async (res, doc, status = 200, message) =>
  res.status(status).json({ success: true, data: await adjustmentService.getOne(doc._id), ...(message ? { message } : {}) });

module.exports = {
  async list(req, res) {
    const out = await adjustmentService.list(req.query, scope(req));
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await adjustmentService.getOne(req.params.id, scope(req)) });
  },

  async create(req, res) {
    const branchId = await resolveWriteBranch(req);
    const doc = await adjustmentService.create(req.body || {}, { branchId, userId: req.access.userId });
    await respond(res, doc, 201, doc.status === 'applied' ? `${doc.adjNo} applied` : `${doc.adjNo} saved as draft`);
  },

  async update(req, res) {
    const doc = await adjustmentService.update(req.params.id, req.body || {}, { userId: req.access.userId, scope: scope(req) });
    await respond(res, doc, 200, doc.status === 'applied' ? `${doc.adjNo} applied` : `${doc.adjNo} saved`);
  },

  async apply(req, res) {
    const doc = await adjustmentService.apply(req.params.id, { userId: req.access.userId, scope: scope(req) });
    await respond(res, doc, 200, `${doc.adjNo} applied`);
  },

  async cancel(req, res) {
    const doc = await adjustmentService.cancel(req.params.id, { userId: req.access.userId, scope: scope(req) });
    await respond(res, doc, 200, `${doc.adjNo} cancelled`);
  },
};
