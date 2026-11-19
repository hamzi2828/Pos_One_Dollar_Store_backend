// src/controller/offlineSaleController.js
// /api/pos/offline/* — the counter POS selling without internet (docs/OFFLINE_SALES.md).
// Thin: the logic lives in services/sales/offlineSaleService.js.
const offline = require('../services/sales/offlineSaleService');
const { resolveWriteBranch } = require('../middleware/access');

const shopBranch = async (req) => String(await resolveWriteBranch(req));

const fail = (res, err, what) => {
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(`[pos offline] ${what}:`, err);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? `Could not ${what}` : err.message,
    code: err.code || undefined,
    error: status >= 500 ? err.message : undefined,
  });
};

module.exports = {
  // GET /api/pos/offline/catalog — products, prices, rules, taxes and limits for selling offline.
  // Conditional: the answer carries `ETag: W/"cat1-..."`; a PC that sends it back
  // in `If-None-Match` gets 304 Not Modified (no body) while nothing changed.
  catalog: async (req, res) => {
    try {
      const branchId = await shopBranch(req);
      const now = new Date();
      // Private: per-user data (limits); always revalidate, never in a shared cache.
      res.set('Cache-Control', 'private, no-cache');
      const etag = await offline.catalogEtag(req.access, { branchId, now });
      res.set('ETag', etag);
      if (offline.etagMatches(req.get('If-None-Match'), etag)) return res.status(304).end();
      const data = await offline.catalog(req.access, { branchId, now });
      data.etag = etag; // same value as the header (handy to store with the snapshot)
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (!res.headersSent) res.removeHeader('ETag'); // an error answer has no version
      return fail(res, err, 'load the offline catalogue');
    }
  },

  // POST /api/pos/offline/orders — upload sales made while offline (max 50 per call).
  uploadOrders: async (req, res) => {
    try {
      const data = await offline.uploadOrders(req.body || {}, { access: req.access, branchId: await shopBranch(req) });
      const created = data.results.filter((r) => r.status === 'created').length;
      return res.status(200).json({ success: true, data, message: `${created} offline sale(s) saved` });
    } catch (err) {
      return fail(res, err, 'upload the offline sales');
    }
  },
};
