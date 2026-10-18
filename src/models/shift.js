// src/models/shift.js
// A shift type the shop works, e.g. "Morning 10:00–18:00" or "Evening 16:00–00:00".
// Times are shop time (Asia/Karachi). end <= start means the shift ends after
// midnight (next day). breakMinutes is unpaid break time inside the shift.
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true, default: '' }, // short label for the roster grid, e.g. "M"
    start: { type: String, required: true, match: HHMM },
    end: { type: String, required: true, match: HHMM },
    breakMinutes: { type: Number, min: 0, max: 600, default: 0 },
    color: { type: String, default: '#FFD60A' },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

shiftSchema.plugin(require('../helper/softDeletePlugin'));
shiftSchema.index({ isActive: 1, sortOrder: 1 });

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** Minutes from shift start to shift end (crosses midnight when end <= start). */
shiftSchema.statics.spanMinutes = (start, end) => {
  const s = toMin(start);
  const e = toMin(end);
  return e > s ? e - s : e + 24 * 60 - s;
};
/** Paid working minutes = span - break. */
shiftSchema.statics.workMinutes = (shift) =>
  Math.max(0, shiftSchema.statics.spanMinutes(shift.start, shift.end) - (Number(shift.breakMinutes) || 0));

const Shift = mongoose.models.Shift || mongoose.model('Shift', shiftSchema);
Shift.HHMM = HHMM;
Shift.toMin = toMin;

module.exports = Shift;
