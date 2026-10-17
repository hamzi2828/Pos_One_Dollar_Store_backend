// src/model/settings.js

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // General Settings
    siteName: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'Mirpur Mobile & Stationery' 
    },
    siteUrl: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'https://mirpur-pos.vercel.app' 
    },
    logoUrl: {
      type: String,
      default: '/images/logo.png',
      trim: true
    },
    headerLogoWidth: {
      type: Number,
      default: 160,
      min: 20,
      max: 600
    },
    headerLogoHeight: {
      type: Number,
      default: 56,
      min: 20,
      max: 200
    },
    footerLogoUrl: {
      type: String,
      default: '',
      trim: true
    },
    footerLogoWidth: {
      type: Number,
      default: 100,
      min: 20,
      max: 600
    },
    footerLogoHeight: {
      type: Number,
      default: 36,
      min: 20,
      max: 200
    },
    faviconUrl: {
      type: String,
      default: '',
      trim: true
    },
    timezone: { 
      type: String, 
      default: 'UTC+05:00',
      trim: true 
    },
    dateFormat: { 
      type: String, 
      default: 'MM/DD/YYYY',
      enum: ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'],
      trim: true 
    },
    
    // Notification Settings
    emailNotifications: { 
      type: Boolean, 
      default: true 
    },
    marketingEmails: { 
      type: Boolean, 
      default: false 
    },
    securityAlerts: { 
      type: Boolean, 
      default: true 
    },
    
    // Security Settings
    twoFactorAuth: { 
      type: Boolean, 
      default: false 
    },
    
    // Billing Settings
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'GBP', 'PKR'],
      trim: true
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    // Optional multi-tax list used by POS. Admins can add several taxes
    // (e.g. VAT + Service), each selectable per sale.
    taxes: [{
      taxId: { type: String },
      name: { type: String, trim: true },
      rate: { type: Number, min: 0, max: 100, default: 0 },
      description: { type: String, trim: true, default: '' },
      isActive: { type: Boolean, default: true },
      isDefault: { type: Boolean, default: false },
    }],
    paymentMethods: [{
      type: String,
      enum: ['credit_card', 'paypal', 'stripe', 'razorpay'],
      default: ['credit_card', 'paypal']
    }],

    // POS External Link
    posUrl: {
      type: String,
      trim: true,
      default: ''
    },

    // Contact Information
    mobileNumber: {
      type: String,
      trim: true,
      default: ''
    },
    address: {
      type: String,
      trim: true,
      default: ''
    },
    businessHours: {
      type: String,
      trim: true,
      default: ''
    },

    // Social Media Links
    youtubeUrl: {
      type: String,
      trim: true,
      default: ''
    },
    facebookUrl: {
      type: String,
      trim: true,
      default: ''
    },
    instagramUrl: {
      type: String,
      trim: true,
      default: ''
    },
    twitterUrl: {
      type: String,
      trim: true,
      default: ''
    },
    tiktokUrl: {
      type: String,
      trim: true,
      default: ''
    },

    // Booking slots / availability — embedded to avoid a new collection.
    bookingSettings: {
      bookingEnabled: { type: Boolean, default: true },
      days: {
        type: [
          {
            key: { type: String },
            label: { type: String },
            enabled: { type: Boolean, default: true },
            openTime: { type: String, default: '09:00' },
            closeTime: { type: String, default: '18:00' },
            _id: false,
          },
        ],
        default: () => [
          { key: 'mon', label: 'Monday',    enabled: true,  openTime: '09:00', closeTime: '18:00' },
          { key: 'tue', label: 'Tuesday',   enabled: true,  openTime: '09:00', closeTime: '18:00' },
          { key: 'wed', label: 'Wednesday', enabled: true,  openTime: '09:00', closeTime: '18:00' },
          { key: 'thu', label: 'Thursday',  enabled: true,  openTime: '09:00', closeTime: '18:00' },
          { key: 'fri', label: 'Friday',    enabled: true,  openTime: '09:00', closeTime: '18:00' },
          { key: 'sat', label: 'Saturday',  enabled: true,  openTime: '10:00', closeTime: '16:00' },
          { key: 'sun', label: 'Sunday',    enabled: false, openTime: '10:00', closeTime: '16:00' },
        ],
      },
      slotDuration: { type: Number, default: 30 },
      bufferBefore: { type: Number, default: 0 },
      bufferAfter: { type: Number, default: 15 },
      maxPerSlot: { type: Number, default: 1 },
      advanceDays: { type: Number, default: 30 },
      leadMinutes: { type: Number, default: 60 },
      blackouts: {
        type: [
          {
            id: { type: String },
            date: { type: String },
            reason: { type: String, default: 'Closed' },
            _id: false,
          },
        ],
        default: [],
      },
    },

    // Additional metadata
    isActive: {
      type: Boolean,
      default: true
    },
    version: { 
      type: String, 
      default: '1.0.0' 
    }
  },
  { 
    timestamps: true,
    collection: 'settings' 
  }
);

// Index for faster queries
settingsSchema.index({ isActive: 1 });

// Static method to get or create settings
settingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true }).lean();

  if (!settings) {
    // Create default settings if none exist
    settings = await this.create({
      siteName: 'Mirpur Mobile & Stationery',
      siteUrl: 'https://mirpur-pos.vercel.app',
      logoUrl: '/images/logo.png',
      timezone: 'UTC+05:00',
      dateFormat: 'MM/DD/YYYY',
      emailNotifications: true,
      marketingEmails: false,
      securityAlerts: true,
      twoFactorAuth: false,
      currency: 'USD',
      taxRate: 0,
      paymentMethods: ['credit_card', 'paypal'],
      posUrl: '',
      youtubeUrl: '',
      facebookUrl: '',
      instagramUrl: '',
      twitterUrl: '',
      tiktokUrl: '',
      isActive: true
    });
  }

  return settings;
};

// Static method to update settings
settingsSchema.statics.updateSettings = async function(updateData) {
  let settings = await this.findOne({ isActive: true });
  
  if (!settings) {
    // Create new settings if none exist
    settings = new this(updateData);
  } else {
    // Update existing settings
    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        settings[key] = updateData[key];
      }
    });
  }
  
  await settings.save();
  return settings;
};

settingsSchema.plugin(require('../helper/softDeletePlugin'));

// Invalidate public settings cache whenever settings change.
settingsSchema.post('save', function invalidatePublicSettingsCache() {
  try {
    const { invalidate } = require('../middleware/cache');
    invalidate('settings:public');
  } catch (_) { /* noop */ }
});

module.exports = mongoose.model('Settings', settingsSchema);