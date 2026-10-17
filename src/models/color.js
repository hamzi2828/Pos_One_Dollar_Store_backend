// src/model/color.js

const mongoose = require('mongoose');

const colorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // `unique: true` already creates the slug index; no extra `index: true` needed.
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    hex: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Directly serves `find().sort({ createdAt: -1 })` on the admin list.
// Without it the list does a COLLSCAN + in-memory SORT across all colors.
colorSchema.index({ createdAt: -1 });

// Covers filtered/public listings that only want active colors, sorted newest first.
colorSchema.index({ active: 1, createdAt: -1 });

// Serves /colors/active — `find({ active: true }).sort({ name: 1 })`.
// Without this the query does an in-memory SORT on every request.
colorSchema.index({ active: 1, name: 1 });

// Helpers to format fields
function capitalizeFirstWord(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Ensure formatting on create/save
colorSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = capitalizeFirstWord(this.name);
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Ensure formatting on findOneAndUpdate / findByIdAndUpdate
colorSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.name && typeof $set.name === 'string') {
    $set.name = capitalizeFirstWord($set.name);
  }
  if ($set.slug && typeof $set.slug === 'string') {
    $set.slug = String($set.slug).trim().toLowerCase();
  }
  if (update.$set) this.setUpdate({ ...update, $set }); else this.setUpdate($set);
  next();
});

colorSchema.plugin(require('../helper/softDeletePlugin'));
module.exports = mongoose.model('Color', colorSchema);
