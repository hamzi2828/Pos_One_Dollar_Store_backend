// src/models/staffTip.js
// A tip (gift money) given to an employee. It is NOT part of salary: payroll
// never reads it. Each tip posts one Expense in the "Staff Tips" category
// (source 'other', sourceType 'Tip', sourceRef = tip id), so the day's till
// closing counts it like any other expense. Deleting a tip soft-deletes it and
// its expense.
//
// OWNER: Payroll module (logic in services/hr/tipService.js).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const METHODS = ['cash', 'bank', 'easypaisa', 'jazzcash'];

const staffTipSchema = new mongoose.Schema(
  {
    tipNo: { type: String, required: true, unique: true }, // TIP-2026-00001
    employee: { type: ObjectId, ref: 'Employee', required: true },
    employeeName: { type: String, default: '' }, // denormalized for lists
    employeeCode: { type: String, default: '' },
    amount: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true }, // noon PKT of the shop day
    day: { type: String, required: true }, // 'YYYY-MM-DD' (PKT)
    method: { type: String, enum: METHODS, default: 'cash' },
    note: { type: String, default: '', trim: true },
    expense: { type: ObjectId, ref: 'Expense', default: null },
    branch: { type: ObjectId, ref: 'Branch', default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null },
    deleteReason: { type: String, default: '' },
  },
  { timestamps: true }
);

staffTipSchema.index({ isDeleted: 1, date: -1, _id: -1 });
staffTipSchema.index({ employee: 1, isDeleted: 1, date: -1 });

const StaffTip = mongoose.models.StaffTip || mongoose.model('StaffTip', staffTipSchema);
Object.assign(StaffTip, { METHODS });

module.exports = StaffTip;
