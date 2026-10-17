// src/models/carVariant.js
const mongoose = require('mongoose');

const carVariantSchema = new mongoose.Schema(
  {
    // No standalone index on modelId — the compound indexes below cover it
    // via the prefix rule.
    modelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarModel',
      required: true,
    },
    name: { type: String, default: '', trim: true },
    yearStart: { type: Number, default: null, min: 1900, max: 2100 },
    yearEnd: { type: Number, default: null, min: 1900, max: 2100 },
    imageUrl: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Enforces one (modelId, name, yearStart, yearEnd) combination per model.
carVariantSchema.index(
  { modelId: 1, name: 1, yearStart: 1, yearEnd: 1 },
  { unique: true }
);

// Directly serves `find({ modelId }).sort({ yearStart: -1, name: 1 })`
// (the hierarchy controller's listVariants query when filtered by model).
// Also covers plain `find({ modelId })` via the prefix rule.
carVariantSchema.index({ modelId: 1, yearStart: -1, name: 1 });

// Directly serves unfiltered `find().sort({ yearStart: -1, name: 1 })`
// (the Cars admin tab's initial variant list). Without this, Mongo does a
// full collection scan + in-memory sort, which is the main reason the tab
// feels slow on large catalogs.
carVariantSchema.index({ yearStart: -1, name: 1 });

// Hot path: `find({ modelId: { $in: [...] }, active: true })` used by the
// /make stats and /make/:slug helpers. The existing compound above filters
// by modelId but not `active` — adding an explicit compound short-circuits
// the active-only filter without touching the yearStart order.
carVariantSchema.index({ modelId: 1, active: 1 });

// Ensure yearEnd >= yearStart
carVariantSchema.pre('save', function (next) {
  if (typeof this.name === 'string') this.name = this.name.trim();
  if (this.yearStart && this.yearEnd && this.yearEnd < this.yearStart) {
    return next(new Error('yearEnd cannot be earlier than yearStart'));
  }
  next();
});

carVariantSchema.pre(['findOneAndUpdate', 'updateOne'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if (typeof $set.name === 'string') $set.name = $set.name.trim();
  if ($set.yearStart && $set.yearEnd && $set.yearEnd < $set.yearStart) {
    return next(new Error('yearEnd cannot be earlier than yearStart'));
  }
  if (update.$set) this.setUpdate({ ...update, $set });
  else this.setUpdate($set);
  next();
});

carVariantSchema.plugin(require('../helper/softDeletePlugin'));
module.exports = mongoose.model('CarVariant', carVariantSchema);
