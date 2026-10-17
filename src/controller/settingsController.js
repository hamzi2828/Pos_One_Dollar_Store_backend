// src/controller/settingsController.js

const Settings = require('../models/settings');
const fs = require('fs').promises;
const path = require('path');
const { invalidate } = require('../middleware/cache');

const SETTINGS_CACHE_TAG = 'settings:public';

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const settingsController = {
  // GET /settings/public - Get public settings (no auth required)
  getPublicSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();

      // Return only public-safe settings
      const publicSettings = {
        siteName: settings.siteName,
        siteUrl: settings.siteUrl,
        logoUrl: settings.logoUrl,
        headerLogoWidth: settings.headerLogoWidth || 160,
        headerLogoHeight: settings.headerLogoHeight || 56,
        footerLogoUrl: settings.footerLogoUrl || '',
        footerLogoWidth: settings.footerLogoWidth || 100,
        footerLogoHeight: settings.footerLogoHeight || 36,
        faviconUrl: settings.faviconUrl || '',
        currency: settings.currency,
        taxRate: settings.taxRate || 0,
        mobileNumber: settings.mobileNumber || '',
        businessHours: settings.businessHours || '',
        youtubeUrl: settings.youtubeUrl,
        facebookUrl: settings.facebookUrl,
        instagramUrl: settings.instagramUrl,
        twitterUrl: settings.twitterUrl,
        tiktokUrl: settings.tiktokUrl
      };

      return res.status(200).json({
        success: true,
        data: publicSettings
      });
    } catch (error) {
      console.error('Get public settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // GET /settings - Get current settings
  getSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();
      
      return res.status(200).json({
        success: true,
        message: 'Settings retrieved successfully',
        data: settings
      });
    } catch (error) {
      console.error('Get settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // PUT /settings - Update settings
  updateSettings: async (req, res) => {
    try {
      console.log('Request body:', req.body);

      const {
        siteName,
        siteUrl,
        timezone,
        dateFormat,
        emailNotifications,
        marketingEmails,
        securityAlerts,
        twoFactorAuth,
        currency,
        taxRate,
        paymentMethods,
        mobileNumber,
        address,
        businessHours,
        headerLogoWidth,
        headerLogoHeight,
        footerLogoWidth,
        footerLogoHeight,
        youtubeUrl,
        facebookUrl,
        instagramUrl,
        twitterUrl,
        tiktokUrl
      } = req.body;

      // Get current settings for partial updates
      const currentSettings = await Settings.getSettings();

      // Prepare update data with only provided fields
      const updateData = {};

      // Update only provided fields
      if (siteName !== undefined) updateData.siteName = siteName.trim();
      if (siteUrl !== undefined) updateData.siteUrl = siteUrl.trim();
      if (timezone !== undefined) updateData.timezone = timezone;
      if (dateFormat !== undefined) updateData.dateFormat = dateFormat;
      if (emailNotifications !== undefined) updateData.emailNotifications = Boolean(emailNotifications);
      if (marketingEmails !== undefined) updateData.marketingEmails = Boolean(marketingEmails);
      if (securityAlerts !== undefined) updateData.securityAlerts = Boolean(securityAlerts);
      if (twoFactorAuth !== undefined) updateData.twoFactorAuth = Boolean(twoFactorAuth);
      if (currency !== undefined) updateData.currency = currency;
      if (taxRate !== undefined) updateData.taxRate = Number(taxRate);
      if (mobileNumber !== undefined) updateData.mobileNumber = mobileNumber.trim();
      if (address !== undefined) updateData.address = address.trim();
      if (businessHours !== undefined) updateData.businessHours = businessHours.trim();

      // Handle logo dimensions
      if (headerLogoWidth !== undefined) updateData.headerLogoWidth = Number(headerLogoWidth);
      if (headerLogoHeight !== undefined) updateData.headerLogoHeight = Number(headerLogoHeight);
      if (footerLogoWidth !== undefined) updateData.footerLogoWidth = Number(footerLogoWidth);
      if (footerLogoHeight !== undefined) updateData.footerLogoHeight = Number(footerLogoHeight);

      // Handle social links
      if (youtubeUrl !== undefined) updateData.youtubeUrl = youtubeUrl;
      if (facebookUrl !== undefined) updateData.facebookUrl = facebookUrl;
      if (instagramUrl !== undefined) updateData.instagramUrl = instagramUrl;
      if (twitterUrl !== undefined) updateData.twitterUrl = twitterUrl;
      if (tiktokUrl !== undefined) updateData.tiktokUrl = tiktokUrl;

      // Handle payment methods array
      if (paymentMethods && Array.isArray(paymentMethods)) {
        updateData.paymentMethods = paymentMethods.filter(method =>
          ['credit_card', 'paypal', 'stripe', 'razorpay'].includes(method)
        );
      }

      // Ensure we have some data to update
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid fields provided for update'
        });
      }

      // Update settings
      const updatedSettings = await Settings.updateSettings(updateData);

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({
        success: true,
        message: 'Settings updated successfully',
        data: updatedSettings
      });
    } catch (error) {
      console.error('Update settings error:', error);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update settings',
        error: error.message
      });
    }
  },

  // POST /settings/logo - Upload logo
  uploadLogo: async (req, res) => {
    try {
      const logoFile = req.files?.logo?.[0];
      
      if (!logoFile) {
        return res.status(400).json({
          success: false,
          message: 'Logo file is required'
        });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.'
        });
      }

      // Validate file size (5MB)
      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 5MB.'
        });
      }

      // Generate new logo URL
      let logoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        logoUrl = await blobUpload.uploadToBlob(
          logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings'
        );
      } else {
        logoUrl = `/uploads/${logoFile.filename}`;
      }

      // Get current settings to backup old logo
      const currentSettings = await Settings.getSettings();
      const oldLogoUrl = currentSettings.logoUrl;

      // Update settings with new logo URL
      const updatedSettings = await Settings.updateSettings({ logoUrl });

      // Remove old logo file
      if (oldLogoUrl && oldLogoUrl !== '/images/logo.png') {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(oldLogoUrl);
        } else if (oldLogoUrl.startsWith('/uploads/')) {
          try {
            const oldLogoPath = path.join(__dirname, '../../uploads', path.basename(oldLogoUrl));
            await fs.access(oldLogoPath);
            await fs.unlink(oldLogoPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({
        success: true,
        message: 'Logo uploaded successfully',
        data: {
          logoUrl,
          settings: updatedSettings
        }
      });
    } catch (error) {
      console.error('Upload logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload logo',
        error: error.message
      });
    }
  },

  // DELETE /settings/logo - Remove logo (reset to default)
  removeLogo: async (req, res) => {
    try {
      // Get current settings
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Reset to default logo
      const defaultLogoUrl = '/images/logo.png';
      const updatedSettings = await Settings.updateSettings({ logoUrl: defaultLogoUrl });

      // Remove current logo file
      if (currentLogoUrl && currentLogoUrl !== defaultLogoUrl) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(currentLogoUrl);
        } else if (currentLogoUrl.startsWith('/uploads/')) {
          try {
            const logoPath = path.join(__dirname, '../../uploads', path.basename(currentLogoUrl));
            await fs.access(logoPath);
            await fs.unlink(logoPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({
        success: true,
        message: 'Logo reset to default successfully',
        data: updatedSettings
      });
    } catch (error) {
      console.error('Remove logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove logo',
        error: error.message
      });
    }
  },

  // POST /settings/footer-logo - Upload footer logo
  uploadFooterLogo: async (req, res) => {
    try {
      const logoFile = req.files?.logo?.[0];

      if (!logoFile) {
        return res.status(400).json({ success: false, message: 'Logo file is required' });
      }

      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({ success: false, message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.' });
      }

      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: 'File size too large. Maximum size allowed is 5MB.' });
      }

      let footerLogoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        footerLogoUrl = await blobUpload.uploadToBlob(logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings');
      } else {
        footerLogoUrl = `/uploads/${logoFile.filename}`;
      }

      const currentSettings = await Settings.getSettings();
      const oldUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl });

      if (oldUrl) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(oldUrl);
        } else if (oldUrl.startsWith('/uploads/')) {
          try {
            const oldPath = path.join(__dirname, '../../uploads', path.basename(oldUrl));
            await fs.access(oldPath);
            await fs.unlink(oldPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({ success: true, message: 'Footer logo uploaded successfully', data: { footerLogoUrl, settings: updatedSettings } });
    } catch (error) {
      console.error('Upload footer logo error:', error);
      return res.status(500).json({ success: false, message: 'Failed to upload footer logo', error: error.message });
    }
  },

  // DELETE /settings/footer-logo - Remove footer logo
  removeFooterLogo: async (req, res) => {
    try {
      const currentSettings = await Settings.getSettings();
      const currentUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl: '' });

      if (currentUrl) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(currentUrl);
        } else if (currentUrl.startsWith('/uploads/')) {
          try {
            const logoPath = path.join(__dirname, '../../uploads', path.basename(currentUrl));
            await fs.access(logoPath);
            await fs.unlink(logoPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({ success: true, message: 'Footer logo removed successfully', data: updatedSettings });
    } catch (error) {
      console.error('Remove footer logo error:', error);
      return res.status(500).json({ success: false, message: 'Failed to remove footer logo', error: error.message });
    }
  },

  // POST /settings/favicon - Upload favicon
  uploadFavicon: async (req, res) => {
    try {
      const faviconFile = req.files?.favicon?.[0];

      if (!faviconFile) {
        return res.status(400).json({ success: false, message: 'Favicon file is required' });
      }

      const allowedTypes = ['image/x-icon', 'image/vnd.microsoft.icon', 'image/png', 'image/svg+xml', 'image/jpeg', 'image/jpg', 'image/webp'];
      if (!allowedTypes.includes(faviconFile.mimetype)) {
        return res.status(400).json({ success: false, message: 'Invalid file type. Please upload ICO, PNG, SVG, or JPG images.' });
      }

      if (faviconFile.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: 'File size too large. Maximum size allowed is 2MB.' });
      }

      let faviconUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        faviconUrl = await blobUpload.uploadToBlob(faviconFile.buffer, faviconFile.originalname, faviconFile.mimetype, 'settings');
      } else {
        faviconUrl = `/uploads/${faviconFile.filename}`;
      }

      const currentSettings = await Settings.getSettings();
      const oldUrl = currentSettings.faviconUrl;

      const updatedSettings = await Settings.updateSettings({ faviconUrl });

      if (oldUrl) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(oldUrl);
        } else if (oldUrl.startsWith('/uploads/')) {
          try {
            const oldPath = path.join(__dirname, '../../uploads', path.basename(oldUrl));
            await fs.access(oldPath);
            await fs.unlink(oldPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({ success: true, message: 'Favicon uploaded successfully', data: { faviconUrl, settings: updatedSettings } });
    } catch (error) {
      console.error('Upload favicon error:', error);
      return res.status(500).json({ success: false, message: 'Failed to upload favicon', error: error.message });
    }
  },

  // DELETE /settings/favicon - Remove favicon
  removeFavicon: async (req, res) => {
    try {
      const currentSettings = await Settings.getSettings();
      const currentUrl = currentSettings.faviconUrl;

      const updatedSettings = await Settings.updateSettings({ faviconUrl: '' });

      if (currentUrl) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(currentUrl);
        } else if (currentUrl.startsWith('/uploads/')) {
          try {
            const faviconPath = path.join(__dirname, '../../uploads', path.basename(currentUrl));
            await fs.access(faviconPath);
            await fs.unlink(faviconPath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({ success: true, message: 'Favicon removed successfully', data: updatedSettings });
    } catch (error) {
      console.error('Remove favicon error:', error);
      return res.status(500).json({ success: false, message: 'Failed to remove favicon', error: error.message });
    }
  },

  // POST /settings/reset - Reset all settings to default
  resetSettings: async (req, res) => {
    try {
      // Get current settings to backup logo
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Create default settings
      const defaultSettings = {
        siteName: 'HK Auto Care',
        siteUrl: 'https://hamzamobile.com',
        logoUrl: '/images/logo.png',
        headerLogoWidth: 160,
        headerLogoHeight: 56,
        footerLogoUrl: '',
        footerLogoWidth: 100,
        footerLogoHeight: 36,
        faviconUrl: '',
        timezone: 'UTC+05:00',
        dateFormat: 'MM/DD/YYYY',
        emailNotifications: true,
        marketingEmails: false,
        securityAlerts: true,
        twoFactorAuth: false,
        currency: 'USD',
        taxRate: 0,
        paymentMethods: ['credit_card', 'paypal'],
        youtubeUrl: '',
        facebookUrl: '',
        instagramUrl: '',
        twitterUrl: '',
        tiktokUrl: ''
      };

      // Update settings to default
      const resetSettings = await Settings.updateSettings(defaultSettings);

      // Clean up all uploaded files
      const urlsToDelete = [
        currentLogoUrl !== '/images/logo.png' ? currentLogoUrl : null,
        currentSettings.footerLogoUrl,
        currentSettings.faviconUrl,
      ].filter(Boolean);

      for (const url of urlsToDelete) {
        if (USE_BLOB_STORAGE && blobUpload) {
          await blobUpload.deleteFile(url);
        } else if (url.startsWith('/uploads/')) {
          try {
            const filePath = path.join(__dirname, '../../uploads', path.basename(url));
            await fs.access(filePath);
            await fs.unlink(filePath);
          } catch (err) { /* ignore */ }
        }
      }

      invalidate(SETTINGS_CACHE_TAG);

      return res.status(200).json({
        success: true,
        message: 'Settings reset to default successfully',
        data: resetSettings
      });
    } catch (error) {
      console.error('Reset settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to reset settings',
        error: error.message
      });
    }
  },

  // POST /settings/cache/reset - Clear all cached API responses
  resetCaches: async (req, res) => {
    try {
      const { invalidateAll } = require('../middleware/cache');
      invalidateAll();
      return res.status(200).json({
        success: true,
        message: 'All caches cleared successfully',
      });
    } catch (error) {
      console.error('Reset caches error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to clear caches',
        error: error.message,
      });
    }
  },
};

module.exports = settingsController;