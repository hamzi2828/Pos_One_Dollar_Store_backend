// src/models/payrollDeduction.js
// A one-off amount to take from an employee's pay: till shortage (from a
// verified cash closing), damage caused by staff, or other. The manager
// approves or waives it; payroll applies approved ones and marks them applied.
const mongoose = require('mongoose');

const payrollDeductionSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    // absent / half_day / late: attendance cuts (owner, 2026-11-17) — never cut until approved here.
    // missing_item / staff_purchase / fine / uniform: more hand-added kinds (owner, 2026-11-19).
    type: {
      type: String,
      enum: ['till_shortage', 'damage', 'other', 'absent', 'half_day', 'late', 'missing_item', 'staff_purchase', 'fine', 'uniform'],
      required: true,
    },
    // createdBy below = who added it ("Added by" on the Deductions tab).
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
    // Attendance cuts: the cut amount this row stands for (stays the same when approved for less).
    covers: { type: Number, default: null },
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
