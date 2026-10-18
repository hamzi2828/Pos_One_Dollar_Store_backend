// src/models/consignmentSettlement.js
// Consignment pieces sold since the last settlement, now payable to the vendor
// ("CS-2026-00001"). Posts one `consignment_settlement` (credit) row in the
// vendor ledger and moves the settled pieces on models/consignmentStock.js, so
// the same sold pieces are never settled twice. Optional payment on the spot
// (a normal VendorPayment). Void = ledger row voided + pieces unsettled again.
// Written only by services/vendors/consignmentService.js.
const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema(
  {
    position: { type: mongoose.Schema.Types.ObjectId, ref: 'ConsignmentStock', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    soldQty: { type: Number, required: true, min: 1 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
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

const consignmentSettlementSchema = new mongoose.Schema(
  {
    settlementNo: { type: String, required: true, trim: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '', trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // Sales period covered (earliest unsettled sale window -> settlement time).
    periodFrom: { type: Date, default: null },
    periodTo: { type: Date, default: Date.now },
    lines: { type: [lineSchema], default: [] },
    totalQty: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    ledgerEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorLedgerEntry', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorPayment', default: null },
    paidAmount: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'voided'], default: 'active' },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

consignmentSettlementSchema.index({ settlementNo: 1 }, { unique: true });
consignmentSettlementSchema.index({ branch: 1, vendor: 1, createdAt: -1 });
consignmentSettlementSchema.index({ vendor: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.ConsignmentSettlement || mongoose.model('ConsignmentSettlement', consignmentSettlementSchema);
