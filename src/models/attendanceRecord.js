// src/models/attendanceRecord.js
// One row per employee per shop day that has punches or a manual entry.
// Days with no row are still evaluated (absent / off / leave / holiday) from the
// plan — see services/hr/attendanceCore.js (the ONLY writer of the computed fields).
const mongoose = require('mongoose');

const STATUSES = ['pending', 'present', 'late', 'half_day', 'absent', 'missing_out', 'leave', 'off', 'holiday'];

const punchSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    kind: { type: String, enum: ['in', 'out'], required: true },
    source: { type: String, enum: ['kiosk', 'manual', 'device'], default: 'kiosk' },
    photo: { type: String, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { _id: true }
);

const correctionSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    field: { type: String, required: true }, // checkIn | checkOut | overtime | status
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const attendanceRecordSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // shop day of the planned shift
    // Plan snapshot at the last evaluation (scheduleService.planFor).
    planned: {
      type: { type: String, enum: ['shift', 'off', 'leave', 'holiday', 'none'], default: 'none' },
      shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
      shiftName: { type: String, default: '' },
      start: { type: Date, default: null },
      end: { type: Date, default: null },
      breakMinutes: { type: Number, default: 0 },
      leaveType: { type: String, default: null },
      holidayName: { type: String, default: '' },
    },
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },
    punches: { type: [punchSchema], default: [] },

    // ---- computed (attendanceCore.evaluate) ----
    status: { type: String, enum: STATUSES, default: 'pending' },
    lateMinutes: { type: Number, default: 0 },
    earlyLeaveMinutes: { type: Number, default: 0 },
    workedMinutes: { type: Number, default: 0 },
    overtimeMinutes: { type: Number, default: 0 }, // eligible overtime (policy minimum applied)
    // Overtime approval: null = waiting (when the policy needs approval), true / false = decided.
    overtimeApproved: { type: Boolean, default: null },
    overtimeDecidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    corrections: { type: [correctionSchema], default: [] },
    note: { type: String, default: '' },
    // Locked when the month's payroll is approved: no more punches / corrections.
    locked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attendanceRecordSchema.index({ employee: 1, date: 1 }, { unique: true });
attendanceRecordSchema.index({ date: 1, status: 1 });

const AttendanceRecord = mongoose.models.AttendanceRecord || mongoose.model('AttendanceRecord', attendanceRecordSchema);
AttendanceRecord.STATUSES = STATUSES;

module.exports = AttendanceRecord;
