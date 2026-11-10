// src/models/bankStatementLine.js
// One transaction from a bank statement and what it matched in the POS.
// key = date|direction|amount|balance, unique per bank: a line seen on an
// earlier statement is reused, never matched again.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const bankStatementLineSchema = new mongoose.Schema(
  {
    bank: { type: ObjectId, ref: 'Bank', required: true },
    key: { type: String, required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    seq: { type: Number, default: 0 }, // order on the statement
    particulars: { type: String, default: '' },
    payee: { type: String, default: '' },
    kind: { type: String, default: '' }, // transfer_out, card, cash, transfer_in, charge, ...
    direction: { type: String, enum: ['out', 'in'], required: true },
    amount: { type: Number, required: true },
    balance: { type: Number, required: true },
    status: { type: String, enum: ['ok', 'fix', 'missing', 'in'], required: true },
    issue: { type: String, default: '' },
    // { src, id, subId, ref, label, date, amount, method }
    match: { type: mongoose.Schema.Types.Mixed, default: null },
    // Owner's decision; kept on re-check. { status, note, by, byName, at }
    manual: { type: mongoose.Schema.Types.Mixed, default: null },
    firstStatement: { type: ObjectId, ref: 'BankStatement', default: null },
    statements: { type: [ObjectId], default: [], index: true },
  },
  { timestamps: true }
);

bankStatementLineSchema.index({ bank: 1, key: 1 }, { unique: true });
bankStatementLineSchema.index({ 'match.src': 1, 'match.id': 1 });

module.exports = mongoose.models.BankStatementLine || mongoose.model('BankStatementLine', bankStatementLineSchema);
