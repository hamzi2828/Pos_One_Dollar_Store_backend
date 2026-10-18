// src/models/priceChange.js
// History of sale price / cost changes of a unit ("where did the price start,
// what is it now"). Written by services/priceHistoryService.js.
const mongoose = require('mongoose');

const priceChangeSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    // 'price' = sale price, 'costPrice' = average landed cost, 'discountedPrice'
    field: { type: String, enum: ['price', 'costPrice', 'discountedPrice'], required: true },
    oldValue: { type: Number, default: null },
    newValue: { type: Number, default: null },
    // product_form | price_tier | purchase_receipt | bulk_update | import | other
    source: { type: String, default: 'other' },
    refType: { type: String, default: '' },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    note: { type: String, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    changedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

priceChangeSchema.index({ product: 1, variantId: 1, changedAt: -1 });
priceChangeSchema.index({ changedAt: -1 });

module.exports = mongoose.models.PriceChange || mongoose.model('PriceChange', priceChangeSchema);
