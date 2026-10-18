// src/models/consignmentStock.js
// Running position of ONE consignment unit (product or variant) of ONE vendor
// in ONE branch:
//
//   placed   = qtyIn - qtyReturned                 (pieces the vendor left with us)
//   sold     = sale + gift - sale_return movements of the unit since firstIntakeAt
//              (computed from models/stockMovement.js, never stored)
//   unsettled= sold - qtySettled                   (what we owe on the next visit)
//   unsold   = placed - sold                       (still the vendor's, in the shop)
//
// qtySettled only moves through guarded updates in services/vendors/consignmentService.js,
// so the same sold pieces are never settled twice. One OPEN position per unit and
// branch (`isOpen`); a position closes when another vendor takes the product over.
const mongoose = require('mongoose');

const consignmentStockSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    rate: { type: Number, min: 0, default: 0 }, // current fixed buy rate per piece
    qtyIn: { type: Number, min: 0, default: 0 },
    qtyReturned: { type: Number, min: 0, default: 0 },
    qtySettled: { type: Number, min: 0, default: 0 },
    amountSettled: { type: Number, min: 0, default: 0 },
    firstIntakeAt: { type: Date, required: true },
    lastIntakeAt: { type: Date, default: null },
    lastReturnAt: { type: Date, default: null },
    lastSettledAt: { type: Date, default: null },
    isOpen: { type: Boolean, default: true },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

consignmentStockSchema.index(
  { branch: 1, product: 1, variantId: 1 },
  { unique: true, name: 'consignment_open_unit', partialFilterExpression: { isOpen: true } }
);
consignmentStockSchema.index({ vendor: 1, branch: 1, isOpen: 1 });
consignmentStockSchema.index({ branch: 1, isOpen: 1 });

module.exports = mongoose.models.ConsignmentStock || mongoose.model('ConsignmentStock', consignmentStockSchema);
