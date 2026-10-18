// src/models/locationStock.js
// Pieces of one unit (product or variant) sitting on one shelf of a branch.
//
// The branch total is still product.branchStock (services/stockService.js).
// Shelves are a breakdown of that total:
//   warehouse qty of a branch = branch total - sum(shelf rows of that branch)
// so stock that was never put on a shelf (new receipts, old data) is simply
// "in the warehouse". Only services/inventory/* write this collection.
const mongoose = require('mongoose');

const locationStockSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Variant's `variantId` for variant products, null for single products.
    variantId: { type: String, default: null },
    shelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', required: true },
    // Denormalized shelf code ("A1-S2") for fast lists.
    shelfCode: { type: String, trim: true, uppercase: true, default: '' },
    qty: { type: Number, min: 0, default: 0 },
    // Home shelf: where this item normally lives. Row is kept even at qty 0.
    isHome: { type: Boolean, default: false },
    // When pieces were first placed here (reset when the row goes 0 -> >0).
    firstPlacedAt: { type: Date, default: null },
    lastMovedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

locationStockSchema.index({ branch: 1, product: 1, variantId: 1, shelf: 1 }, { unique: true });
locationStockSchema.index({ branch: 1, shelf: 1 });
locationStockSchema.index({ product: 1, branch: 1 });

module.exports = mongoose.models.LocationStock || mongoose.model('LocationStock', locationStockSchema);
