// Investment: money put into the shop, one entry per bill, each by a partner,
// paid in parts, with the running total (/api/investments, /api/investment-partners).
// Permission `investments` (owner by default).
const express = require('express');
const { staff, can, handle } = require('./_access');
const { documentUploadArray } = require('../../helper/upload');
const { saveUploads } = require('../../helper/storeUpload');
const svc = require('../../services/investmentService');

const router = express.Router();

// Upload errors (wrong type / too big) -> 400 instead of a crash.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));

// ---- Partners (who put the money in) ----
router.get('/investment-partners', ...staff, can('investments', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.listPartners() });
}));

router.post('/investment-partners', ...staff, can('investments', 'create'), handle(async (req, res) => {
  res.status(201).json({ success: true, data: await svc.createPartner(req.body || {}, { userId: req.access.userId }), message: 'Partner added' });
}));

router.put('/investment-partners/:id', ...staff, can('investments', 'edit'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.updatePartner(req.params.id, req.body || {}, { userId: req.access.userId }), message: 'Partner saved' });
}));

router.delete('/investment-partners/:id', ...staff, can('investments', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.removePartner(req.params.id, { userId: req.access.userId }), message: 'Partner removed' });
}));

// ---- Investment bills ----
router.get('/investments', ...staff, can('investments', 'view'), handle(async (req, res) => {
  res.json({ success: true, ...(await svc.list(req.query)) });
}));

router.get('/investments/export', ...staff, can('investments', 'export'), handle(async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="investments.csv"');
  res.send(await svc.exportCsv(req.query));
}));

router.get('/investments/:id', ...staff, can('investments', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.get(req.params.id) });
}));

router.post('/investments', ...staff, can('investments', 'create'), upload(documentUploadArray('bills', 5)), handle(async (req, res) => {
  const attachments = await saveUploads(req, 'investments');
  res.status(201).json({ success: true, data: await svc.create(req.body, { userId: req.access.userId, attachments }) });
}));

router.put('/investments/:id', ...staff, can('investments', 'edit'), upload(documentUploadArray('bills', 5)), handle(async (req, res) => {
  const attachments = await saveUploads(req, 'investments');
  res.json({ success: true, data: await svc.update(req.params.id, req.body, { userId: req.access.userId, attachments }) });
}));

router.delete('/investments/:id', ...staff, can('investments', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.remove(req.params.id, { userId: req.access.userId }) });
}));

// ---- Part payments on a bill (pay what is left in parts; undo a wrong one) ----
router.post('/investments/:id/payments', ...staff, can('investments', 'edit'), handle(async (req, res) => {
  const data = await svc.addPayment(req.params.id, req.body || {}, { userId: req.access.userId });
  res.status(201).json({ success: true, data, message: 'Payment saved' });
}));

router.delete('/investments/:id/payments/:paymentId', ...staff, can('investments', 'delete'), handle(async (req, res) => {
  const data = await svc.removePayment(req.params.id, req.params.paymentId, { userId: req.access.userId });
  res.json({ success: true, data, message: 'Payment removed' });
}));

module.exports = router;
