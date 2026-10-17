// POS Order Model — dedicated to counter sales so it stays independent of
// the web ecommerce Order schema (which requires shipping addresses etc).
const mongoose = require('mongoose');

const posOrderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: false },
  isLabour: { type: Boolean, default: false },
  labourDescription: { type: String, required: false },
  isOutsource: { type: Boolean, default: false },
  outsourceDescription: { type: String, required: false },
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
  // Technician/employee credited for a labour or outsource item. Drives the
  // "by employee" grouping in the Labour Revenue report.
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: false },
  performedByName: { type: String, required: false },
});

const posOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    // Branch that made the sale (stock was taken from it). null = old order
    // from before branches = main branch.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },
    // Branch code at sale time (e.g. "B1"), denormalized for receipts.
    branchCode: { type: String, default: '' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    customerInfo: {
      name: { type: String },
      phone: { type: String },
      vehicleName: { type: String },
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
