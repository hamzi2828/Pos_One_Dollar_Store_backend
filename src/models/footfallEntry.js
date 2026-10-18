// src/models/footfallEntry.js
// Visitors counted in a branch on one day (typed by staff, optional). The
// footfall report divides bills by visitors to get the conversion %.
const mongoose = require('mongoose');

const footfallEntrySchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // Pakistan calendar day 'YYYY-MM-DD' (what the report groups by).
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    // 00:00 PKT of that day.
    date: { type: Date, required: true },
    visitors: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: '', maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One count per branch per day.
footfallEntrySchema.index({ branch: 1, day: 1 }, { unique: true });
footfallEntrySchema.index({ day: 1 });

module.exports = mongoose.models.FootfallEntry || mongoose.model('FootfallEntry', footfallEntrySchema);
