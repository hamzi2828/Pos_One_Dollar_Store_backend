// src/models/goodsReceipt.js
// Goods receipt note (GRN). OWNER: Purchasing module.
//
// Created when a purchase order is closed (builty submitted). The receiver —
// who may be a different person than the buyer — counts every line:
//   received = pieces that arrived, damaged = arrived broken (not stocked),
//   short    = expected − received, accepted = received − damaged.
// Completing the GRN puts the accepted pieces into the branch WAREHOUSE at
// their landed cost (all PO charges spread over the accepted pieces) and
// claims short + damaged pieces back from each vendor with a debit note.
//
//   pending → in_progress → completed      (cancelled: PO cancelled before start)
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    action: { type: String, required: true },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const lineSchema = new mongoose.Schema({
  lineNo: { type: Number, required: true },
  // Source on the purchase order
  bill: { type: ObjectId, required: true }, // PurchaseOrder.bills._id
  poItem: { type: ObjectId, required: true }, // PurchaseOrder.bills.items._id
  vendor: { type: ObjectId, ref: 'Vendor', required: true },
  vendorName: { type: String, default: '' },
  billNo: { type: String, default: '' },

  product: { type: ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: null },
  productName: { type: String, default: '' },
  code: { type: String, default: '' },
  piecesPerBox: { type: Number, min: 1, default: 1 },

  expectedQty: { type: Number, min: 0, required: true },
  unitPrice: { type: Number, min: 0, default: 0 }, // vendor price per piece after line + bill discount
  lineValue: { type: Number, min: 0, default: 0 }, // what the vendor billed for this line (net)
  cartonShare: { type: Number, min: 0, default: 0 }, // bill cartons spread by value (carton allocation)

  // Counted by the receiver
  receivedQty: { type: Number, min: 0, default: 0 },
  damagedQty: { type: Number, min: 0, default: 0 },
  shortQty: { type: Number, min: 0, default: 0 },
  acceptedQty: { type: Number, min: 0, default: 0 },
  note: { type: String, default: '' },

  // Frozen on completion
  allocatedCharges: { type: Number, min: 0, default: 0 },
  landedUnitCost: { type: Number, min: 0, default: 0 },
  claimAmount: { type: Number, min: 0, default: 0 },
  posted: { type: Boolean, default: false }, // stock received (never twice)
  postedAt: { type: Date, default: null },
  movement: { type: ObjectId, ref: 'StockMovement', default: null },
});

// One debit note per vendor bill for short + damaged pieces.
const claimSchema = new mongoose.Schema(
  {
    bill: { type: ObjectId, required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '' },
    billNo: { type: String, default: '' },
    shortQty: { type: Number, default: 0 },
    damagedQty: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    ledgerEntry: { type: ObjectId, ref: 'VendorLedgerEntry', default: null },
  },
  { _id: false }
);

const goodsReceiptSchema = new mongoose.Schema(
  {
    grnNumber: { type: String, required: true, unique: true, trim: true },
    purchaseOrder: { type: ObjectId, ref: 'PurchaseOrder', required: true, unique: true },
    poNumber: { type: String, default: '' },
    branch: { type: ObjectId, ref: 'Branch', required: true },
    status: { type: String, enum: STATUSES, default: 'pending' },

    buyer: { type: ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: '' },
    receiver: { type: ObjectId, ref: 'User', default: null },
    receiverName: { type: String, default: '' },

    // Copied from the PO at close (the PO is locked from then on)
    builty: {
      builtyNo: { type: String, default: '' },
      transporter: { type: String, default: '' },
      date: { type: Date, default: null },
      cartons: { type: Number, default: 0 },
      photos: { type: [String], default: [] },
    },
    allocationMethod: { type: String, enum: ['value', 'quantity', 'carton'], default: 'value' },
    chargesTotal: { type: Number, default: 0 },
    expectedCartons: { type: Number, default: 0 },

    lines: { type: [lineSchema], default: [] },
    cartonsReceived: { type: Number, min: 0, default: 0 },
    photos: { type: [String], default: [] },
    notes: { type: String, default: '' },
    claimFromVendor: { type: Boolean, default: true },
    claims: { type: [claimSchema], default: [] },

    // Frozen on completion
    totals: {
      expected: { type: Number, default: 0 },
      received: { type: Number, default: 0 },
      damaged: { type: Number, default: 0 },
      short: { type: Number, default: 0 },
      accepted: { type: Number, default: 0 },
      stockValue: { type: Number, default: 0 }, // landed value put into stock
      claimed: { type: Number, default: 0 }, // debit notes total
    },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: ObjectId, ref: 'User', default: null },
    lockedAt: { type: Date, default: null }, // short lock while completing
    history: { type: [historySchema], default: [] },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Queue: branch + status (pending first) + newest.
goodsReceiptSchema.index({ branch: 1, status: 1, createdAt: -1 });
goodsReceiptSchema.index({ status: 1, createdAt: -1 });

const GoodsReceipt = mongoose.models.GoodsReceipt || mongoose.model('GoodsReceipt', goodsReceiptSchema);
GoodsReceipt.STATUSES = STATUSES;

module.exports = GoodsReceipt;
