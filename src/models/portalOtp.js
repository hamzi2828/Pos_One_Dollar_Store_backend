// src/models/portalOtp.js
// One-time sign-in codes for the Employee Portal (services/hr/portalLoginService.js).
// One document per email; a new code replaces the old one. Only a hash of the
// code is kept. Mongo removes the document a day after it expires (TTL index).

const mongoose = require('mongoose');

const portalOtpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    codeHash: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 }, // wrong codes for the current code
    sentAt: { type: Date, default: null }, // last code sent (resend wait)
    // Codes sent in the current hour window (limit per hour).
    windowStart: { type: Date, default: null },
    windowCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'portalotps' }
);

portalOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('PortalOtp', portalOtpSchema);
