// Facebook / Instagram ads (/api/ads): connection settings, every ad with its
// numbers, one ad's analytics, pause / start, daily budget.
// OWNER: Marketing module. Permission key: `advertisements`.
const express = require('express');
const { staff, can, handle } = require('./_access');
const metaAds = require('../../services/metaAds');

const router = express.Router();

router.get(
  '/ads/settings',
  ...staff,
  can('advertisements', 'view'),
  handle(async (req, res) => {
    res.json({ success: true, data: metaAds.publicSettings(await metaAds.getSettings()) });
  })
);

router.put(
  '/ads/settings',
  ...staff,
  can('advertisements', 'edit'),
  handle(async (req, res) => {
    const data = await metaAds.saveSettings(req.body || {}, req.access.userId);
    res.json({ success: true, data, message: 'Meta ads settings saved' });
  })
);

router.get(
  '/ads/account',
  ...staff,
  can('advertisements', 'view'),
  handle(async (req, res) => {
    res.json({ success: true, data: await metaAds.account() });
  })
);

router.get(
  '/ads',
  ...staff,
  can('advertisements', 'view'),
  handle(async (req, res) => {
    const { rows, range } = await metaAds.listAds(req.query);
    res.json({ success: true, data: rows, meta: { range } });
  })
);

router.get(
  '/ads/:id/insights',
  ...staff,
  can('advertisements', 'view'),
  handle(async (req, res) => {
    res.json({ success: true, data: await metaAds.adInsights(req.params.id, req.query) });
  })
);

router.patch(
  '/ads/:id/status',
  ...staff,
  can('advertisements', 'edit'),
  handle(async (req, res) => {
    const data = await metaAds.setAdStatus(req.params.id, String(req.body?.status || '').toUpperCase());
    res.json({ success: true, data, message: data.status === 'ACTIVE' ? 'Ad started' : 'Ad paused' });
  })
);

router.patch(
  '/ads/adsets/:id/budget',
  ...staff,
  can('advertisements', 'edit'),
  handle(async (req, res) => {
    const data = await metaAds.setDailyBudget(req.params.id, req.body?.dailyBudget);
    res.json({ success: true, data, message: 'Daily budget updated' });
  })
);

module.exports = router;
