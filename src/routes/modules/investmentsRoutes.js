// Investment: money put into the shop, one entry per bill, with the running total.
// (/api/investments). Permission `investments` (owner by default).
const express = require('express');
const { staff, can, handle } = require('./_access');
const { documentUploadArray } = require('../../helper/upload');
const { saveUploads } = require('../../helper/storeUpload');
const svc = require('../../services/investmentService');

const router = express.Router();

// Upload errors (wrong type / too big) -> 400 instead of a crash.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));

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

module.exports = router;
