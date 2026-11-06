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
  // Exact barcode/short code the cashier scanned or typed for this line ('' = added
  // by name search / click). One product can have several barcodes (e.g. colours),
  // so "sold by barcode" reports group on this.
  scannedCode: { type: String, trim: true, default: '' },
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
  // Pieces sold while out of stock (not taken from stock). 0 / missing = all in stock.
  outOfStockQty: { type: Number, default: undefined },
  // Free gift: sold at 0, its cost (costPrice * quantity) goes to cost of sales.
  isGift: { type: Boolean, default: false },
  giftReason: { type: String, required: false },
  // Product category at sale time (category performance reports).
  category: { type: String, required: false },
  // Manual item: typed at the counter, not in the catalog (product null, no stock).
  isManual: { type: Boolean, default: false },
  name: { type: String, required: false, trim: true },
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
    // Id the POS made for this sale (uuid). The same sale sent again (reply lost,
    // then uploaded as an offline sale) is never saved twice. Offline sales set it too.
    clientId: { type: String },
    // Sold on the counter PC while the internet was down, uploaded later
    // (services/sales/offlineSaleService.js, docs/OFFLINE_SALES.md). Absent on normal sales.
    offline: {
      type: new mongoose.Schema(
        {
          clientId: { type: String }, // made on the PC; the same sale is never saved twice
          number: { type: String }, // OFF-... number printed on the slip
          deviceId: { type: String },
          deviceName: { type: String },
          soldAt: { type: Date },
          uploadedAt: { type: Date },
          uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          offlineTotal: { type: Number }, // what the PC charged (saved as the order total)
          serverTotal: { type: Number }, // what the server would have charged
          warnings: [
            {
              _id: false,
              code: { type: String }, // STOCK_SHORT | PRICE_DIFF | NO_TILL | NOT_ALLOWED
              product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
              variantId: { type: String },
              name: { type: String },
              short: { type: Number },
              serverTotal: { type: Number },
              offlineTotal: { type: Number },
              message: { type: String },
            },
          ],
        },
        { _id: false }
      ),
      default: undefined,
    },
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
// Sold-by-barcode report: which barcode of a product was scanned.
posOrderSchema.index({ 'items.product': 1, 'items.scannedCode': 1 });

// Offline sales: one order per PC sale (clientId), and the slip's OFF- number is searchable.
posOrderSchema.index({ 'offline.clientId': 1 }, { unique: true, sparse: true });
posOrderSchema.index({ 'offline.number': 1 }, { sparse: true });
posOrderSchema.index({ clientId: 1 }, { unique: true, sparse: true });

// `offset` > 0 when a save at the same moment took the number (retry).
posOrderSchema.statics.generateOrderNumber = async function (offset = 0) {
  const count = (await this.countDocuments()) + offset;
  const timestamp = Date.now().toString().slice(-6);
  // Bill date in shop time (Pakistan), e.g. a bill at 00:30 on 6 Nov is 20261106.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()).replace(/-/g, '');
  return `POS-${date}-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

posOrderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    this.orderNumber = await this.constructor.generateOrderNumber();
  }
  next();
});

module.exports = mongoose.models.POSOrder || mongoose.model('POSOrder', posOrderSchema);
