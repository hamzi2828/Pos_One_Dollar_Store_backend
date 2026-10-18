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
const { toPublicPath } = require('./upload');

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

module.exports = { saveUploads };
