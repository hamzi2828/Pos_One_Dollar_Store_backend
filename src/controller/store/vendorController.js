// src/controller/store/vendorController.js
// /api/vendors — vendor list / profile / CRUD, ledger statement (+ CSV),
// products bought, manual adjustments. Logic: services/vendors/vendorService.js.
const vendorService = require('../../services/vendors/vendorService');
const productLookup = require('../../services/vendors/productLookup');

module.exports = {
  async list(req, res) {
    const out = await vendorService.list(req.query);
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await vendorService.getById(req.params.id) });
  },

  async create(req, res) {
    const data = await vendorService.create(req.body || {}, { userId: req.access.userId });
    res.status(201).json({ success: true, data, message: `Vendor ${data.name} added` });
  },

  async update(req, res) {
    const data = await vendorService.update(req.params.id, req.body || {}, { userId: req.access.userId });
    res.json({ success: true, data, message: 'Vendor saved' });
  },

  async setStatus(req, res) {
    const isActive = req.body ? req.body.isActive : undefined;
    const data = await vendorService.setActive(req.params.id, isActive, { userId: req.access.userId });
    res.json({ success: true, data, message: data.isActive ? 'Vendor activated' : 'Vendor deactivated' });
  },

  async remove(req, res) {
    const data = await vendorService.remove(req.params.id, { userId: req.access.userId });
    res.json({ success: true, data, message: 'Vendor deleted' });
  },

  async ledger(req, res) {
    res.json({ success: true, data: await vendorService.statement(req.params.id, req.query) });
  },

  async ledgerExport(req, res) {
    const { csv, filename } = await vendorService.statementCsv(req.params.id, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  },

  async products(req, res) {
    const out = await vendorService.productsBought(req.params.id, req, req.query);
    res.json({ success: true, ...out });
  },

  async addAdjustment(req, res) {
    const data = await vendorService.postAdjustment(req.params.id, req.body || {}, {
      userId: req.access.userId,
      branchId: req.access.branchId || null,
    });
    res.status(201).json({ success: true, data, message: 'Adjustment posted' });
  },

  async voidEntry(req, res) {
    const data = await vendorService.voidManualEntry(req.params.id, req.params.entryId, req.body || {}, { userId: req.access.userId });
    res.json({ success: true, data, message: 'Ledger row voided' });
  },

  /** GET /api/vendor-products/search — product picker of the return / consignment screens. */
  async productSearch(req, res) {
    res.json({ success: true, data: await productLookup.search(req, req.query) });
  },
};
