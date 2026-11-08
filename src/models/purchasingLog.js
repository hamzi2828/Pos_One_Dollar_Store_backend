// src/models/purchasingLog.js
// Activity log of the "Purchasing & Vendors" area: one row per change
// (every non-GET request on trips, receiving, vendors, payments, consignment,
// vendor returns and sticker prints), success AND failure.
// Written by middleware/purchasingLogger.js. Kept forever (audit trail):
// no TTL and no delete API.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const AREAS = ['trips', 'receiving', 'vendors', 'payments', 'consignment', 'returns', 'labels'];

const refsSchema = new mongoose.Schema(
  {
    purchaseOrder: { type: ObjectId, default: undefined },
    poNumber: { type: String, default: undefined },
    grn: { type: ObjectId, default: undefined },
    grnNumber: { type: String, default: undefined },
    bill: { type: ObjectId, default: undefined },
    billNo: { type: String, default: undefined },
    vendor: { type: ObjectId, default: undefined },
    vendorName: { type: String, default: undefined },
    product: { type: ObjectId, default: undefined },
    productName: { type: String, default: undefined },
    entry: { type: ObjectId, default: undefined },
    entryNo: { type: Number, default: undefined },
    item: { type: ObjectId, default: undefined },
    charge: { type: ObjectId, default: undefined },
    chargeType: { type: String, default: undefined },
    payment: { type: ObjectId, default: undefined },
    paymentNo: { type: String, default: undefined },
    vendorReturn: { type: ObjectId, default: undefined },
    returnNo: { type: String, default: undefined },
    consignment: { type: ObjectId, default: undefined },
    consignmentNo: { type: String, default: undefined },
    settlement: { type: ObjectId, default: undefined },
    settlementNo: { type: String, default: undefined },
    ledgerEntry: { type: ObjectId, default: undefined },
    labelPrint: { type: ObjectId, default: undefined },
  },
  { _id: false }
);

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const purchasingLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    user: { type: ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    roleName: { type: String, default: '' },
    area: { type: String, enum: AREAS, required: true },
    action: { type: String, required: true }, // stable key, e.g. 'entry_add', 'bill_send'
    summary: { type: String, default: '' }, // one plain-English sentence
    refs: { type: refsSchema, default: () => ({}) },
    changes: { type: [changeSchema], default: [] },
    method: { type: String, default: '' },
    path: { type: String, default: '' },
    request: { type: mongoose.Schema.Types.Mixed, default: null }, // sanitized body (max ~4 KB)
    ok: { type: Boolean, default: true },
    statusCode: { type: Number, default: null },
    error: { type: String, default: null },
    ip: { type: String, default: null },
    device: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { versionKey: false }
);

purchasingLogSchema.index({ at: -1 });
purchasingLogSchema.index({ user: 1, at: -1 });
purchasingLogSchema.index({ area: 1, at: -1 });
purchasingLogSchema.index({ 'refs.purchaseOrder': 1, at: -1 });
purchasingLogSchema.index({ 'refs.grn': 1, at: -1 });
purchasingLogSchema.index({ 'refs.vendor': 1, at: -1 });

const PurchasingLog = mongoose.models.PurchasingLog || mongoose.model('PurchasingLog', purchasingLogSchema);
PurchasingLog.AREAS = AREAS;

module.exports = PurchasingLog;
