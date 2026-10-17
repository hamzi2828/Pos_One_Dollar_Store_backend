// src/models/carModel.js
const mongoose = require('mongoose');

const carModelSchema = new mongoose.Schema(
  {
    // No standalone index on makeId — the `{ makeId: 1, name: 1 }` unique
    // compound below serves makeId-only lookups via the prefix rule.
    makeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarMake',
      required: true,
    },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// One model name per make — also covers `find({ makeId }).sort({ name: 1 })`
// and standalone `find({ makeId })` queries (prefix rule).
carModelSchema.index({ makeId: 1, name: 1 }, { unique: true });

// Serves unfiltered `find().sort({ name: 1 })` on the full models collection.
carModelSchema.index({ name: 1 });

// Hot path: `find({ makeId, active: true }).sort({ name: 1 })` used by
// /make/:slug and the stats endpoint. The unique compound above can cover
// prefix matches on makeId but won't filter by `active` efficiently on its
// own — this compound does.
carModelSchema.index({ makeId: 1, active: 1, name: 1 });

function titleCase(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

carModelSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = titleCase(this.name);
  }
  next();
});

carModelSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.name && typeof $set.name === 'string') {
    $set.name = titleCase($set.name);
  }
  if (update.$set) this.setUpdate({ ...update, $set });
  else this.setUpdate($set);
  next();
});

carModelSchema.plugin(require('../helper/softDeletePlugin'));
module.exports = mongoose.model('CarModel', carModelSchema);
