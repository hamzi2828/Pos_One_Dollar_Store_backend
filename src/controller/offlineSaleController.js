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
  catalog: async (req, res) => {
    try {
      const data = await offline.catalog(req.access, { branchId: await shopBranch(req) });
      return res.status(200).json({ success: true, data });
    } catch (err) {
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
