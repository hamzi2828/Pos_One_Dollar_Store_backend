// src/models/vendorLedgerEntry.js
// Vendor account (accounts payable), one row per transaction ("len den").
// Never edited or deleted: a wrong row is voided (isVoided) and re-posted.
//
//   credit = we owe the vendor MORE (bill, consignment settlement, opening balance)
//   debit  = we owe the vendor LESS (payment, return / debit note, discount)
//   balance (payable) = sum(credit) - sum(debit) over non-voided rows
//
// Write only through services/vendorLedgerService.js.
const mongoose = require('mongoose');

const ENTRY_TYPES = [
  'opening_balance', //       balance carried from before the system (credit, or debit if vendor owes us)
  'bill', //                  vendor bill from a purchase order (credit)
  'payment', //               we paid the vendor (debit)
  'debit_note', //            goods returned / short / damaged claim (debit)
  'credit_note', //           vendor charges extra later (credit)
  'consignment_settlement', // sold consignment pieces now payable (credit)
  'discount', //              vendor gave a discount on settlement (debit)
  'refund_received', //       vendor paid money back to us (credit: reduces their debt to us)
  'adjustment', //            manual correction (credit or debit)
];

const vendorLedgerEntrySchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '', trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    date: { type: Date, required: true, default: Date.now },
    type: { type: String, enum: ENTRY_TYPES, required: true },
    credit: { type: Number, min: 0, default: 0 },
    debit: { type: Number, min: 0, default: 0 },

    // Payments
    method: { type: String, enum: ['cash', 'bank', 'cheque', 'easypaisa', 'jazzcash', 'other', ''], default: '' },
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', default: null },
    reference: { type: String, default: '', trim: true }, // cheque no / transaction id
    attachments: { type: [String], default: [] }, // receipt photos

    // Source document (PurchaseOrder, VendorBill, VendorReturn, ConsignmentSettlement, VendorPayment...)
    refType: { type: String, default: '' },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNo: { type: String, default: '', trim: true },

    description: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    isVoided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

vendorLedgerEntrySchema.index({ vendor: 1, date: 1, _id: 1 });
vendorLedgerEntrySchema.index({ vendor: 1, isVoided: 1, date: 1 });
vendorLedgerEntrySchema.index({ refType: 1, refId: 1 });
vendorLedgerEntrySchema.index({ type: 1, date: -1 });
vendorLedgerEntrySchema.index({ branch: 1, date: -1 });

const VendorLedgerEntry =
  mongoose.models.VendorLedgerEntry || mongoose.model('VendorLedgerEntry', vendorLedgerEntrySchema);
VendorLedgerEntry.TYPES = ENTRY_TYPES;

module.exports = VendorLedgerEntry;
