// src/models/hrPolicy.js
// Attendance & pay rules, created by the shop (HR → Policies) and assigned to
// employees (employee.hrPolicy; none = the default policy). Payroll copies the
// policy into each line when generated, so editing a policy never changes an
// approved month. Defaults = the owner's choices (Oct 2026):
//   grace 10 min · 3 lates = 1 day cut · absent = 1 day (salary ÷ 30)
//   overtime at the normal hourly rate (manager approves) · till shortage
//   deducted after manager approval.
const mongoose = require('mongoose');

const hrPolicySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    attendance: {
      // Minutes after shift start before a check-in counts as late.
      graceMinutes: { type: Number, min: 0, max: 240, default: 10 },
      lateRule: {
        // count   : every `latesPerCut` lates in a month cut `cutDays` days of pay
        // minutes : every late minute is cut at the minute rate
        // none    : lates are only reported
        type: { type: String, enum: ['count', 'minutes', 'none'], default: 'count' },
        latesPerCut: { type: Number, min: 1, max: 31, default: 3 },
        cutDays: { type: Number, min: 0, max: 5, default: 1 },
      },
      // Leaving more than this many minutes before shift end = early leave.
      earlyLeaveGraceMinutes: { type: Number, min: 0, max: 240, default: 10 },
      // An early leave also counts as one "late" for the late rule.
      earlyLeaveCountsAsLate: { type: Boolean, default: true },
      halfDay: {
        enabled: { type: Boolean, default: true },
        // Late by more than this many minutes -> half day instead of late.
        lateAfterMinutes: { type: Number, min: 0, max: 720, default: 120 },
        // Worked less than this % of the shift -> half day.
        minWorkedPct: { type: Number, min: 0, max: 100, default: 50 },
      },
      // A day with a check-in but no check-out (after the shift ended) counts as:
      missingOutCountsAs: { type: String, enum: ['present', 'half_day', 'absent'], default: 'present' },
    },

    pay: {
      // Day rate = monthly salary ÷ divisor.
      //   fixed       : `fixedDays` (30)
      //   month_days  : days in that month (28–31)
      //   working_days: scheduled working days of the employee that month
      dayDivisor: { type: String, enum: ['fixed', 'month_days', 'working_days'], default: 'fixed' },
      fixedDays: { type: Number, min: 1, max: 31, default: 30 },
      absentCutDays: { type: Number, min: 0, max: 3, default: 1 }, // days cut per absent day
      halfDayCut: { type: Number, min: 0, max: 1, default: 0.5 }, // fraction of a day cut per half day
      paidWeeklyOff: { type: Boolean, default: true }, // monthly staff: offs are paid (daily-wage: never)
      paidHolidays: { type: Boolean, default: true },
    },

    overtime: {
      enabled: { type: Boolean, default: true },
      rate: { type: Number, min: 0, max: 5, default: 1 }, // × hourly rate (1 = normal, 1.5 = time and a half)
      minMinutes: { type: Number, min: 0, max: 600, default: 30 }, // shorter extra time is ignored
      maxMinutesPerDay: { type: Number, min: 0, max: 1440, default: 240 },
      needsApproval: { type: Boolean, default: true },
    },

    leave: {
      paidPerMonth: { type: Number, min: 0, max: 31, default: 1 }, // paid leave days; more = unpaid
      sickPerMonth: { type: Number, min: 0, max: 31, default: 1 },
    },

    tillShortage: {
      deduct: { type: Boolean, default: true },
      needsApproval: { type: Boolean, default: true },
      maxPerMonth: { type: Number, min: 0, default: 0 }, // 0 = no cap
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false }
);

hrPolicySchema.plugin(require('../helper/softDeletePlugin'));
hrPolicySchema.index({ isDefault: 1 });

module.exports = mongoose.models.HrPolicy || mongoose.model('HrPolicy', hrPolicySchema);
