// src/models/payrollRun.js
// One payroll run per month: a line per employee with the numbers it was
// built from (policy snapshot, rates, attendance) and the money in plain words.
//
//   draft ──approve──► approved ──pay (every line)──► paid
//     ▲                   │
//     └──reopen (super admin, nothing paid yet)
//
// Approve locks the month's attendance, marks used deductions applied and
// records advance recoveries; reopen undoes all of that.
// OWNER: Payroll module (logic in services/hr/payrollService.js).
const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

const STATUSES = ['draft', 'approved', 'paid'];
const METHODS = ['cash', 'bank', 'easypaisa', 'jazzcash'];

// One earning / deduction row: { key, label, amount, detail } (amount in whole rupees, always >= 0).
const moneyRowSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    detail: { type: String, default: '' },
  },
  { _id: false }
);

// Manual +/- line added by the manager on a draft.
const adjustmentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true }, // + adds to pay, - takes from pay
    note: { type: String, default: '', trim: true },
  },
  { _id: true }
);

// Advance this line recovers from (balance at build time and what is taken).
const advanceItemSchema = new mongoose.Schema(
  {
    advance: { type: ObjectId, ref: 'SalaryAdvance', required: true },
    advanceNo: { type: String, default: '' },
    date: { type: Date, default: null },
    amount: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    installments: { type: Number, default: 1 },
    installmentNo: { type: Number, default: 1 },
    suggested: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
  },
  { _id: false }
);

// Approved PayrollDeduction this line cuts (fully or partly).
const deductionItemSchema = new mongoose.Schema(
  {
    deduction: { type: ObjectId, ref: 'PayrollDeduction', required: true },
    type: { type: String, default: '' },
    refNo: { type: String, default: '' },
    date: { type: Date, default: null },
    note: { type: String, default: '' },
    amount: { type: Number, default: 0 }, // full amount of the deduction
    used: { type: Number, default: 0 }, // cut this month (rest carried to next month)
  },
  { _id: false }
);

const lineSchema = new mongoose.Schema(
  {
    employee: { type: ObjectId, ref: 'Employee', required: true },
    name: { type: String, default: '' },
    code: { type: String, default: '' },
    designation: { type: String, default: '' },
    payType: { type: String, enum: ['monthly', 'daily'], default: 'monthly' },

    // Snapshot of the rules and rates used (editing a policy never changes this line).
    policy: { type: Mixed, default: () => ({}) },
    salary: { type: Number, default: 0 },
    dailyRate: { type: Number, default: 0 },
    dayRate: { type: Number, default: 0 },
    hourlyRate: { type: Number, default: 0 },
    divisor: { type: Number, default: 30 },
    divisorLabel: { type: String, default: '' },
    workHoursPerDay: { type: Number, default: 8 },
    employedDays: { type: Number, default: 0 },
    joinedOn: { type: String, default: '' }, // 'YYYY-MM-DD' when joined this month
    leftOn: { type: String, default: '' }, // 'YYYY-MM-DD' when left this month
    attendance: { type: Mixed, default: () => ({}) }, // monthSummary numbers

    earnings: { type: [moneyRowSchema], default: [] },
    deductions: { type: [moneyRowSchema], default: [] },
    gross: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    shortfall: { type: Number, default: 0 }, // deductions more than pay (net kept at 0)
    notes: { type: [String], default: [] }, // automatic notes (carried amounts, shortfall)

    // Manual inputs (kept by regenerate).
    bonus: { type: Number, default: 0, min: 0 },
    bonusNote: { type: String, default: '' },
    adjustments: { type: [adjustmentSchema], default: [] },
    advanceRecoveryOverride: { type: Number, default: null, min: 0 },
    note: { type: String, default: '' },

    advanceItems: { type: [advanceItemSchema], default: [] },
    advanceSuggested: { type: Number, default: 0 },
    advanceRecovery: { type: Number, default: 0 },
    deductionItems: { type: [deductionItemSchema], default: [] },

    payslipNo: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    paidAt: { type: Date, default: null },
    payment: { type: ObjectId, default: null }, // payments[]._id
  },
  { _id: true, minimize: false }
);

const paymentSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true }, // 1, 2, ... within the run
    date: { type: Date, required: true },
    method: { type: String, enum: METHODS, default: 'cash' },
    reference: { type: String, default: '' },
    amount: { type: Number, default: 0 }, // cash paid (sum of net)
    advanceRecovered: { type: Number, default: 0 }, // advances taken back on these lines
    // Salaries expense = salary earned = net paid + advance recovered (other deductions covered a loss).
    expenseAmount: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    lines: { type: [ObjectId], default: [] },
    expense: { type: ObjectId, ref: 'Expense', default: null }, // id chosen up front (retry safe)
    expensePosted: { type: Boolean, default: false },
    requestId: { type: String, default: '' },
    by: { type: ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const warningSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    level: { type: String, enum: ['info', 'warning'], default: 'warning' },
    message: { type: String, required: true },
    link: { type: String, default: '' },
    linkLabel: { type: String, default: '' },
    employee: { type: ObjectId, default: null },
    employeeName: { type: String, default: '' },
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

const payrollRunSchema = new mongoose.Schema(
  {
    runNo: { type: String, required: true, unique: true }, // PAY-2026-00001
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    monthLabel: { type: String, default: '' }, // 'Oct 2026'
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    daysInMonth: { type: Number, default: 30 },
    status: { type: String, enum: STATUSES, default: 'draft' },

    lines: { type: [lineSchema], default: [] },
    totals: {
      staff: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
      overtime: { type: Number, default: 0 },
      bonus: { type: Number, default: 0 },
      advanceRecovery: { type: Number, default: 0 },
      paid: { type: Number, default: 0 },
      unpaid: { type: Number, default: 0 },
      paidCount: { type: Number, default: 0 },
    },
    warnings: { type: [warningSchema], default: [] },
    payments: { type: [paymentSchema], default: [] },

    generatedAt: { type: Date, default: null },
    generatedBy: { type: ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: ObjectId, ref: 'User', default: null },
    // false while approval side effects (lock / applied / recoveries) are not finished.
    effectsDone: { type: Boolean, default: false },
    reopening: { type: Boolean, default: false },
    paidAt: { type: Date, default: null },
    rev: { type: Number, default: 0 }, // bumped on every payment (optimistic lock)

    createdBy: { type: ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, minimize: false }
);

// One run per month.
payrollRunSchema.index({ month: 1 }, { unique: true });
payrollRunSchema.index({ status: 1, month: -1 });

const PayrollRun = mongoose.models.PayrollRun || mongoose.model('PayrollRun', payrollRunSchema);
Object.assign(PayrollRun, { STATUSES, METHODS });

module.exports = PayrollRun;
