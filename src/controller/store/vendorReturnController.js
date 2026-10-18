// src/controller/store/vendorReturnController.js
// /api/vendor-returns — draft, edit, complete (stock out + debit note), cancel.
// Logic: services/vendors/returnService.js.
const returnService = require('../../services/vendors/returnService');

module.exports = {
  async list(req, res) {
    const out = await returnService.list(req, req.query);
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await returnService.getById(req, req.params.id) });
  },

  async create(req, res) {
    const data = await returnService.create(req, req.body || {});
    const done = data.status === 'completed';
    res.status(201).json({ success: true, data, message: done ? `${data.returnNo} completed` : `${data.returnNo} saved as draft` });
  },

  async update(req, res) {
    const data = await returnService.update(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: 'Return saved' });
  },

  async complete(req, res) {
    const data = await returnService.complete(req, req.params.id);
    res.json({ success: true, data, message: `${data.returnNo} completed — stock taken out, debit note Rs ${data.total}` });
  },

  async cancel(req, res) {
    const data = await returnService.cancel(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: `${data.returnNo} cancelled` });
  },
};
