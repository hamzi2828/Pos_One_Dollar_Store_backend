// src/models/employeeApplication.js
// A job application sent through the public "join" link (/join/<token>).
// Waits in HR until the owner approves (creates the Employee) or rejects it.
// Only personal details are kept — never salary, role, designation or status.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;
const STATUSES = ['pending', 'approved', 'rejected'];

const fileSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    name: { type: String, default: '' },
    type: { type: String, default: 'image' }, // image | pdf
  },
  { _id: false }
);

const employeeApplicationSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true }, // APP-0001 (sequenceService)
    status: { type: String, enum: STATUSES, default: 'pending' },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: '', trim: true },
    fatherHusbandName: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, default: null },
    cnic: { type: String, default: null },
    cnicExpiry: { type: Date, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null },
    maritalStatus: { type: String, default: null },
    qualification: { type: String, default: null },
    experience: { type: String, default: null },
    previousEmployer: { type: String, default: null },
    address: { type: mongoose.Schema.Types.Mixed, default: null },
    emergencyContact: { type: mongoose.Schema.Types.Mixed, default: null },
    guarantor: { type: mongoose.Schema.Types.Mixed, default: null },
    bankDetails: { type: mongoose.Schema.Types.Mixed, default: null },
    photo: { type: String, default: null },
    files: { type: [fileSchema], default: [] },

    ip: { type: String, default: null }, // never returned by the API
    userAgent: { type: String, default: null },

    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: ObjectId, ref: 'User', default: null },
    reviewedByName: { type: String, default: null },
    rejectReason: { type: String, default: null },
    employee: { type: ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true }
);

employeeApplicationSchema.index({ status: 1, createdAt: -1 });
employeeApplicationSchema.index({ cnic: 1, status: 1 });
employeeApplicationSchema.index({ reference: 1 }, { unique: true });

const EmployeeApplication =
  mongoose.models.EmployeeApplication || mongoose.model('EmployeeApplication', employeeApplicationSchema);
EmployeeApplication.STATUSES = STATUSES;

module.exports = EmployeeApplication;
