// src/models/goodsReceipt.js
// Goods receipt note (GRN). OWNER: Purchasing module.
//
// Created when a purchase order is sent to the warehouse (closed).
//
// New flow (docs/BUYING_FLOW.md):
//   1. check boxes  — boxes[] per vendor bill (expected vs received)
//   2. enter goods  — entries[]: each saved entry puts its good pieces into the
//                     WAREHOUSE at once (landed cost = costPrice × (1 + chargeRate))
//                     and may put some on a shelf; typed items (lines[]) are just
//                     a checklist that entries tick off
//   3. finish       — per bill: billTotal − entered value is claimed back from
//                     the vendor (debit note) when the receiver says so
//
// Old flow (still works for GRNs counted line by line, no entries): the receiver
// counts every line (received / damaged / short); completing puts the accepted
// pieces in at landed cost and claims short + damaged pieces with a debit note.
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
    // new flow: bill total vs value entered (good pieces × vendor price)
    billTotal: { type: Number, default: 0 },
    entered: { type: Number, default: 0 },
    ledgerEntry: { type: ObjectId, ref: 'VendorLedgerEntry', default: null },
  },
  { _id: false }
);

// Boxes per vendor bill, checked when the goods reach the warehouse.
const boxSchema = new mongoose.Schema(
  {
    bill: { type: ObjectId, required: true }, // PurchaseOrder.bills._id
    vendor: { type: ObjectId, ref: 'Vendor', default: null },
    vendorName: { type: String, default: '' },
    billNo: { type: String, default: '' },
    billTotal: { type: Number, default: 0 }, // frozen at send (what we owe on this bill)
    expected: { type: Number, min: 0, default: 0 }, // bill cartons
    received: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

// One unpacked product: its good pieces go into the warehouse when it is saved.
const entrySchema = new mongoose.Schema({
  entryNo: { type: Number, required: true },
  requestId: { type: String, default: '' }, // optional client key: a resent request returns this entry
  bill: { type: ObjectId, required: true },
  vendor: { type: ObjectId, ref: 'Vendor', default: null },
  vendorName: { type: String, default: '' },
  billNo: { type: String, default: '' },

  product: { type: ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: null },
  productName: { type: String, default: '' },
  code: { type: String, default: '' }, // short code
  salePrice: { type: Number, default: 0 },

  qty: { type: Number, min: 1, required: true }, // pieces taken out of the boxes
  damagedQty: { type: Number, min: 0, default: 0 }, // not stocked
  stockQty: { type: Number, min: 0, default: 0 }, // qty − damaged = pieces into the warehouse
  costPrice: { type: Number, min: 0, required: true }, // vendor price per piece
  landedUnitCost: { type: Number, min: 0, default: 0 }, // costPrice × (1 + chargeRate)
  value: { type: Number, min: 0, default: 0 }, // qty × costPrice

  // Expected (typed) line ticked off by this entry, and by how much
  line: { type: ObjectId, default: null },
  lineQty: { type: Number, min: 0, default: 0 },
  lineDamaged: { type: Number, min: 0, default: 0 },

  posted: { type: Boolean, default: false }, // stock received (never twice)
  postedAt: { type: Date, default: null },
  movement: { type: ObjectId, ref: 'StockMovement', default: null },
  shelved: { type: Number, min: 0, default: 0 }, // put on a shelf in the same step
  shelf: { type: ObjectId, ref: 'Shelf', default: null },
  shelfCode: { type: String, default: '' },

  createdBy: { type: ObjectId, ref: 'User', default: null },
  createdByName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  undone: { type: Boolean, default: false },
  undoneAt: { type: Date, default: null },
  undoneBy: { type: ObjectId, ref: 'User', default: null },
  undoneByName: { type: String, default: '' },
  undoMovement: { type: ObjectId, ref: 'StockMovement', default: null },
});

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
    goodsTotal: { type: Number, default: 0 }, // Σ bill totals at send
    // chargesTotal / goodsTotal, frozen at send (4 decimals). null = older GRN (filled on first entry).
    chargeRate: { type: Number, default: null },
    expectedCartons: { type: Number, default: 0 },

    boxes: { type: [boxSchema], default: [] },
    boxesCheckedAt: { type: Date, default: null },
    boxesCheckedBy: { type: ObjectId, ref: 'User', default: null },
    boxesNote: { type: String, default: '' },

    lines: { type: [lineSchema], default: [] }, // expected items (typed on the trip; may be empty)
    entries: { type: [entrySchema], default: [] },
    entrySeq: { type: Number, default: 0 }, // last entryNo used
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
      // new flow
      boxesExpected: { type: Number, default: 0 },
      boxesReceived: { type: Number, default: 0 },
      pieces: { type: Number, default: 0 }, // pieces entered (incl. damaged)
      entered: { type: Number, default: 0 }, // value entered (good pieces × vendor price)
      billTotal: { type: Number, default: 0 },
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
