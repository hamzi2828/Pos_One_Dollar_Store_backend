// Held Order Model — parked POS carts that can be retrieved later.
const mongoose = require('mongoose');

const heldOrderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: false },
  productName: { type: String, required: true },
  productThumbnail: { type: String, required: false },
  costPrice: { type: Number, required: false },
  variantId: { type: String, required: false },
  sku: { type: String, required: false, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  originalPrice: { type: Number, required: false },
  discount: { type: Number, default: 0 },
  subtotal: { type: Number, required: true },
  size: { type: String, required: false },
  color: { type: String, required: false },
  // Kept so a parked cart comes back exactly as it was (the server re-checks
  // permissions and prices when the sale is completed).
  isGift: { type: Boolean, default: false },
  giftReason: { type: String, required: false },
  priceOverride: { type: Boolean, default: false },
});

const heldOrderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    customerInfo: {
      _id: { type: String },
      firstName: { type: String },
      lastName: { type: String },
      phone: { type: String },
      customerType: { type: String, enum: ['online', 'walk-in'] },
      source: {
        type: String,
        enum: ['facebook', 'tiktok', 'instagram', 'word-of-mouth', ''],
      },
    },
    customerName: { type: String, default: '' },
    // The shop (null = old record = the shop).
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },
    items: [heldOrderItemSchema],
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true, default: 0 },
    taxRate: { type: Number, default: 0 },
    appliedTaxes: [
      {
        taxId: { type: String },
        name: { type: String },
        rate: { type: Number },
        amount: { type: Number },
      },
    ],
    discount: { type: Number, default: 0 },
    discountType: { type: String, enum: ['fixed', 'percentage', null], default: null },
    discountReason: { type: String, default: '' },
    total: { type: Number, required: true },
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    heldByName: { type: String, default: '' },
    notes: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

heldOrderSchema.index({ createdAt: -1 });
heldOrderSchema.index({ branch: 1, createdAt: -1 });
heldOrderSchema.index({ heldBy: 1, createdAt: -1 });
heldOrderSchema.index({ customer: 1, isDeleted: 1 });

module.exports = mongoose.models.HeldOrder || mongoose.model('HeldOrder', heldOrderSchema);
