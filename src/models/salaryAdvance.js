// src/models/salaryAdvance.js
// Money given to an employee before payday, taken back from salary in
// `installments` months. Payroll approval records each recovery (and reopen
// removes it again), so `recovered` + `balance` always equal `amount`.
//
//   open ──(payroll recovers the last rupee)──► recovered
//   open ──cancel (nothing recovered yet)──────► cancelled
//
// OWNER: Payroll module (logic in services/hr/payrollService.js).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const METHODS = ['cash', 'bank', 'easypaisa', 'jazzcash'];
const STATUSES = ['open', 'recovered', 'cancelled'];

const recoverySchema = new mongoose.Schema(
  {
    run: { type: ObjectId, ref: 'PayrollRun', required: true },
    runNo: { type: String, default: '' },
    month: { type: String, default: '' }, // 'YYYY-MM'
    amount: { type: Number, required: true, min: 0 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: 'User', default: null },
    action: { type: String, required: true },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const salaryAdvanceSchema = new mongoose.Schema(
  {
    advanceNo: { type: String, required: true, unique: true }, // ADV-2026-00001
    employee: { type: ObjectId, ref: 'Employee', required: true },
    employeeName: { type: String, default: '' }, // denormalized for lists
    employeeCode: { type: String, default: '' },
    amount: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    method: { type: String, enum: METHODS, default: 'cash' },
    reference: { type: String, default: '', trim: true },
    installments: { type: Number, min: 1, max: 24, default: 1 }, // months to recover it in
    note: { type: String, default: '', trim: true },

    recovered: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0, min: 0 },
    recoveries: { type: [recoverySchema], default: [] },
    status: { type: String, enum: STATUSES, default: 'open' },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '' },

    createdBy: { type: ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

salaryAdvanceSchema.index({ employee: 1, status: 1, date: 1 });
salaryAdvanceSchema.index({ status: 1, date: -1 });
salaryAdvanceSchema.index({ date: -1, _id: -1 });

const SalaryAdvance = mongoose.models.SalaryAdvance || mongoose.model('SalaryAdvance', salaryAdvanceSchema);
Object.assign(SalaryAdvance, { METHODS, STATUSES });

module.exports = SalaryAdvance;
