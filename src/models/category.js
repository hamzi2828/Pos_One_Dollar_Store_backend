// src/model/category.js

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
    featured: { type: Boolean, default: false },
    // Shipping cost for this category
    shippingCost: { type: Number, default: 0, min: 0 },
    // Estimated delivery days for this category
    estimatedDays: { type: String, default: '', trim: true },
    // Sort order for manual ordering
    sortOrder: { type: Number, default: 0, index: true },
    // Parent category reference for subcategories
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    // Admin-selected products to feature on the frontend for this category
    featuredProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: [] }],
    // Size guide images for this category
    sizeChartRegularCm: { type: String, default: null },
    sizeChartRegularInch: { type: String, default: null },
    sizeChartRelaxedCm: { type: String, default: null },
    sizeChartRelaxedInch: { type: String, default: null },
    measuringTipImage: { type: String, default: null },
    // SEO meta fields
    metaTitle: { type: String, default: '', trim: true },
    metaDescription: { type: String, default: '', trim: true },
    metaKeywords: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

// Exact `name` lookup used by productDetailController (every product detail
// page hits `Category.findOne({ name: product.category })`). The text index
// above doesn't cover equality match.
categorySchema.index({ name: 1 });
// Admin listing — sorted by sortOrder, most recent fallback
categorySchema.index({ sortOrder: 1, createdAt: -1 });
// Parent + sortOrder — for children listing of a parent
categorySchema.index({ parentId: 1, sortOrder: 1 });
// Filter by active/featured (public lookups)
categorySchema.index({ active: 1, featured: 1, sortOrder: 1 });
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

// Invalidate public categories cache whenever a category changes.
function invalidateCategoryCache() {
  try {
    const { invalidate } = require('../middleware/cache');
    invalidate('categories:public');
    invalidate('categories:featured-with-products');
  } catch (_) { /* noop */ }
}
categorySchema.post('save', invalidateCategoryCache);
categorySchema.post('findOneAndUpdate', invalidateCategoryCache);
categorySchema.post('findOneAndDelete', invalidateCategoryCache);
categorySchema.post('deleteOne', invalidateCategoryCache);
categorySchema.post('deleteMany', invalidateCategoryCache);
categorySchema.post('updateMany', invalidateCategoryCache);

module.exports = mongoose.model('Category', categorySchema);
