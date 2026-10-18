// src/models/holiday.js
// Shop holiday (Eid, 14 August...). On a holiday nobody is scheduled unless the
// roster says otherwise; whether it is paid comes from the employee's HR policy.
const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // shop day 'YYYY-MM-DD'
    name: { type: String, required: true, trim: true },
    // Shop closed? false = open but staff who work get holiday (overtime) treatment later.
    shopClosed: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

holidaySchema.index({ date: 1 }, { unique: true });

module.exports = mongoose.models.Holiday || mongoose.model('Holiday', holidaySchema);
