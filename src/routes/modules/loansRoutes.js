// Loans we have taken and pay back (/api/loans). Permission `loans` (Finance).
const express = require('express');
const { staff, can, handle } = require('./_access');
const svc = require('../../services/loanService');

const router = express.Router();

router.get('/loans/lenders', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.lenders() });
}));

router.get('/loans', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, ...(await svc.list(req.query || {})) });
}));

router.get('/loans/:id', ...staff, can('loans', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.get(req.params.id) });
}));

router.post('/loans', ...staff, can('loans', 'create'), handle(async (req, res) => {
  res.status(201).json({ success: true, data: await svc.create(req.body || {}, { user: req.user }), message: 'Loan added' });
}));

router.put('/loans/:id', ...staff, can('loans', 'edit'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.update(req.params.id, req.body || {}), message: 'Loan saved' });
}));

router.delete('/loans/:id', ...staff, can('loans', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.remove(req.params.id, { user: req.user }), message: 'Loan deleted' });
}));

// Paying the loan back in parts.
router.post('/loans/:id/repayments', ...staff, can('loans', 'edit'), handle(async (req, res) => {
  res.status(201).json({ success: true, data: await svc.addRepayment(req.params.id, req.body || {}, { user: req.user }), message: 'Payment saved' });
}));

router.delete('/loans/:id/repayments/:repaymentId', ...staff, can('loans', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.removeRepayment(req.params.id, req.params.repaymentId), message: 'Payment removed' });
}));

module.exports = router;
