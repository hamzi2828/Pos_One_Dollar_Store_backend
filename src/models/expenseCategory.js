// src/models/expenseCategory.js

const mongoose = require('mongoose');

const expenseCategorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    description: {
        type: String,
        default: '',
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedAt: {
        type: Date,
        default: null
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
}, { timestamps: true });

expenseCategorySchema.index({ isDeleted: 1, isActive: 1, name: 1 });

module.exports = mongoose.models.ExpenseCategory || mongoose.model('ExpenseCategory', expenseCategorySchema);
