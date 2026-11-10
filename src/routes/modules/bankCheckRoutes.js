// Bank Check (/api/bank-statements, /api/bank-statement-lines). Permission `bank_check` (Finance).
// Upload a bank statement PDF, match it to the POS, keep the result. See docs/BANK_CHECK.md.
const express = require('express');
const multer = require('multer');
const { staff, can, handle } = require('./_access');
const svc = require('../../services/bankcheck/bankCheckService');

const router = express.Router();

// PDF only, kept in memory (we read it before saving it).
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: svc.MAX_PDF_BYTES, files: 1 },
  fileFilter: (req, file, cb) =>
    file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '') ? cb(null, true) : cb(new Error('Only PDF files are allowed')),
});
const onePdf = (req, res, next) =>
  pdfUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The PDF is too big (10 MB max)' : err.message || 'Upload failed';
    return res.status(400).json({ success: false, message });
  });
const fileOf = (req) => (req.file ? req.file.buffer : null);

router.post('/bank-statements/preview', ...staff, can('bank_check', 'create'), onePdf, handle(async (req, res) => {
  res.json({ success: true, data: await svc.preview(fileOf(req)) });
}));

router.get('/bank-statements', ...staff, can('bank_check', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.list() });
}));

router.post('/bank-statements', ...staff, can('bank_check', 'create'), onePdf, handle(async (req, res) => {
  const data = await svc.create(fileOf(req), req.file && req.file.originalname, req.body || {}, { user: req.user });
  res.status(201).json({ success: true, data, message: 'Statement checked' });
}));

router.get('/bank-statements/:id', ...staff, can('bank_check', 'view'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.get(req.params.id) });
}));

router.post('/bank-statements/:id/recheck', ...staff, can('bank_check', 'edit'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.recheck(req.params.id, { user: req.user }), message: 'Checked again' });
}));

router.delete('/bank-statements/:id', ...staff, can('bank_check', 'delete'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.remove(req.params.id, { user: req.user }), message: 'Statement deleted' });
}));

router.put('/bank-statement-lines/:id', ...staff, can('bank_check', 'edit'), handle(async (req, res) => {
  res.json({ success: true, data: await svc.setManual(req.params.id, req.body || {}, { user: req.user }), message: 'Saved' });
}));

module.exports = router;
