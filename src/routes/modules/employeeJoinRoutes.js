// Public employee join link (/api/public/join/:token, NO login) and the HR
// screens that manage it (/api/employee-join-link, /api/employee-applications).
// OWNER: HR module. Mounted at /api by routes/modules/index.js.
const express = require('express');
const { staff, can, handle } = require('./_access');
const { documentUploadFields } = require('../../helper/upload');
const ctrl = require('../../controller/store/employeeJoinController');

const router = express.Router();

// Multer errors (wrong type, too big, too many files) as a 400 JSON answer.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    const tooMany = err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT';
    return res.status(400).json({
      success: false,
      message: tooBig ? 'File is too large (max 5 MB)' : tooMany ? 'Too many files (1 photo and up to 5 documents)' : err.message || 'Upload failed',
      code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
    });
  });

// Small in-memory limiter for the public form: N requests per IP per hour
// (per serverless instance — a speed bump for spam, not a hard wall).
// `envKey` / `fallback`: the limit; each limiter keeps its own counts.
const WINDOW_MS = 60 * 60 * 1000;
function rateLimit(envKey, fallback) {
  const hits = new Map(); // ip -> [timestamps]
  return function joinRateLimit(req, res, next) {
    const max = Number(process.env[envKey]) || fallback;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= max) {
      hits.set(ip, list);
      return res.status(429).json({ success: false, message: 'Too many tries. Please wait an hour and try again.', code: 'RATE_LIMITED' });
    }
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    return next();
  };
}
// Sending / changing the form (shared count). Opening "my form" is allowed more often.
const joinRateLimit = rateLimit('JOIN_RATE_LIMIT', 10);
const mineReadLimit = rateLimit('JOIN_READ_RATE_LIMIT', 60);
const joinUpload = () => upload(documentUploadFields([{ name: 'photo', maxCount: 1 }, { name: 'files', maxCount: 5 }]));

// ----- Public (no login) -----
router.get('/public/join/:token', handle(ctrl.publicInfo));
router.post('/public/join/:token', joinRateLimit, joinUpload(), handle(ctrl.publicSubmit));
// The person's own form (header x-join-key): read, and change it while pending.
router.get('/public/join/:token/mine', mineReadLimit, handle(ctrl.publicMine));
router.put('/public/join/:token/mine', joinRateLimit, joinUpload(), handle(ctrl.publicUpdateMine));

// ----- Link settings -----
router.get('/employee-join-link', ...staff, can('employees', 'create'), handle(ctrl.getLink));
router.post('/employee-join-link/regenerate', ...staff, can('employees', 'create'), handle(ctrl.regenerateLink));
router.put('/employee-join-link', ...staff, can('employees', 'create'), handle(ctrl.setLink));

// ----- Applications -----
router.get('/employee-applications', ...staff, can('employees', 'view'), handle(ctrl.list));
router.get('/employee-applications/:id', ...staff, can('employees', 'view'), handle(ctrl.get));
router.post('/employee-applications/:id/approve', ...staff, can('employees', 'create'), handle(ctrl.approve));
router.post('/employee-applications/:id/reject', ...staff, can('employees', 'edit'), handle(ctrl.reject));

module.exports = router;
