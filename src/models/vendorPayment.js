// src/models/vendorPayment.js
// Money we paid a vendor ("VP-2026-00001"). Each payment posts one `payment`
// (debit) row in the vendor ledger. A wrong payment is voided — the payment
// and its ledger row stay visible, greyed out — never deleted.
// Written only by services/vendors/paymentService.js.
const mongoose = require('mongoose');

const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'easypaisa', 'jazzcash', 'other'];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const vendorPaymentSchema = new mongoose.Schema(
  {
    paymentNo: { type: String, required: true, trim: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '', trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', default: null },
    reference: { type: String, default: '', trim: true }, // cheque no / transaction id
    date: { type: Date, required: true, default: Date.now },
    attachments: { type: [String], default: [] }, // receipt photos
    notes: { type: String, default: '', trim: true },
    // Paid while settling consignment (optional).
    settlement: { type: mongoose.Schema.Types.ObjectId, ref: 'ConsignmentSettlement', default: null },
    ledgerEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorLedgerEntry', default: null },
    status: { type: String, enum: ['active', 'voided'], default: 'active' },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

vendorPaymentSchema.index({ paymentNo: 1 }, { unique: true });
vendorPaymentSchema.index({ branch: 1, date: -1 });
vendorPaymentSchema.index({ vendor: 1, date: -1 });
vendorPaymentSchema.index({ branch: 1, vendor: 1, date: -1 });
vendorPaymentSchema.index({ status: 1, method: 1, date: -1 });

const VendorPayment = mongoose.models.VendorPayment || mongoose.model('VendorPayment', vendorPaymentSchema);
VendorPayment.METHODS = PAYMENT_METHODS;

module.exports = VendorPayment;
