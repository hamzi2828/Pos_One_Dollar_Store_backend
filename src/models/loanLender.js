// src/models/loanLender.js
// People we borrow money from (saved once, picked from a list on Finance > Loans).
const mongoose = require('mongoose');

const loanLenderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

loanLenderSchema.index({ isDeleted: 1, name: 1 });

module.exports = mongoose.models.LoanLender || mongoose.model('LoanLender', loanLenderSchema);
