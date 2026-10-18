// src/models/settings.js
// Shop settings (one active document): name, logo, currency, taxes, contact details.

const mongoose = require('mongoose');

const DEFAULT_LOGO = '/images/logo.png';

// Values of a fresh shop (also used by POST /settings/reset).
const DEFAULTS = Object.freeze({
  siteName: 'DOLLAR & Co',
  logoUrl: DEFAULT_LOGO,
  headerLogoWidth: 160,
  headerLogoHeight: 56,
  faviconUrl: '',
  timezone: 'Asia/Karachi',
  dateFormat: 'DD/MM/YYYY',
  emailNotifications: true,
  marketingEmails: false,
  securityAlerts: true,
  twoFactorAuth: false,
  currency: 'PKR',
  taxRate: 0,
});

const settingsSchema = new mongoose.Schema(
  {
    // General
    siteName: { type: String, required: true, trim: true, default: DEFAULTS.siteName },
    logoUrl: { type: String, default: DEFAULT_LOGO, trim: true },
    headerLogoWidth: { type: Number, default: DEFAULTS.headerLogoWidth, min: 20, max: 600 },
    headerLogoHeight: { type: Number, default: DEFAULTS.headerLogoHeight, min: 20, max: 200 },
    faviconUrl: { type: String, default: '', trim: true },
    timezone: { type: String, default: DEFAULTS.timezone, trim: true },
    dateFormat: {
      type: String,
      default: DEFAULTS.dateFormat,
      enum: ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'],
      trim: true,
    },

    // Notifications / security
    emailNotifications: { type: Boolean, default: true },
    marketingEmails: { type: Boolean, default: false },
    securityAlerts: { type: Boolean, default: true },
    twoFactorAuth: { type: Boolean, default: false },

    // Billing
    currency: { type: String, default: DEFAULTS.currency, enum: ['PKR', 'USD', 'GBP'], trim: true },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    // Taxes the cashier can pick per sale (e.g. GST + service charge).
    taxes: [{
      taxId: { type: String },
      name: { type: String, trim: true },
      rate: { type: Number, min: 0, max: 100, default: 0 },
      description: { type: String, trim: true, default: '' },
      isActive: { type: Boolean, default: true },
      isDefault: { type: Boolean, default: false },
    }],

    // POS external link
    posUrl: { type: String, trim: true, default: '' },

    // Contact information (receipts, contract letters)
    mobileNumber: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    businessHours: { type: String, trim: true, default: '' },

    isActive: { type: Boolean, default: true },
    version: { type: String, default: '1.0.0' },
  },
  {
    timestamps: true,
    collection: 'settings',
  }
);

settingsSchema.index({ isActive: 1 });

// The active settings (created with the defaults the first time).
settingsSchema.statics.getSettings = async function getSettings() {
  const settings = await this.findOne({ isActive: true }).lean();
  if (settings) return settings;
  return (await this.create({ ...DEFAULTS, isActive: true })).toObject();
};

// Set the given fields (undefined values are skipped) on the active settings.
settingsSchema.statics.updateSettings = async function updateSettings(updateData) {
  let settings = await this.findOne({ isActive: true });
  if (!settings) {
    settings = new this(updateData);
  } else {
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] !== undefined) settings[key] = updateData[key];
    });
  }
  await settings.save();
  return settings;
};

settingsSchema.statics.DEFAULTS = DEFAULTS;
settingsSchema.statics.DEFAULT_LOGO = DEFAULT_LOGO;

settingsSchema.plugin(require('../helper/softDeletePlugin'));

// Invalidate the public settings cache whenever settings change.
settingsSchema.post('save', function invalidatePublicSettingsCache() {
  try {
    const { invalidate } = require('../middleware/cache');
    invalidate('settings:public');
  } catch (_) { /* noop */ }
});

module.exports = mongoose.model('Settings', settingsSchema);
