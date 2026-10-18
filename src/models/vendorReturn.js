// src/models/vendorReturn.js
// Goods sent back to a vendor ("VR-2026-00001"): slow movers, damaged,
// expired, wrong or excess items. draft -> completed | cancelled.
// Completing takes every line out of stock (movement `vendor_return`,
// warehouse first) and posts ONE `debit_note` in the vendor ledger
// (we owe the vendor less). Lines are marked `posted` one by one so a
// failed / retried completion never takes the same pieces out twice.
// Written only by services/vendors/returnService.js.
const mongoose = require('mongoose');

const RETURN_REASONS = ['slow_moving', 'damaged', 'expired', 'wrong_item', 'excess', 'other'];

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    // Price the vendor takes it back at (default: their last price to us, else our cost).
    unitCost: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, enum: RETURN_REASONS, default: 'other' },
    note: { type: String, default: '', trim: true },
    fromShelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', default: null },
    posted: { type: Boolean, default: false },
    postedAt: { type: Date, default: null },
    movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const vendorReturnSchema = new mongoose.Schema(
  {
    returnNo: { type: String, required: true, trim: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '', trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    status: { type: String, enum: ['draft', 'completed', 'cancelled'], default: 'draft' },
    date: { type: Date, default: Date.now },
    lines: { type: [lineSchema], default: [] },
    totalQty: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    ledgerEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorLedgerEntry', default: null },
    // Short lock while completing (two clicks / two devices).
    lockedUntil: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

vendorReturnSchema.index({ returnNo: 1 }, { unique: true });
vendorReturnSchema.index({ branch: 1, status: 1, createdAt: -1 });
vendorReturnSchema.index({ vendor: 1, createdAt: -1 });
vendorReturnSchema.index({ 'lines.product': 1 });

const VendorReturn = mongoose.models.VendorReturn || mongoose.model('VendorReturn', vendorReturnSchema);
VendorReturn.REASONS = RETURN_REASONS;

module.exports = VendorReturn;
