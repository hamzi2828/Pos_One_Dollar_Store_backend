// src/models/employee.js
// Employee record (HR). Not a login: a staff login is a User; `user` links the two.
//
// Fields other modules rely on (keep meaningful): _id, firstName, lastName,
// name (virtual), isActive, branch, position.
//   - isActive is derived from status (active / on_leave = true).
//   - position mirrors designation (old screens read `position`).
//   - hireDate mirrors joiningDate (old screens read `hireDate`).
//   - salary is the GROSS monthly salary (basic + allowances when a breakdown is set).
// Deleted rows keep isDeleted = true: filter with { isDeleted: { $ne: true } }.

const mongoose = require('mongoose');
const { nextNumber } = require('../services/sequenceService');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EMPLOYMENT_TYPES = ['permanent', 'contract', 'probation', 'part_time', 'daily_wage'];
const STATUSES = ['active', 'on_leave', 'resigned', 'terminated'];
const DOCUMENT_TYPES = ['cnic_front', 'cnic_back', 'photo', 'cv', 'contract', 'other'];
const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced'];
const ACTIVE_STATUSES = ['active', 'on_leave'];

const { ObjectId } = mongoose.Schema.Types;

const documentSchema = new mongoose.Schema(
    {
        type: { type: String, enum: DOCUMENT_TYPES, default: 'other' },
        name: { type: String, default: '', trim: true },
        url: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: ObjectId, ref: 'User', default: null },
    },
    { _id: true }
);

const contractIssuedSchema = new mongoose.Schema(
    {
        issuedAt: { type: Date, default: Date.now },
        templateId: { type: ObjectId, ref: 'ContractTemplate', default: null },
        templateName: { type: String, default: '' },
        startDate: { type: Date, default: null },
        endDate: { type: Date, default: null },
        salary: { type: Number, default: 0 },
        designation: { type: String, default: '' },
        issuedBy: { type: ObjectId, ref: 'User', default: null },
        issuedByName: { type: String, default: '' },
        note: { type: String, default: '' },
    },
    { _id: true }
);

const historySchema = new mongoose.Schema(
    {
        at: { type: Date, default: Date.now },
        by: { type: ObjectId, ref: 'User', default: null },
        action: { type: String, required: true },
        note: { type: String, default: '' },
    },
    { _id: false }
);

const employeeSchema = new mongoose.Schema({
    // EMP-2026-00001 (sequenceService). Set automatically on create.
    employeeCode: { type: String, default: undefined, trim: true },
    firstName: { type: String, required: true, trim: true },
    // Optional: many people use a single name.
    lastName: { type: String, default: '', trim: true },
    branch: { type: ObjectId, ref: 'Branch', default: null, index: true },
    // Optional link to this person's staff login (User with a staff role).
    user: { type: ObjectId, ref: 'User', default: null },
    photo: { type: String, default: null },

    // ----- Personal -----
    phone: { type: String, default: null },
    email: { type: String, default: null, trim: true, lowercase: true },
    cnic: { type: String, default: null }, // 12345-1234567-1 (validated in services/hr)
    cnicExpiry: { type: Date, default: null },
    fatherHusbandName: { type: String, default: null, trim: true },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', 'other', null], default: null },
    maritalStatus: { type: String, enum: [...MARITAL_STATUSES, null], default: null },
    qualification: { type: String, default: null, trim: true },
    experience: { type: String, default: null, trim: true },
    previousEmployer: { type: String, default: null, trim: true },
    address: {
        street: { type: String, default: null },
        city: { type: String, default: null },
        state: { type: String, default: null },
        zipCode: { type: String, default: null },
        country: { type: String, default: 'Pakistan' }
    },

    // ----- Job -----
    designation: { type: String, default: null, trim: true },
    position: { type: String, default: null }, // = designation (legacy name)
    department: { type: String, default: null },
    // Stores the `name` of a Role document (e.g. "Admin", "Store Manager").
    // Dynamic — any role defined in the Roles & Permissions screen is valid.
    role: { type: String, default: 'employee', trim: true },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'permanent' },
    joiningDate: { type: Date, default: null },
    hireDate: { type: Date, default: Date.now }, // = joiningDate (legacy name)
    probationEndDate: { type: Date, default: null },
    contractStartDate: { type: Date, default: null },
    contractEndDate: { type: Date, default: null },
    // Old free-text shift times (used only when no defaultShift is set).
    shift: {
        start: { type: String, default: null }, // "10:00"
        end: { type: String, default: null }, // "22:00"
    },
    weeklyOff: [{ type: String, enum: DAYS }],

    // ----- Time & attendance (services/hr/scheduleService.js, attendanceCore.js) -----
    // Planned shift on days the roster says nothing (weekly off days excepted).
    defaultShift: { type: ObjectId, ref: 'Shift', default: null },
    // Attendance & pay rules; null = the default HR policy.
    hrPolicy: { type: ObjectId, ref: 'HrPolicy', default: null },
    // monthly = salary per month; daily = dailyRate per day worked (helpers).
    payType: { type: String, enum: ['monthly', 'daily'], default: 'monthly' },
    dailyRate: { type: Number, min: 0, default: 0 },
    // Clock-in is by fingerprint only (models/employeeFingerprint.js, desktop app).

    // ----- Salary (PKR / month) -----
    salary: { type: Number, required: true, default: 0, min: 0 }, // gross
    salaryBreakdown: {
        basic: { type: Number, default: 0, min: 0 },
        allowances: [
            {
                _id: false,
                name: { type: String, trim: true, required: true },
                amount: { type: Number, default: 0, min: 0 },
            },
        ],
    },
    salaryPayDay: { type: Number, default: 7, min: 1, max: 28 }, // paid by this day of the next month
    salaryPaymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'cheque'], default: 'cash' },
    bankDetails: {
        accountTitle: { type: String, default: null },
        accountNumber: { type: String, default: null },
        bankName: { type: String, default: null },
        iban: { type: String, default: null },
    },

    // ----- Guarantor / reference & emergency contact -----
    guarantor: {
        name: { type: String, default: null, trim: true },
        cnic: { type: String, default: null },
        phone: { type: String, default: null, trim: true },
        relation: { type: String, default: null, trim: true },
        address: { type: String, default: null, trim: true },
    },
    emergencyContact: {
        name: { type: String, default: null },
        phone: { type: String, default: null },
        relationship: { type: String, default: null }
    },

    documents: { type: [documentSchema], default: [] },

    // ----- Status -----
    status: {
        type: String,
        enum: STATUSES,
        // Old rows have only isActive: keep inactive ones inactive.
        default: function defaultStatus() {
            return this.isActive === false ? 'terminated' : 'active';
        },
    },
    exitDate: { type: Date, default: null },
    exitReason: { type: String, default: null, trim: true },

    contractsIssued: { type: [contractIssuedSchema], default: [] },
    history: { type: [historySchema], default: [] },

    notes: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null }
}, { timestamps: true });

employeeSchema.virtual('name').get(function() {
    return `${this.firstName || ''} ${this.lastName || ''}`.trim();
});

// Keep the legacy mirrors and derived fields in step on every save.
employeeSchema.pre('validate', async function syncDerived() {
    if (this.isNew && !this.employeeCode) this.employeeCode = await nextNumber('EMP');

    if (this.joiningDate) this.hireDate = this.joiningDate;
    else if (this.hireDate) this.joiningDate = this.hireDate;

    if (this.designation) this.position = this.designation;
    else if (this.position) this.designation = this.position;

    const b = this.salaryBreakdown || {};
    const allowances = (b.allowances || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    if ((Number(b.basic) || 0) > 0 || allowances > 0) {
        this.salary = Math.round(((Number(b.basic) || 0) + allowances) * 100) / 100;
    }

    this.isActive = ACTIVE_STATUSES.includes(this.status);
});

employeeSchema.set('toJSON', { virtuals: true });
employeeSchema.set('toObject', { virtuals: true });

// Performance indexes — match real query patterns (filter + sort)
employeeSchema.index({ isDeleted: 1, createdAt: -1 });
employeeSchema.index({ isDeleted: 1, isActive: 1 });
employeeSchema.index({ isDeleted: 1, role: 1 });
employeeSchema.index({ isDeleted: 1, gender: 1 });
employeeSchema.index({ firstName: 1, lastName: 1 });
employeeSchema.index({ isDeleted: 1, branch: 1, status: 1, createdAt: -1 });
employeeSchema.index({ isDeleted: 1, branch: 1, department: 1 });
employeeSchema.index({ employeeCode: 1 }, { unique: true, partialFilterExpression: { employeeCode: { $type: 'string' } } });
employeeSchema.index({ cnic: 1 });
employeeSchema.index({ user: 1 });
employeeSchema.index(
    { firstName: 'text', lastName: 'text', phone: 'text', cnic: 'text', position: 'text', department: 'text' },
    { name: 'employee_text_idx', weights: { firstName: 5, lastName: 5, cnic: 3, phone: 2, position: 2, department: 1 } }
);

const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
Object.assign(Employee, { DAYS, EMPLOYMENT_TYPES, STATUSES, DOCUMENT_TYPES, MARITAL_STATUSES, ACTIVE_STATUSES });

module.exports = Employee;
