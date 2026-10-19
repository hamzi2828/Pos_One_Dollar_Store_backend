// src/models/investment.js
// Money put into the shop (setup and growth): racks, renovation, AC, signboard,
// first stock... One row per bill, put in by one partner (investmentPartner).
// A bill can be paid in parts: `payments` holds each payment (when, how much),
// `paidAmount` / `balance` are kept in step with it for totals and filters.
// The Investment page shows the running total and each partner's share.
const mongoose = require('mongoose');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One payment on a bill ("1,000 paid on 2 Oct").
const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true, default: Date.now },
    note: { type: String, default: '', trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const investmentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 }, // what it was for
    amount: { type: Number, required: true, min: 0 }, // bill total
    date: { type: Date, required: true, default: Date.now },
    // Who put the money in (required for new bills).
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'InvestmentPartner', default: null },
    payments: { type: [paymentSchema], default: [] },
    // Sum of payments, and what is still to pay (amount - paidAmount).
    paidAmount: { type: Number, min: 0 },
    balance: { type: Number, min: 0 },
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

// On save: a new bill that does not say what was paid is paid in full (as all
// bills were before part payments). Then paidAmount / balance follow payments.
investmentSchema.pre('validate', function syncPaid() {
  if (this.isNew && (this.paidAmount === undefined || this.paidAmount === null) && !this.payments.length && this.amount > 0) {
    this.payments.push({ amount: this.amount, date: this.date, createdBy: this.createdBy });
  }
  this.paidAmount = round2(this.payments.reduce((t, p) => t + (Number(p.amount) || 0), 0));
  this.balance = round2((Number(this.amount) || 0) - this.paidAmount);
  if (this.balance < 0) this.invalidate('amount', 'The bill total cannot be less than what is already paid');
});

investmentSchema.plugin(require('../helper/softDeletePlugin'));
investmentSchema.index({ date: -1 });
investmentSchema.index({ partner: 1, date: -1 });
investmentSchema.index({ title: 'text', billNo: 'text', paidTo: 'text', note: 'text' }, { name: 'investment_text_idx' });

module.exports = mongoose.models.Investment || mongoose.model('Investment', investmentSchema);
