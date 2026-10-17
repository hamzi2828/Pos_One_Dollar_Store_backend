// src/models/bank.js

const mongoose = require('mongoose');

const bankSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    accountNumber: {
        type: String,
        required: true,
        trim: true
    },
    accountTitle: {
        type: String,
        required: true,
        trim: true
    },
    branch: {
        type: String,
        default: '',
        trim: true
    },
    iban: {
        type: String,
        default: '',
        trim: true
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

bankSchema.index({ isDeleted: 1, createdAt: -1 });
bankSchema.index({ isDeleted: 1, isActive: 1 });
bankSchema.index(
    { name: 'text', accountNumber: 'text', accountTitle: 'text', iban: 'text', branch: 'text' },
    { name: 'bank_text_idx', weights: { name: 5, accountTitle: 4, accountNumber: 3, iban: 2, branch: 1 } }
);

module.exports = mongoose.models.Bank || mongoose.model('Bank', bankSchema);
