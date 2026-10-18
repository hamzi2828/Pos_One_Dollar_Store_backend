// POS Order Model — one bill rung at the shop counter.
const mongoose = require('mongoose');

const posOrderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: false },
  costPrice: { type: Number, required: false },
  variantId: { type: String, required: false },
  sku: { type: String, required: false, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true },
  size: { type: String, required: false },
  color: { type: String, required: false },
  discount: { type: Number, default: 0 },
  // Barcode/short code the cashier scanned or typed (for audit).
  scannedCode: { type: String, required: false },
  // Batch the cashier asked for (scanned batch label). Optional.
  batchNo: { type: String, required: false },
  // Which batches the pieces actually came out of — used to put stock back.
  batchAllocations: [
    {
      _id: false,
      batchNo: { type: String },
      quantity: { type: Number },
    },
  ],
  // Free gift: sold at 0, its cost (costPrice * quantity) goes to cost of sales.
  isGift: { type: Boolean, default: false },
  giftReason: { type: String, required: false },
  // Product category at sale time (category performance reports).
  category: { type: String, required: false },
});

const posOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    // The shop (stock was taken from it). null = old order = the shop.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },
    // Shop code at sale time, denormalized for receipts.
    branchCode: { type: String, default: '' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    customerInfo: {
      name: { type: String },
      phone: { type: String },
      customerType: { type: String, enum: ['online', 'walk-in'] },
      source: { type: String, enum: ['facebook', 'tiktok', 'instagram', 'word-of-mouth', ''] },
    },
    items: [posOrderItemSchema],
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true, default: 0 },
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
    // Bill discount rules applied by the server (models/discountRule.js).
    appliedDiscounts: [
      {
        _id: false,
        rule: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountRule' },
        name: { type: String },
        kind: { type: String }, // 'overall' | 'threshold' | 'manual'
        valueType: { type: String }, // 'percentage' | 'fixed'
        value: { type: Number },
        amount: { type: Number },
      },
    ],
    // Cost of goods sold for this bill (sum of costPrice * qty, gifts included).
    cogs: { type: Number, default: 0 },
    // Cost of the gift lines only (part of cogs).
    giftCost: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      required: true,
      enum: ['cash', 'card', 'split', 'bank_transfer'],
      default: 'cash',
    },
    cashAmount: { type: Number, required: false },
    cardAmount: { type: Number, required: false },
    changeGiven: { type: Number, required: false },
    bankTransferScreenshot: { type: String, required: false },
    paidAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    paymentHistory: [
      {
        amount: { type: Number, required: true },
        paymentMethod: {
          type: String,
          enum: ['cash', 'card', 'bank_transfer'],
          required: true,
        },
        paidAt: { type: Date, default: Date.now },
        receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String },
        paymentStatus: {
          type: String,
          enum: ['pending', 'partial', 'completed', 'full'],
          default: 'completed',
        },
        bankTransferScreenshot: { type: String },
      },
    ],
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Till session / sale counter the bill was rung on (models/cashSession.js, models/saleCounter.js).
    cashSession: { type: mongoose.Schema.Types.ObjectId, ref: 'CashSession', default: null, index: true },
    counter: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleCounter', default: null },
    // WhatsApp group receipt slip (services/notificationService.js).
    whatsappStatus: { type: String, enum: ['none', 'queued', 'sent', 'failed', 'skipped'], default: 'none' },
    orderStatus: {
      type: String,
      enum: ['completed', 'pending', 'refunded', 'cancelled'],
      default: 'completed',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['completed', 'pending', 'partial', 'refunded', 'full'],
      default: 'completed',
    },
    notes: { type: String },
    completedAt: { type: Date, default: Date.now },
    refundedAt: { type: Date },
    // Who gave the refund (cash leaves THEIR till session, not the original cashier's).
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date },
    // True once this order's pieces were put back into stock (delete/refund),
    // so stock is never restored twice.
    stockRestored: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

posOrderSchema.index({ createdAt: -1 });
posOrderSchema.index({ branch: 1, createdAt: -1 });
posOrderSchema.index({ branch: 1, paymentStatus: 1, createdAt: -1 });
posOrderSchema.index({ cashier: 1, createdAt: -1 });
posOrderSchema.index({ paymentStatus: 1, customer: 1 });
posOrderSchema.index({ customer: 1, paymentStatus: 1 });
// Till closing: cash a cashier received during a session (incl. later credit payments).
posOrderSchema.index({ 'paymentHistory.receivedBy': 1, 'paymentHistory.paidAt': -1 });
// Refunds given by a user in a time window (till closing).
posOrderSchema.index({ refundedBy: 1, refundedAt: -1 });

posOrderSchema.statics.generateOrderNumber = async function () {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString().slice(-6);
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  return `POS-${date}-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

posOrderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    this.orderNumber = await this.constructor.generateOrderNumber();
  }
  next();
});

module.exports = mongoose.models.POSOrder || mongoose.model('POSOrder', posOrderSchema);
