// src/models/carMake.js
const mongoose = require('mongoose');

const carMakeSchema = new mongoose.Schema(
  {
    // `unique: true` implies an index on `name`; no extra `index: true` needed.
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, trim: true, unique: true, sparse: true },
    logoUrl: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
    featuredOnHome: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Serves filtering/listing of active makes on the public side.
carMakeSchema.index({ active: 1, name: 1 });

// Hot path for /car-makes/featured — `find({ active: true, featuredOnHome: true })`.
carMakeSchema.index({ active: 1, featuredOnHome: 1, name: 1 });

function titleCase(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function toSlug(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

carMakeSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = titleCase(this.name);
    this.slug = toSlug(this.name);
  }
  if (!this.slug && this.name) {
    this.slug = toSlug(this.name);
  }
  next();
});

carMakeSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.name && typeof $set.name === 'string') {
    $set.name = titleCase($set.name);
    $set.slug = toSlug($set.name);
  }
  if (update.$set) this.setUpdate({ ...update, $set });
  else this.setUpdate($set);
  next();
});

carMakeSchema.plugin(require('../helper/softDeletePlugin'));

// Invalidate featured-makes cache whenever a make changes.
function invalidateCarMakeCache() {
  try {
    const { invalidate } = require('../middleware/cache');
    invalidate('car-makes:featured');
  } catch (_) { /* noop */ }
}
carMakeSchema.post('save', invalidateCarMakeCache);
carMakeSchema.post('findOneAndUpdate', invalidateCarMakeCache);
carMakeSchema.post('findOneAndDelete', invalidateCarMakeCache);
carMakeSchema.post('deleteOne', invalidateCarMakeCache);
carMakeSchema.post('deleteMany', invalidateCarMakeCache);
carMakeSchema.post('updateMany', invalidateCarMakeCache);

module.exports = mongoose.model('CarMake', carMakeSchema);
