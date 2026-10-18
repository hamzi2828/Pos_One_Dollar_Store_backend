// src/models/payrollDeduction.js
// A one-off amount to take from an employee's pay: till shortage (from a
// verified cash closing), damage caused by staff, or other. The manager
// approves or waives it; payroll applies approved ones and marks them applied.
const mongoose = require('mongoose');

const payrollDeductionSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: ['till_shortage', 'damage', 'other'], required: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now },
    refType: { type: String, default: '' }, // 'CashSession' ...
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNo: { type: String, default: '' },
    note: { type: String, default: '', trim: true },
    status: { type: String, enum: ['pending', 'approved', 'waived', 'applied'], default: 'pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    appliedMonth: { type: String, default: '' }, // 'YYYY-MM'
    appliedRun: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

payrollDeductionSchema.index({ employee: 1, status: 1 });
// One deduction per source document (a cash session is never deducted twice).
payrollDeductionSchema.index(
  { refType: 1, refId: 1 },
  { unique: true, partialFilterExpression: { refId: { $type: 'objectId' } } }
);

module.exports = mongoose.models.PayrollDeduction || mongoose.model('PayrollDeduction', payrollDeductionSchema);
