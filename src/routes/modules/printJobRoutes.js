// Print receipts on another counter (/api/print-jobs). Same permission as making a POS sale.
const express = require('express');
const { staff, can, handle } = require('./_access');
const ctrl = require('../../controller/store/printJobController');

const router = express.Router();

router.post('/print-jobs', ...staff, can('pos', 'create'), handle(ctrl.create));
router.post('/print-jobs/claim', ...staff, can('pos', 'create'), handle(ctrl.claim));
router.post('/print-jobs/:id/done', ...staff, can('pos', 'create'), handle(ctrl.done));

module.exports = router;
