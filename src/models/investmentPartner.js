// src/models/investmentPartner.js
// A partner who puts money into the shop. Every investment bill belongs to one
// partner; the Investment page shows each partner's total and share.
const mongoose = require('mongoose');

const investmentPartnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    note: { type: String, default: '', trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

investmentPartnerSchema.plugin(require('../helper/softDeletePlugin'));
investmentPartnerSchema.index({ name: 1 });

module.exports = mongoose.models.InvestmentPartner || mongoose.model('InvestmentPartner', investmentPartnerSchema);
