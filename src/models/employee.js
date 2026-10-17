// src/models/employee.js

const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, default: null },
    cnic: { type: String, default: null },
    position: { type: String, default: null },
    department: { type: String, default: null },
    // Stores the `name` of a Role document (e.g. "Admin", "Store Manager").
    // Dynamic — any role defined in the Roles & Permissions screen is valid.
    role: { type: String, default: 'employee', trim: true },
    salary: { type: Number, required: true },
    hireDate: { type: Date, default: Date.now },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', 'other'], default: null },
    address: {
        street: { type: String, default: null },
        city: { type: String, default: null },
        state: { type: String, default: null },
        zipCode: { type: String, default: null },
        country: { type: String, default: 'Pakistan' }
    },
    emergencyContact: {
        name: { type: String, default: null },
        phone: { type: String, default: null },
        relationship: { type: String, default: null }
    },
    bankDetails: {
        accountTitle: { type: String, default: null },
        accountNumber: { type: String, default: null },
        bankName: { type: String, default: null }
    },
    notes: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

employeeSchema.virtual('name').get(function() {
    return `${this.firstName} ${this.lastName}`.trim();
});

employeeSchema.set('toJSON', { virtuals: true });
employeeSchema.set('toObject', { virtuals: true });

// Performance indexes — match real query patterns (filter + sort)
employeeSchema.index({ isDeleted: 1, createdAt: -1 });
employeeSchema.index({ isDeleted: 1, isActive: 1 });
employeeSchema.index({ isDeleted: 1, role: 1 });
employeeSchema.index({ isDeleted: 1, gender: 1 });
employeeSchema.index({ firstName: 1, lastName: 1 });
employeeSchema.index(
    { firstName: 'text', lastName: 'text', phone: 'text', cnic: 'text', position: 'text', department: 'text' },
    { name: 'employee_text_idx', weights: { firstName: 5, lastName: 5, cnic: 3, phone: 2, position: 2, department: 1 } }
);

module.exports = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
