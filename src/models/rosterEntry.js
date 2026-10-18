// src/models/rosterEntry.js
// One cell of the roster: what an employee does on a shop day when it differs
// from (or confirms) their default (employee.defaultShift + weeklyOff).
//   type 'shift' : works `shift` that day
//   type 'off'   : day off
//   type 'leave' : on leave (paid / unpaid / sick — quotas from the HR policy)
// No entry = default plan (see services/hr/scheduleService.js).
const mongoose = require('mongoose');

const LEAVE_TYPES = ['paid', 'unpaid', 'sick'];

const rosterEntrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: { type: String, enum: ['shift', 'off', 'leave'], required: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    leaveType: { type: String, enum: [...LEAVE_TYPES, null], default: null },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

rosterEntrySchema.index({ employee: 1, date: 1 }, { unique: true });
rosterEntrySchema.index({ date: 1 });

const RosterEntry = mongoose.models.RosterEntry || mongoose.model('RosterEntry', rosterEntrySchema);
RosterEntry.LEAVE_TYPES = LEAVE_TYPES;

module.exports = RosterEntry;
