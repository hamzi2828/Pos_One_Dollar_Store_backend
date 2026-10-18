// src/models/categoryAssignment.js
// Employees who look after a product category. Their progress = the
// category's net sales × their share (equal split when no shares are set),
// compared with the monthly target (see services/analytics/categoryPerformanceService.js).
const mongoose = require('mongoose');

const assigneeSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    // % of the category's sales credited to this employee. null on every row = equal split.
    sharePct: { type: Number, min: 0, max: 100, default: null },
  },
  { _id: false }
);

const categoryAssignmentSchema = new mongoose.Schema(
  {
    // Product category name (Product.category / POS line category).
    category: { type: String, required: true, trim: true, maxlength: 120 },
    // Lower-case category for matching (sales snapshots may differ in case).
    categoryKey: { type: String, required: true, trim: true, lowercase: true },
    // Branch the assignment is for. null = every branch.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    employees: { type: [assigneeSchema], default: [] },
    // Net sales target for one calendar month (PKR); pro-rated for other periods.
    monthlyTarget: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: '', maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        action: { type: String },
        note: { type: String, default: '' },
      },
    ],
  },
  { timestamps: true }
);

categoryAssignmentSchema.index({ categoryKey: 1, branch: 1 });
categoryAssignmentSchema.index({ branch: 1, isActive: 1, category: 1 });
categoryAssignmentSchema.index({ 'employees.employee': 1 });

categoryAssignmentSchema.plugin(require('../helper/softDeletePlugin'));

module.exports = mongoose.models.CategoryAssignment || mongoose.model('CategoryAssignment', categoryAssignmentSchema);
