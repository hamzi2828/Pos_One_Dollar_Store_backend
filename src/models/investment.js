// src/models/investment.js
// Money put into the shop (setup and growth): racks, renovation, AC, signboard,
// first stock... One row per bill, put in by one partner (investmentPartner).
// The Investment page shows the running total and each partner's share.
const mongoose = require('mongoose');

const investmentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 }, // what it was for
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, default: Date.now },
    // Who put the money in (required for new bills).
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'InvestmentPartner', default: null },
    billNo: { type: String, default: '', trim: true, maxlength: 80 },
    paidTo: { type: String, default: '', trim: true, maxlength: 120 }, // vendor / shop
    // Bill photos or PDFs.
    attachments: { type: [String], default: [] },
    note: { type: String, default: '', trim: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

investmentSchema.plugin(require('../helper/softDeletePlugin'));
investmentSchema.index({ date: -1 });
investmentSchema.index({ partner: 1, date: -1 });
investmentSchema.index({ title: 'text', billNo: 'text', paidTo: 'text', note: 'text' }, { name: 'investment_text_idx' });

module.exports = mongoose.models.Investment || mongoose.model('Investment', investmentSchema);
