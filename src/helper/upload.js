// src/helper/upload.js
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Configure uploads directory (fallback for local development)
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

function ensureUploadsDir() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('Failed to create uploads directory:', e);
  }
}

ensureUploadsDir();

// Allowed image mime types
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

// Allowed media mime types (images + videos)
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_MIME_TYPES,
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

// File size limit (default 5MB)
const MAX_FILE_MB = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 5);
const MAX_FILE_BYTES = Math.max(1, MAX_FILE_MB) * 1024 * 1024;

// Larger file size limit for blog hero images (20MB)
const MAX_HERO_FILE_MB = 20;
const MAX_HERO_FILE_BYTES = MAX_HERO_FILE_MB * 1024 * 1024;

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Use memory storage for Vercel Blob, disk storage for local
const storage = USE_BLOB_STORAGE
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
      },
      filename: (req, file, cb) => {
        const timestamp = Date.now();
        const rand = Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname || '').toLowerCase();
        const base = path.basename((file.originalname || 'file').replace(/\s+/g, '-'), ext);
        cb(null, `${timestamp}-${rand}-${base}${ext}`);
      },
    });

const fileFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error('Only image files are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES } });

// Hero upload with larger file size limit
const heroUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_HERO_FILE_BYTES } });

// Convenience wrappers
const uploadSingle = (fieldName) => upload.single(fieldName);
const uploadArray = (fieldName, maxCount) => upload.array(fieldName, maxCount);
const uploadFields = (fields) => upload.fields(fields);

// Hero upload wrappers
const heroUploadSingle = (fieldName) => heroUpload.single(fieldName);
const heroUploadFields = (fields) => heroUpload.fields(fields);

// Media upload (images + videos, 50MB limit)
const mediaFilter = (req, file, cb) => {
  if (ALLOWED_MEDIA_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error('Only image and video files are allowed'));
};
const mediaUpload = multer({ storage, fileFilter: mediaFilter, limits: { fileSize: 50 * 1024 * 1024 } });
const mediaUploadFields = (fields) => mediaUpload.fields(fields);

// Helper to build public URL path (as served by Express static middleware)
function toPublicPath(filename) {
  // Returns a path like '/uploads/<filename>'
  return `/uploads/${path.basename(filename)}`;
}

module.exports = {
  upload,
  uploadSingle,
  uploadArray,
  uploadFields,
  heroUploadSingle,
  heroUploadFields,
  mediaUploadFields,
  ensureUploadsDir,
  toPublicPath,
  UPLOADS_DIR,
  ALLOWED_IMAGE_MIME_TYPES,
};
