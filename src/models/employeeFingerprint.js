// src/models/employeeFingerprint.js
// Fingerprints for the desktop attendance app (pos_desktop). OWNER: Desktop attendance module.
//
// EmployeeFingerprint: one row per employee per finger (at most 2 fingers each,
// enforced in services/hr/desktopService.js). `template` is the DigitalPersona
// enrolment template, serialized and base64-encoded by the desktop app. Matching
// is done ON the counter PC (the DigitalPersona engine is Windows-only), so the
// server only stores templates and hands them to the desk.
//
// Removing a finger keeps the row (deletedAt set, template wiped) so a desk that
// syncs with ?updatedSince= learns about the removal. Enrolling the same finger
// again re-uses the row.
//
// DesktopPunch: the clientIds of fingerprint punches already processed, so a
// desk that retries (lost answer, offline queue sent twice) gets the original
// result instead of a second punch. Rows expire after 7 days (TTL index).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const FINGERS = [
  'right_thumb',
  'right_index',
  'right_middle',
  'right_ring',
  'right_little',
  'left_thumb',
  'left_index',
  'left_middle',
  'left_ring',
  'left_little',
];

const employeeFingerprintSchema = new mongoose.Schema(
  {
    employee: { type: ObjectId, ref: 'Employee', required: true },
    finger: { type: String, enum: FINGERS, required: true },
    // Base64 DigitalPersona template. Never returned by ordinary queries.
    template: { type: String, default: null, select: false },
    // 0-100, as reported by the desk (share of good scans). Optional.
    quality: { type: Number, min: 0, max: 100, default: null },
    enrolledBy: { type: ObjectId, ref: 'User', default: null },
    enrolledAt: { type: Date, default: Date.now },
    deviceName: { type: String, default: '', trim: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

employeeFingerprintSchema.index({ employee: 1, finger: 1 }, { unique: true });
employeeFingerprintSchema.index({ deletedAt: 1, updatedAt: 1 });

const desktopPunchSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  employee: { type: ObjectId, ref: 'Employee', required: true },
  status: { type: String, enum: ['pending', 'done'], default: 'pending' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
});

const EmployeeFingerprint =
  mongoose.models.EmployeeFingerprint || mongoose.model('EmployeeFingerprint', employeeFingerprintSchema);
const DesktopPunch = mongoose.models.DesktopPunch || mongoose.model('DesktopPunch', desktopPunchSchema);

EmployeeFingerprint.FINGERS = FINGERS;
EmployeeFingerprint.MAX_PER_EMPLOYEE = 2;
EmployeeFingerprint.DesktopPunch = DesktopPunch;

module.exports = EmployeeFingerprint;
