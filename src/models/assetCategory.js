// src/models/assetCategory.js
// Groups in the asset register (Furniture & Fixtures, Electronics & IT...).
// The defaults are created on first use by services/hr/assetService.ensureCategories().
// An asset with no own depreciation setting uses its category's.
const mongoose = require('mongoose');

const assetCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true }, // FUR, IT...
    description: { type: String, default: '', trim: true },
    depreciationMethod: { type: String, enum: ['straight_line', 'none'], default: 'straight_line' },
    usefulLifeYears: { type: Number, default: 5, min: 0 },
    sortOrder: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

assetCategorySchema.plugin(require('../helper/softDeletePlugin'));

assetCategorySchema.index({ code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
assetCategorySchema.index({ isDeleted: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.models.AssetCategory || mongoose.model('AssetCategory', assetCategorySchema);
