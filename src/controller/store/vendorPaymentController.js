// src/controller/store/vendorPaymentController.js
// /api/vendor-payments — record (with receipt photos), list + summary, void.
// Logic: services/vendors/paymentService.js.
const { saveUploads } = require('../../helper/storeUpload');
const paymentService = require('../../services/vendors/paymentService');

module.exports = {
  async list(req, res) {
    const out = await paymentService.list(req, req.query);
    res.json({ success: true, ...out });
  },

  async get(req, res) {
    res.json({ success: true, data: await paymentService.getById(req, req.params.id) });
  },

  async create(req, res) {
    const attachments = await saveUploads(req, 'vendors/payments');
    const data = await paymentService.create(req, req.body || {}, attachments);
    res.status(201).json({ success: true, data, message: `Payment ${data.paymentNo} recorded` });
  },

  async void(req, res) {
    const data = await paymentService.voidPayment(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: `Payment ${data.paymentNo} voided` });
  },

  async banks(req, res) {
    res.json({ success: true, data: await paymentService.bankOptions() });
  },
};
