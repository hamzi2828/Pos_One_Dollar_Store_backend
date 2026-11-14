// src/models/expense.js

const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    category: {
        type: String,
        required: true,
        trim: true
    },
    categories: {
        type: [String],
        default: []
    },
    date: {
        type: Date,
        required: true,
        default: Date.now
    },
    paymentMethod: {
        type: String,
        trim: true,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'Bank Transfer', 'Check', 'Other'],
        default: 'Cash'
    },
    // Our bank account the money left from (Bank Transfer); name kept for lists.
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', default: null },
    // Paying what is left on an investment bill (services/investmentExpenseLink.js).
    investment: { type: mongoose.Schema.Types.ObjectId, ref: 'Investment', default: null, index: true },
    investmentTitle: { type: String, default: '', trim: true },
    bankName: { type: String, default: '', trim: true },
    // Cash paid from this counter's drawer: only that counter's till takes it off.
    // null = not tied to a counter (old rule: the next till to close takes it).
    counter: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleCounter', default: null },
    counterName: { type: String, default: '', trim: true },
    // Category "Refund": money given back on this POS bill (services/refundExpenseLink.js).
    // All refunds of one bill together never go over what was paid on it.
    posOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'POSOrder', default: null, index: true },
    posOrderNumber: { type: String, default: '', trim: true },
    // Added by a cashier (permission `till_expenses`) while this till was open. The
    // cashier sees / edits it only while that till is still open.
    cashSession: { type: mongoose.Schema.Types.ObjectId, ref: 'CashSession', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '', trim: true },
    reference: {
        type: String,
        default: '',
        trim: true
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    // Old single receipt url. Kept = first of `receipts` so old screens still work.
    receipt: {
        type: String,
        default: null
    },
    // Receipt / slip images (max 10). Old records may have only `receipt`.
    receipts: {
        type: [
            {
                _id: false,
                url: { type: String, required: true },
                originalName: { type: String, default: '' },
                uploadedAt: { type: Date, default: Date.now },
            },
        ],
        default: [],
    },
    isActive: {
        type: Boolean,
        default: true
    },
    // Branch that spent the money. null = old record = main branch.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },
    // Where the expense came from: typed by hand, or posted automatically
    // (shop_use = items taken from our own stock for the shop, valued at cost).
    source: { type: String, enum: ['manual', 'shop_use', 'till_payout', 'payroll', 'other'], default: 'manual', index: true },
    sourceType: { type: String, default: '' }, // e.g. 'ShopUse'
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    // The amount is not edited directly (owner 2026-11-06): each change is a + / − adjustment.
    // amount = originalAmount + sum of adjustments.
    originalAmount: { type: Number, default: null },
    adjustments: {
        type: [
            {
                _id: false,
                amount: { type: Number, required: true }, // + more spent, − less
                note: { type: String, default: '' },
                by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
                byName: { type: String, default: '' },
                at: { type: Date, default: Date.now },
            },
        ],
        default: [],
    },
    // Paid from someone's personal money (owner 2026-11-06): a loan is made for it
    // too (models/loan.js `expense`), so both sides match. Not taken from the till.
    fromPersonal: { type: Boolean, default: false },
    loan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', default: null, index: true },
    loanNo: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

expenseSchema.index({ isDeleted: 1, date: -1 });
expenseSchema.index({ branch: 1, isDeleted: 1, date: -1 });
expenseSchema.index({ isDeleted: 1, category: 1, date: -1 });
expenseSchema.index({ isDeleted: 1, paymentMethod: 1 });
expenseSchema.index({ isDeleted: 1, isActive: 1, date: -1 });
expenseSchema.index({ isDeleted: 1, amount: -1 });
expenseSchema.index(
    { title: 'text', category: 'text', reference: 'text', notes: 'text' },
    { name: 'expense_text_idx', weights: { title: 5, category: 3, reference: 2, notes: 1 } }
);

// Receipts list for any expense (doc or lean): old records give their single
// `receipt` as the only item.
expenseSchema.statics.receiptsOf = function receiptsOf(e) {
    if (!e) return [];
    const list = (Array.isArray(e.receipts) ? e.receipts : []).filter((r) => r && r.url);
    if (!list.length && e.receipt) return [{ url: e.receipt, originalName: '', uploadedAt: e.createdAt || null }];
    return list.map((r) => ({ url: r.url, originalName: r.originalName || '', uploadedAt: r.uploadedAt || null }));
};

module.exports = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
