// src/models/consignment.js
// Sale-or-return stock movements with a vendor ("CN-2026-00001"):
//   kind 'intake' — the vendor places pieces in the shop at a fixed buy rate
//                   (stock in, movement `consignment_in`, NO payable yet)
//   kind 'return' — unsold pieces given back / swapped out on a visit
//                   (stock out, movement `consignment_return`, no debit note)
// We owe the vendor only for pieces that SELL (see models/consignmentSettlement.js).
// Items are marked `posted` one by one so a retried request never moves the
// same pieces twice. Written only by services/vendors/consignmentService.js.
const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    rate: { type: Number, required: true, min: 0 }, // vendor's fixed buy rate per piece
    qty: { type: Number, required: true, min: 1 }, // pieces in (intake) or out (return)
    amount: { type: Number, default: 0 }, // qty * rate (stock value, not a payable)
    shelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', default: null }, // put on / taken from
    posted: { type: Boolean, default: false },
    postedAt: { type: Date, default: null },
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

const consignmentSchema = new mongoose.Schema(
  {
    consignmentNo: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['intake', 'return'], default: 'intake' },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName: { type: String, default: '', trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // pending = some items not moved yet (retry with POST /consignments/:id/post)
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    date: { type: Date, default: Date.now },
    items: { type: [itemSchema], default: [] },
    totalQty: { type: Number, default: 0 },
    totalValue: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

consignmentSchema.index({ consignmentNo: 1 }, { unique: true });
consignmentSchema.index({ branch: 1, vendor: 1, date: -1 });
consignmentSchema.index({ vendor: 1, kind: 1, date: -1 });
consignmentSchema.index({ branch: 1, kind: 1, date: -1 });

module.exports = mongoose.models.Consignment || mongoose.model('Consignment', consignmentSchema);
