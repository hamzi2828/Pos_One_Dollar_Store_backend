// src/models/priceTier.js
// Dollar-store price point ("Rs 280") shared by many products. A product linked
// to a tier (product.priceTier) always sells at the tier's price; changing the
// tier price re-prices every linked product (services/sales/priceTierService.js).
const mongoose = require('mongoose');

const priceTierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    price: { type: Number, required: true, min: 0 },
    color: { type: String, trim: true, default: '#F59E0B', maxlength: 20 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    description: { type: String, trim: true, default: '', maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

priceTierSchema.index({ sortOrder: 1, price: 1 });
priceTierSchema.index({ isActive: 1, sortOrder: 1 });

priceTierSchema.plugin(require('../helper/softDeletePlugin'));

module.exports = mongoose.models.PriceTier || mongoose.model('PriceTier', priceTierSchema);
