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
    receipt: {
        type: String,
        default: null
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

module.exports = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
