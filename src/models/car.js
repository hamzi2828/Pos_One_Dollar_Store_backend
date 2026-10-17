// src/models/car.js

const mongoose = require('mongoose');

const carSchema = new mongoose.Schema(
  {
    make: { type: String, required: true, trim: true, index: true },
    model: { type: String, required: true, trim: true, index: true },
    variant: { type: String, default: '', trim: true },
    year: { type: Number, default: null, min: 1900, max: 2100 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Compound index for uniqueness on make + model + variant + year
carSchema.index(
  { make: 1, model: 1, variant: 1, year: 1 },
  { unique: true }
);

function titleCase(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Normalize fields on save
carSchema.pre('save', function (next) {
  if (this.isModified('make') && typeof this.make === 'string') {
    this.make = titleCase(this.make);
  }
  if (this.isModified('model') && typeof this.model === 'string') {
    this.model = titleCase(this.model);
  }
  if (this.isModified('variant') && typeof this.variant === 'string') {
    this.variant = String(this.variant).trim();
  }
  next();
});

// Normalize on findOneAndUpdate
carSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.make && typeof $set.make === 'string') $set.make = titleCase($set.make);
  if ($set.model && typeof $set.model === 'string') $set.model = titleCase($set.model);
  if (typeof $set.variant === 'string') $set.variant = $set.variant.trim();
  if (update.$set) this.setUpdate({ ...update, $set });
  else this.setUpdate($set);
  next();
});

carSchema.plugin(require('../helper/softDeletePlugin'));
module.exports = mongoose.model('Car', carSchema);
