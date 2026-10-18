// src/controller/store/consignmentController.js
// /api/consignments — sale-or-return stock: overview, vendor visit sheet,
// intake, give-back (swap), settlements (+ pay now), void.
// Logic: services/vendors/consignmentService.js.
const consignmentService = require('../../services/vendors/consignmentService');

module.exports = {
  async summary(req, res) {
    const out = await consignmentService.summary(req);
    res.json({ success: true, ...out });
  },

  async vendorStock(req, res) {
    res.json({ success: true, data: await consignmentService.vendorStock(req, req.params.vendorId) });
  },

  async list(req, res) {
    const out = await consignmentService.list(req, req.query);
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await consignmentService.getDoc(req, req.params.id) });
  },

  async intake(req, res) {
    const data = await consignmentService.intake(req, req.body || {});
    res.status(201).json({ success: true, data, message: `${data.consignmentNo}: ${data.totalQty} pcs received on consignment` });
  },

  async returnItems(req, res) {
    const data = await consignmentService.returnItems(req, req.body || {});
    res.status(201).json({ success: true, data, message: `${data.consignmentNo}: ${data.totalQty} pcs given back` });
  },

  async retryPost(req, res) {
    const data = await consignmentService.retryPost(req, req.params.id);
    res.json({ success: true, data, message: `${data.consignmentNo} posted` });
  },

  async listSettlements(req, res) {
    const out = await consignmentService.listSettlements(req, req.query);
    res.json({ success: true, ...out });
  },

  async getSettlement(req, res) {
    res.json({ success: true, data: await consignmentService.getSettlement(req, req.params.id) });
  },

  async settle(req, res) {
    const data = await consignmentService.settle(req, req.body || {});
    res.status(201).json({ success: true, data, message: `${data.settlementNo}: Rs ${data.total} now payable` });
  },

  async voidSettlement(req, res) {
    const data = await consignmentService.voidSettlement(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: `${data.settlementNo} voided` });
  },
};
