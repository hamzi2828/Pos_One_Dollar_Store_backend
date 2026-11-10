// src/models/bankStatement.js
// An uploaded bank statement checked against the POS ("BS-2026-00001").
// Its lines live in BankStatementLine (shared when two statements overlap).
// Logic: services/bankcheck/bankCheckService.js.
const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

const bankStatementSchema = new mongoose.Schema(
  {
    statementNo: { type: String, required: true, unique: true },
    bank: { type: ObjectId, ref: 'Bank', required: true, index: true },
    bankCode: { type: String, default: 'UBL' }, // layout the parser used
    fileName: { type: String, default: '' },
    originalUrl: { type: String, default: '' },
    markedUrl: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    periodFrom: { type: String, default: '' }, // 'YYYY-MM-DD' printed on the statement
    periodTo: { type: String, default: '' },
    checkFrom: { type: String, required: true }, // window the user asked to check
    checkTo: { type: String, required: true },
    counts: {
      ok: { type: Number, default: 0 },
      fix: { type: Number, default: 0 },
      missing: { type: Number, default: 0 },
      credits: { type: Number, default: 0 },
      reused: { type: Number, default: 0 },
    },
    totals: {
      debits: { type: Number, default: 0 },
      credits: { type: Number, default: 0 },
      ok: { type: Number, default: 0 },
      fix: { type: Number, default: 0 },
      missing: { type: Number, default: 0 },
    },
    // System records paid by bank in the window that are not on the statement.
    notOnStatement: { type: [Mixed], default: [] },
    // { cardSales, cardSettled, cashCounted, cashDeposited, otherIn[] }
    moneyIn: { type: Mixed, default: () => ({}) },
    checkedAt: { type: Date, default: Date.now },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

bankStatementSchema.index({ isDeleted: 1, createdAt: -1 });
bankStatementSchema.index({ bank: 1, isDeleted: 1, checkTo: -1 });

module.exports = mongoose.models.BankStatement || mongoose.model('BankStatement', bankStatementSchema);
