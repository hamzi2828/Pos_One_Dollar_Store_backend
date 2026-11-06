// Loans we have taken and pay back (/api/loans). Permission `loans` (Finance).
const express = require('express');
const { staff, can, handle } = require('./_access');
const svc = require('../../services/loanService');
const { documentUploadArray } = require('../../helper/upload');
const { saveUploads } = require('../../helper/storeUpload');

const router = express.Router();

// Slip uploads (photo / PDF): wrong type or too big -> 400.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));

// Saved people we borrow from (dropdown + "+ add").
router.get('/loan-lenders', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.people() });
}));
router.post('/loan-lenders', ...staff, can('loans', 'create'), handle(async (req, res) => {
  res.status(201).json({ success: true, data: await svc.addPerson(req.body || {}, { user: req.user }), message: 'Saved' });
}));

router.get('/loans/lenders', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.lenders() });
}));

router.get('/loans', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, ...(await svc.list(req.query || {})) });
}));

router.get('/loans/:id', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.get(req.params.id) });
}));

router.post('/loans', ...staff, can('loans', 'create'), upload(documentUploadArray('slips', 5)), handle(async (req, res) => {
  const attachments = await saveUploads(req, 'loans');
  res.status(201).json({ success: true, data: await svc.create(req.body || {}, { user: req.user, attachments }), message: 'Loan added' });
}));

router.post('/loans/:id/slips', ...staff, can('loans', 'edit'), upload(documentUploadArray('slips', 5)), handle(async (req, res) => {
  const attachments = await saveUploads(req, 'loans');
  res.json({ success: true, data: await svc.addSlips(req.params.id, attachments), message: 'Slip added' });
}));

router.put('/loans/:id', ...staff, can('loans', 'edit'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.update(req.params.id, req.body || {}), message: 'Loan saved' });
}));

router.delete('/loans/:id', ...staff, can('loans', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.remove(req.params.id, { user: req.user }), message: 'Loan deleted' });
}));

// Paying the loan back in parts.
router.post('/loans/:id/repayments', ...staff, can('loans', 'edit'), upload(documentUploadArray('slips', 5)), handle(async (req, res) => {
  const attachments = await saveUploads(req, 'loans');
  res.status(201).json({ success: true, data: await svc.addRepayment(req.params.id, req.body || {}, { user: req.user, attachments }), message: 'Payment saved' });
}));

router.delete('/loans/:id/repayments/:repaymentId', ...staff, can('loans', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.removeRepayment(req.params.id, req.params.repaymentId), message: 'Payment removed' });
}));

module.exports = router;
