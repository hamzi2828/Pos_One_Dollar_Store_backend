// src/models/loan.js
// Money the company BORROWED and has to give back (owner 2026-11-06).
// Lender = a vendor, a customer, an employee or anyone else (typed name).
// Paid back in parts: repayments[]; left = amount - paid.
// Owner: Finance module (services/loanService.js, routes/modules/loansRoutes.js).
const mongoose = require('mongoose');

const repaymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    method: { type: String, default: 'Cash' }, // Cash | Bank Transfer | Easypaisa | JazzCash | Cheque | Other
    note: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const loanSchema = new mongoose.Schema(
  {
    loanNo: { type: String, required: true, unique: true }, // LOAN-2026-00001
    lenderType: { type: String, enum: ['vendor', 'customer', 'employee', 'other'], required: true },
    lender: { type: mongoose.Schema.Types.ObjectId, default: null }, // Vendor / User / Employee id
    lenderName: { type: String, required: true, trim: true },
    lenderPhone: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true }, // day the money came in
    method: { type: String, default: 'Cash' }, // how we received it
    dueDate: { type: Date, default: null },
    notes: { type: String, default: '' },
    repayments: { type: [repaymentSchema], default: [] },
    paid: { type: Number, default: 0 },
    left: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'paid'], default: 'open', index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

loanSchema.index({ isDeleted: 1, date: -1 });
loanSchema.index({ lenderType: 1, lender: 1 });

module.exports = mongoose.models.Loan || mongoose.model('Loan', loanSchema);
