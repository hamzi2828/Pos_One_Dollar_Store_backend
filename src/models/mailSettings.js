// src/models/mailSettings.js
// SMTP settings (one document). Kept apart from Settings so the public
// settings never carry it. The password is stored encrypted (see mailService).

const mongoose = require('mongoose');

const mailSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'smtp', unique: true },
    enabled: { type: Boolean, default: false },
    host: { type: String, trim: true, default: '' },
    port: { type: Number, default: 587, min: 1, max: 65535 },
    secure: { type: Boolean, default: false }, // true for 465 (SSL), false for 587 (STARTTLS)
    user: { type: String, trim: true, default: '' },
    passEnc: { type: String, default: '' },
    fromName: { type: String, trim: true, default: '' },
    fromEmail: { type: String, trim: true, default: '' },
    testTo: { type: String, trim: true, default: '' },
    lastTest: {
      at: Date,
      ok: Boolean,
      to: String,
      message: String,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'mailsettings' }
);

module.exports = mongoose.model('MailSettings', mailSettingsSchema);
