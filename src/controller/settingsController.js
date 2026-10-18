// src/controller/settingsController.js
// Shop settings: read (public subset for the login page), update, logo / favicon, reset.

const fs = require('fs').promises;
const path = require('path');
const Settings = require('../models/settings');
const { invalidate } = require('../middleware/cache');

const SETTINGS_CACHE_TAG = 'settings:public';

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
const blobUpload = USE_BLOB_STORAGE ? require('../helper/blobUpload') : null;

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const FAVICON_TYPES = ['image/x-icon', 'image/vnd.microsoft.icon', 'image/png', 'image/svg+xml', 'image/jpeg', 'image/jpg', 'image/webp'];

// Fields PUT /settings accepts, with how to read each one.
const trimmed = (v) => String(v).trim();
const UPDATABLE = {
  siteName: trimmed,
  timezone: String,
  dateFormat: String,
  emailNotifications: Boolean,
  marketingEmails: Boolean,
  securityAlerts: Boolean,
  twoFactorAuth: Boolean,
  currency: String,
  taxRate: Number,
  mobileNumber: trimmed,
  address: trimmed,
  businessHours: trimmed,
  headerLogoWidth: Number,
  headerLogoHeight: Number,
};

/** Delete an uploaded settings file (Blob or local /uploads). Never throws. */
async function removeStoredFile(url) {
  if (!url || url === Settings.DEFAULT_LOGO) return;
  try {
    if (blobUpload) await blobUpload.deleteFile(url);
    else if (url.startsWith('/uploads/')) await fs.unlink(path.join(__dirname, '../../uploads', path.basename(url)));
  } catch (_) { /* already gone */ }
}

/**
 * POST handler for one image setting (logo / favicon): validate the upload,
 * store it, save the URL in `field`, remove the old file.
 */
const uploadImage = ({ fileField, field, types, maxMb, label }) => async (req, res) => {
  try {
    const file = req.files?.[fileField]?.[0];
    if (!file) return res.status(400).json({ success: false, message: `${label} file is required` });
    if (!types.includes(file.mimetype)) {
      return res.status(400).json({ success: false, message: `Invalid file type for the ${label.toLowerCase()}.` });
    }
    if (file.size > maxMb * 1024 * 1024) {
      return res.status(400).json({ success: false, message: `File size too large. Maximum size allowed is ${maxMb}MB.` });
    }

    const url = blobUpload
      ? await blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, 'settings')
      : `/uploads/${file.filename}`;
    const oldUrl = (await Settings.getSettings())[field];
    const settings = await Settings.updateSettings({ [field]: url });
    if (oldUrl !== url) await removeStoredFile(oldUrl);
    invalidate(SETTINGS_CACHE_TAG);

    return res.status(200).json({ success: true, message: `${label} uploaded successfully`, data: { [field]: url, settings } });
  } catch (error) {
    console.error(`Upload ${label} error:`, error);
    return res.status(500).json({ success: false, message: `Failed to upload ${label.toLowerCase()}`, error: error.message });
  }
};

/** DELETE handler for one image setting: back to `emptyValue`, old file removed. */
const removeImage = ({ field, emptyValue, label }) => async (req, res) => {
  try {
    const oldUrl = (await Settings.getSettings())[field];
    const settings = await Settings.updateSettings({ [field]: emptyValue });
    await removeStoredFile(oldUrl);
    invalidate(SETTINGS_CACHE_TAG);
    return res.status(200).json({ success: true, message: `${label} removed successfully`, data: settings });
  } catch (error) {
    console.error(`Remove ${label} error:`, error);
    return res.status(500).json({ success: false, message: `Failed to remove ${label.toLowerCase()}`, error: error.message });
  }
};

const settingsController = {
  // GET /settings/public — what the login page needs (no auth).
  getPublicSettings: async (req, res) => {
    try {
      const s = await Settings.getSettings();
      return res.status(200).json({
        success: true,
        data: {
          siteName: s.siteName,
          logoUrl: s.logoUrl,
          headerLogoWidth: s.headerLogoWidth || Settings.DEFAULTS.headerLogoWidth,
          headerLogoHeight: s.headerLogoHeight || Settings.DEFAULTS.headerLogoHeight,
          faviconUrl: s.faviconUrl || '',
          currency: s.currency,
          taxRate: s.taxRate || 0,
          mobileNumber: s.mobileNumber || '',
          businessHours: s.businessHours || '',
        },
      });
    } catch (error) {
      console.error('Get public settings error:', error);
      return res.status(500).json({ success: false, message: 'Failed to retrieve settings', error: error.message });
    }
  },

  // GET /settings
  getSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();
      return res.status(200).json({ success: true, message: 'Settings retrieved successfully', data: settings });
    } catch (error) {
      console.error('Get settings error:', error);
      return res.status(500).json({ success: false, message: 'Failed to retrieve settings', error: error.message });
    }
  },

  // PUT /settings — any of the UPDATABLE fields.
  updateSettings: async (req, res) => {
    try {
      const body = req.body || {};
      const updateData = {};
      for (const [key, read] of Object.entries(UPDATABLE)) {
        if (body[key] !== undefined && body[key] !== null) updateData[key] = read(body[key]);
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ success: false, message: 'No valid fields provided for update' });
      }

      const updatedSettings = await Settings.updateSettings(updateData);
      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({ success: true, message: 'Settings updated successfully', data: updatedSettings });
    } catch (error) {
      console.error('Update settings error:', error);
      if (error.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: 'Validation error', error: error.message });
      }
      return res.status(500).json({ success: false, message: 'Failed to update settings', error: error.message });
    }
  },

  // POST /settings/logo, DELETE /settings/logo (back to the default logo)
  uploadLogo: uploadImage({ fileField: 'logo', field: 'logoUrl', types: IMAGE_TYPES, maxMb: 5, label: 'Logo' }),
  removeLogo: removeImage({ field: 'logoUrl', emptyValue: Settings.DEFAULT_LOGO, label: 'Logo' }),

  // POST /settings/favicon, DELETE /settings/favicon
  uploadFavicon: uploadImage({ fileField: 'favicon', field: 'faviconUrl', types: FAVICON_TYPES, maxMb: 2, label: 'Favicon' }),
  removeFavicon: removeImage({ field: 'faviconUrl', emptyValue: '', label: 'Favicon' }),

  // POST /settings/reset — back to the shop defaults (uploaded logo / favicon removed).
  resetSettings: async (req, res) => {
    try {
      const current = await Settings.getSettings();
      const reset = await Settings.updateSettings({ ...Settings.DEFAULTS });
      await removeStoredFile(current.logoUrl);
      await removeStoredFile(current.faviconUrl);
      invalidate(SETTINGS_CACHE_TAG);
      return res.status(200).json({ success: true, message: 'Settings reset to default successfully', data: reset });
    } catch (error) {
      console.error('Reset settings error:', error);
      return res.status(500).json({ success: false, message: 'Failed to reset settings', error: error.message });
    }
  },

  // POST /settings/cache/reset — clear all cached API responses
  resetCaches: async (req, res) => {
    try {
      const { invalidateAll } = require('../middleware/cache');
      invalidateAll();
      return res.status(200).json({ success: true, message: 'All caches cleared successfully' });
    } catch (error) {
      console.error('Reset caches error:', error);
      return res.status(500).json({ success: false, message: 'Failed to clear caches', error: error.message });
    }
  },
};

module.exports = settingsController;
