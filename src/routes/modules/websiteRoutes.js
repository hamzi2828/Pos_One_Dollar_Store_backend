// Marketing website CMS (docs/WEBSITE_CMS.md).
//   GET  /api/public/website   no login — what the public website shows (Redis cached, refreshed on save)
//   GET  /api/website          permission website:view — content + icons/defaults/limits
//   PUT  /api/website          website:edit — save (sections left out stay as they are)
//   POST /api/website/upload   website:edit — one picture (jpg/png/webp, <= 5 MB) -> { url }
//   POST /api/website/reset    website:edit — { section } back to the default content
const fs = require('fs');
const express = require('express');
const { staff, can, handle } = require('./_access');
const { uploadSingle } = require('../../helper/upload');
const { saveUploads } = require('../../helper/storeUpload');
const svc = require('../../services/websiteService');

const router = express.Router();

// Upload errors (wrong type / too big) -> 400 instead of a crash.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));

// Public pages only get plain photos (no SVG/GIF: SVG can carry scripts).
const WEBSITE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ---- Public (no login) ----
// Served from Redis (refilled on every CMS save). No CDN copy: the website keeps its
// own cache and asks again only after a save, and must then get the new content.
router.get('/public/website', handle(async (req, res) => {
  const { data, source } = await svc.getPublicWithSource();
  res.set('Cache-Control', 'no-store');
  res.set('X-Cache', source === 'redis' ? 'HIT' : 'MISS');
  res.json({ success: true, data });
}));

// ---- Admin CMS ----
router.get('/website', ...staff, can('website', 'view'), handle(async (req, res) => {
  res.json({ success: true, ...(await svc.getAdmin()) });
}));

router.put('/website', ...staff, can('website', 'edit'), handle(async (req, res) => {
  const out = await svc.save(req.body, { userId: req.access.userId });
  res.json({ success: true, ...out, message: 'Website saved' });
}));

router.post('/website/reset', ...staff, can('website', 'edit'), handle(async (req, res) => {
  const out = await svc.resetSection(String(req.body?.section || ''), { userId: req.access.userId });
  res.json({ success: true, ...out, message: 'Section reset to default' });
}));

router.post('/website/upload', ...staff, can('website', 'edit'), upload(uploadSingle('file')), handle(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: 'Choose a picture to upload' });
  if (!WEBSITE_IMAGE_TYPES.has(file.mimetype)) {
    if (file.path) fs.promises.unlink(file.path).catch(() => {});
    return res.status(400).json({ success: false, message: 'Use a JPG, PNG or WebP picture' });
  }
  let [url] = await saveUploads(req, 'website');
  if (!url) return res.status(500).json({ success: false, message: 'Could not save the picture' });
  // Local disk uploads come back as "/uploads/x.jpg" on THIS server; the website
  // lives elsewhere, so give it the full address. (Vercel Blob URLs are already full.)
  if (url.startsWith('/uploads/')) url = `${req.protocol}://${req.get('host')}${url}`;
  res.status(201).json({ success: true, data: { url } });
}));

module.exports = router;
