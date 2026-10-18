// src/models/purchaseOrder.js
// Purchase order = one buying trip. OWNER: Purchasing module.
//
// One trip buys from several vendors, so a PO holds one `bills[]` entry per
// vendor bill (cartons, bill photo, items). Extra costs of the trip (car rent,
// builty freight, loading / unloading, labour, misc) go in `charges[]` and are
// spread over the goods as landed cost (services/purchasing/costing.js).
//
//   open      → buyer adds bills, items, charges
//   closed    → builty submitted; bills posted to the vendor ledger; a goods
//               receipt (GRN) waits for the receiver
//   receiving → receiver started verifying the GRN
//   received  → GRN completed, stock is in the branch warehouse
//   cancelled → open PO dropped, or closed PO cancelled before receiving
//
// All money fields are computed on the server (services/purchasing/poTotals.js).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const STATUSES = ['open', 'closed', 'receiving', 'received', 'cancelled'];
const CHARGE_TYPES = ['car_rent', 'transport', 'builty_freight', 'loading', 'unloading', 'landing', 'labour', 'misc'];
const ALLOCATION_METHODS = ['value', 'quantity', 'carton'];

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

// One product line on a vendor bill. Quantities are pieces.
const itemSchema = new mongoose.Schema({
  product: { type: ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: null },
  productName: { type: String, default: '' }, // includes the variant label
  code: { type: String, default: '' }, // short code / SKU at the time
  piecesPerBox: { type: Number, min: 1, default: 1 },
  boxes: { type: Number, min: 0, default: 0 }, // as typed (info only)
  qty: { type: Number, min: 1, required: true }, // pieces
  unitPrice: { type: Number, min: 0, default: 0 }, // vendor price per piece
  discount: { type: Number, min: 0, default: 0 }, // line discount (Rs)
  lineTotal: { type: Number, min: 0, default: 0 }, // qty * unitPrice - discount
  salePrice: { type: Number, min: 0, default: 0 }, // product price when added (info)
  note: { type: String, default: '' },
});

const billSchema = new mongoose.Schema({
  vendor: { type: ObjectId, ref: 'Vendor', required: true },
  vendorName: { type: String, default: '' },
  billNo: { type: String, default: '', trim: true },
  billDate: { type: Date, default: null },
  cartons: { type: Number, min: 0, default: 0 },
  photos: { type: [String], default: [] },
  items: { type: [itemSchema], default: [] },
  subtotal: { type: Number, min: 0, default: 0 }, // sum of lineTotal
  discount: { type: Number, min: 0, default: 0 }, // bill discount (Rs)
  billTotal: { type: Number, min: 0, default: 0 }, // subtotal - discount = what we owe
  notes: { type: String, default: '' },
  ledgerEntry: { type: ObjectId, ref: 'VendorLedgerEntry', default: null }, // set on close
  createdBy: { type: ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
});

const chargeSchema = new mongoose.Schema({
  type: { type: String, enum: CHARGE_TYPES, required: true },
  amount: { type: Number, min: 0, required: true },
  note: { type: String, default: '' },
  paidTo: { type: String, default: '' },
  // 'builty' = freight typed on the builty at close (replaced on every close)
  source: { type: String, enum: ['manual', 'builty'], default: 'manual' },
  createdBy: { type: ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
});

const builtySchema = new mongoose.Schema(
  {
    builtyNo: { type: String, default: '', trim: true },
    transporter: { type: String, default: '', trim: true },
    date: { type: Date, default: null },
    cartons: { type: Number, min: 0, default: 0 },
    freight: { type: Number, min: 0, default: 0 },
    photos: { type: [String], default: [] },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const totalsSchema = new mongoose.Schema(
  {
    goods: { type: Number, default: 0 }, // sum of bill totals
    charges: { type: Number, default: 0 },
    grand: { type: Number, default: 0 }, // goods + charges
    cartons: { type: Number, default: 0 },
    pieces: { type: Number, default: 0 },
    bills: { type: Number, default: 0 },
    lines: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true, trim: true },
    branch: { type: ObjectId, ref: 'Branch', required: true },
    status: { type: String, enum: STATUSES, default: 'open' },

    buyer: { type: ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    expectedArrival: { type: Date, default: null },
    allocationMethod: { type: String, enum: ALLOCATION_METHODS, default: 'value' },

    bills: { type: [billSchema], default: [] },
    charges: { type: [chargeSchema], default: [] },
    builty: { type: builtySchema, default: () => ({}) },
    totals: { type: totalsSchema, default: () => ({}) },

    goodsReceipt: { type: ObjectId, ref: 'GoodsReceipt', default: null },
    grnNumber: { type: String, default: '' },

    closedAt: { type: Date, default: null },
    closedBy: { type: ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '' },

    history: { type: [historySchema], default: [] },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    // Short lock while close / cancel posts to the ledger (stale after 2 min).
    lockedAt: { type: Date, default: null },
  },
  // optimisticConcurrency: two people editing the same PO cannot overwrite each other.
  { timestamps: true, optimisticConcurrency: true }
);

// List filters: branch + status tabs + newest first; vendor filter; search by bill no.
purchaseOrderSchema.index({ branch: 1, status: 1, createdAt: -1 });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });
purchaseOrderSchema.index({ 'bills.vendor': 1, createdAt: -1 });
purchaseOrderSchema.index({ 'bills.billNo': 1 });
purchaseOrderSchema.index({ 'builty.builtyNo': 1 });

const PurchaseOrder = mongoose.models.PurchaseOrder || mongoose.model('PurchaseOrder', purchaseOrderSchema);
PurchaseOrder.STATUSES = STATUSES;
PurchaseOrder.CHARGE_TYPES = CHARGE_TYPES;
PurchaseOrder.ALLOCATION_METHODS = ALLOCATION_METHODS;

module.exports = PurchaseOrder;
