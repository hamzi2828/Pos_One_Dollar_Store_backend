// Sticker print history (/api/...).
// POST /public/label-prints  { ticket, count, mode, via } -> logs a print run.
//   Public because the sticker page has no sign-in header; the signed ticket
//   in the page (made for a signed-in user) is the proof.
// GET  /label-prints?productId=&variantId= -> latest prints of a product.
const express = require('express');
const { staff, can, handle } = require('./_access');
const log = require('../../services/labelPrintLog');

const router = express.Router();

const limit = (() => {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'x';
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60000);
    list.push(now);
    hits.set(key, list);
    if (list.length > 60) return res.status(429).json({ success: false, message: 'Too many tries. Wait a minute.' });
    next();
  };
})();

router.post(
  '/public/label-prints',
  limit,
  handle(async (req, res) => {
    const data = await log.record(req.body || {});
    res.json({ success: true, data });
  })
);

router.get(
  '/label-prints',
  ...staff,
  can('products', 'view'),
  handle(async (req, res) => {
    const data = await log.listForProduct(req.query.productId, { variantId: req.query.variantId || null, bill: req.query.bill || null, limit: req.query.limit });
    res.json({ success: true, data });
  })
);

// GET /label-prints/summary?productIds=a,b -> [{ productId, variantId, bill, printed }]
router.get(
  '/label-prints/summary',
  ...staff,
  can('products', 'view'),
  handle(async (req, res) => {
    const data = await log.printedSummary(String(req.query.productIds || '').split(','));
    res.json({ success: true, data });
  })
);

// PATCH /label-prints/:id { ignored: true|false } -> leave a test / wrong print out of the count.
router.patch(
  '/label-prints/:id',
  ...staff,
  can('products', 'edit'),
  handle(async (req, res) => {
    const data = await log.setIgnored(req, req.params.id, (req.body || {}).ignored);
    res.json({ success: true, data });
  })
);

module.exports = router;
