// src/helper/storeUpload.js
// Save files that multer already parsed (uploadSingle / uploadArray / uploadFields
// from helper/upload.js) and return their public URLs. Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set, else the local /uploads folder.
//
//   router.post('/purchase-orders/:id/bills', ...staff, can('purchase_orders', 'edit'),
//     uploadArray('photos', 5), handle(ctrl.addBill));
//   const urls = await saveUploads(req, 'purchasing/bills');           // all files
//   const builty = await saveUploads(req, 'purchasing/builty', 'builtyPhoto'); // one field
const { uploadToBlob } = require('./blobUpload');
const fs = require('fs');
const path = require('path');
const { toPublicPath, UPLOADS_DIR } = require('./upload');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

const filesOf = (req, field) => {
  if (req.file && (!field || req.file.fieldname === field)) return [req.file];
  if (Array.isArray(req.files)) return field ? req.files.filter((f) => f.fieldname === field) : req.files;
  if (req.files && typeof req.files === 'object') {
    if (field) return req.files[field] || [];
    return Object.values(req.files).flat();
  }
  return [];
};

/** @returns {Promise<string[]>} public URLs (empty when nothing was uploaded) */
async function saveUploads(req, folder = 'misc', field = null) {
  const files = filesOf(req, field);
  const urls = [];
  for (const f of files) {
    if (USE_BLOB_STORAGE && f.buffer) {
      // multer's filter on the route already decided which types are allowed
      // (PDF only gets this far on document routes).
      urls.push(await uploadToBlob(f.buffer, f.originalname, f.mimetype, folder, { allowPdf: true }));
    } else if (f.filename) {
      urls.push(toPublicPath(f.filename));
    }
  }
  return urls;
}

/**
 * Save a buffer we made (e.g. a generated PDF). Same storage as saveUploads.
 * @returns {Promise<string>} public URL
 */
async function saveBuffer(buffer, { folder = 'misc', filename = 'file.pdf', mimetype = 'application/pdf', maxBytes } = {}) {
  if (USE_BLOB_STORAGE) return uploadToBlob(buffer, filename, mimetype, folder, { allowPdf: true, maxBytes });
  const ext = path.extname(filename) || (mimetype === 'application/pdf' ? '.pdf' : '');
  const base = path.basename(filename, path.extname(filename)).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'file';
  const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`;
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(UPLOADS_DIR, name), buffer);
  return toPublicPath(name);
}

/** Read back a file saved by saveUploads / saveBuffer (blob URL or /uploads path). */
async function readSaved(url) {
  if (!url) return null;
  if (url.startsWith('/uploads/')) return fs.promises.readFile(path.join(UPLOADS_DIR, path.basename(url)));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { saveUploads, saveBuffer, readSaved };
