// src/models/category.js
// Product category (Kitchen & Dining, Toys, ...). Products store the category NAME.

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    description: { type: String, default: '', trim: true },
    thumbnailUrl: { type: String, default: null },
    thumbnailUrls: { type: [String], default: [] },
    bannerUrl: { type: String, default: null },
    active: { type: Boolean, default: true },
    // Sort order for manual ordering
    sortOrder: { type: Number, default: 0, index: true },
    // Parent category reference for subcategories
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
  },
  { timestamps: true }
);

// Exact `name` lookups (products store the category name).
categorySchema.index({ name: 1 });
// Admin listing — sorted by sortOrder, most recent fallback
categorySchema.index({ sortOrder: 1, createdAt: -1 });
// Parent + sortOrder — for children listing of a parent
categorySchema.index({ parentId: 1, sortOrder: 1 });
// Text search on name / description for the admin search box
categorySchema.index(
  { name: 'text', description: 'text' },
  { name: 'category_text_idx', weights: { name: 10, description: 2 } }
);

// Virtual for getting child categories
categorySchema.virtual('children', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parentId',
});

// Ensure virtuals are included in JSON output
categorySchema.set('toJSON', { virtuals: true });
categorySchema.set('toObject', { virtuals: true });

categorySchema.plugin(require('../helper/softDeletePlugin'));

module.exports = mongoose.model('Category', categorySchema);
