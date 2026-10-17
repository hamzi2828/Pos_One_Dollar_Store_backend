// src/models/salary.js

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    paymentMethod: { type: String, enum: ['cash', 'bank', 'bank_transfer', 'cheque', 'other'], default: 'cash' },
    notes: { type: String, default: null }
}, { _id: true });

const salarySchema = new mongoose.Schema({
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    baseSalary: { type: Number, required: true },
    month: { type: String, required: true },
    year: { type: Number, required: true },
    payments: [paymentSchema],
    totalPaid: { type: Number, default: 0 },
    remainingBalance: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
    notes: { type: String, default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

salarySchema.pre('save', function(next) {
    this.totalPaid = this.payments.reduce((sum, payment) => sum + payment.amount, 0);
    this.remainingBalance = this.baseSalary - this.totalPaid;

    if (this.totalPaid === 0) {
        this.status = 'pending';
    } else if (this.totalPaid >= this.baseSalary) {
        this.status = 'paid';
        this.remainingBalance = 0;
    } else {
        this.status = 'partial';
    }

    next();
});

salarySchema.index(
    { employee: 1, month: 1, year: 1 },
    { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);
salarySchema.index({ isDeleted: 1, year: -1, createdAt: -1 });
salarySchema.index({ isDeleted: 1, status: 1 });
salarySchema.index({ isDeleted: 1, employee: 1 });
salarySchema.index({ isDeleted: 1, month: 1, year: 1 });

module.exports = mongoose.models.Salary || mongoose.model('Salary', salarySchema);
