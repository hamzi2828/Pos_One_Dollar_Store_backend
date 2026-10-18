// src/models/saleCounter.js
// A sale counter (cash register) in a branch: "Counter 1", "Counter 2"...
// Each counter has an opening / closing cut-off time (HH:mm, store time zone)
// used for late-open / still-open notifications, and a default opening float.
// OWNER: Cash & Notifications module.
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const saleCounterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Short code, unique per branch (auto "C1", "C2"... when left blank).
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    isActive: { type: Boolean, default: true },
    // "HH:mm" in the store time zone (config store.timezone, default Asia/Karachi). '' = no cut-off.
    openCutoff: { type: String, default: '', validate: { validator: (v) => !v || HHMM.test(v), message: 'Use HH:mm, e.g. 10:00' } },
    closeCutoff: { type: String, default: '', validate: { validator: (v) => !v || HHMM.test(v), message: 'Use HH:mm, e.g. 22:00' } },
    // Suggested opening float (change money). Never part of sales.
    defaultFloat: { type: Number, default: 0, min: 0 },
    // Only these users may open a till on this counter (empty = anyone with till permission).
    assignedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    notes: { type: String, trim: true, default: '', maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

saleCounterSchema.plugin(require('../helper/softDeletePlugin'));

// Code is unique among the branch's live counters.
saleCounterSchema.index(
  { branch: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
saleCounterSchema.index({ branch: 1, isActive: 1, name: 1 });

saleCounterSchema.statics.HHMM = HHMM;

module.exports = mongoose.models.SaleCounter || mongoose.model('SaleCounter', saleCounterSchema);
