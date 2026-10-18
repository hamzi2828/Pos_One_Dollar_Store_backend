// src/models/stockMovement.js
// Immutable stock ledger: one row per change of a unit's stock in a branch
// (or per move between locations inside a branch). Never updated or deleted.
// Written only by services/inventory/movementService.js (called from
// services/stockService.js and services/inventory/locationService.js).
//
// Drives: product timeline (received -> warehouse -> shelf -> sold), demand
// list, slow-moving report, damage/shop-use history, landed cost history.
const mongoose = require('mongoose');

const MOVEMENT_TYPES = [
  'opening', //            first stock of a product (migration / product form)
  'purchase_receipt', //   goods verified in from a purchase order (landed cost)
  'receive', //            manual "Receive stock" (no purchase order)
  'consignment_in', //     vendor's sale-or-return stock placed in the shop
  'consignment_return', // consignment stock given back / swapped out
  'putaway', //            warehouse -> shelf (branch total unchanged)
  'location_move', //      shelf -> shelf or shelf -> warehouse (total unchanged)
  'sale', //               sold at the POS
  'gift', //               given free at the POS (cost goes to cost of sales)
  'sale_return', //        refund / deleted order / failed sale put back
  'transfer_out', //       old multi-branch data only (branch transfers were removed)
  'transfer_in', //        old multi-branch data only
  'damage', //             damaged / expired / broken (approved damage report)
  'internal_use', //       taken from stock for the shop's own use (expense)
  'vendor_return', //      returned to the vendor (debit note)
  'adjustment_in', //      stock count correction up
  'adjustment_out', //     stock count correction down
];

// Stock leaves the branch (qtyChange < 0)
const OUT_TYPES = ['sale', 'gift', 'transfer_out', 'damage', 'internal_use', 'vendor_return', 'adjustment_out', 'consignment_return'];
// Stock enters the branch (qtyChange > 0)
const IN_TYPES = ['opening', 'purchase_receipt', 'receive', 'consignment_in', 'sale_return', 'transfer_in', 'adjustment_in'];
// Inside the branch only (qtyChange = 0)
const MOVE_TYPES = ['putaway', 'location_move'];

const locationSchema = new mongoose.Schema(
  {
    // warehouse | shelf | branch (another branch) | vendor | customer | none
    kind: { type: String, enum: ['warehouse', 'shelf', 'branch', 'vendor', 'customer', 'none'], default: 'none' },
    shelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', default: null },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    code: { type: String, trim: true, default: '' }, // "A1-S2", "WAREHOUSE", branch code...
  },
  { _id: false }
);

const shelfTakeSchema = new mongoose.Schema(
  {
    shelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf' },
    code: { type: String, default: '' },
    qty: { type: Number, default: 0 },
  },
  { _id: false }
);

const stockMovementSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    // Denormalized for lists / reports without $lookup.
    productName: { type: String, default: '' },
    category: { type: String, default: '' },
    code: { type: String, default: '' }, // short code / SKU of the unit at the time

    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    direction: { type: String, enum: ['in', 'out', 'move'], required: true },
    // Pieces moved (always > 0).
    quantity: { type: Number, required: true, min: 0 },
    // Signed change of the branch total: +in, -out, 0 for moves.
    qtyChange: { type: Number, required: true },
    // Branch total of this unit right after the movement (null when unknown).
    balanceAfter: { type: Number, default: null },

    from: { type: locationSchema, default: () => ({}) },
    to: { type: locationSchema, default: () => ({}) },
    // Shelves the pieces were taken from / put on (outs can touch several).
    shelves: { type: [shelfTakeSchema], default: [] },
    batchAllocations: { type: [{ _id: false, batchNo: String, quantity: Number }], default: [] },

    // Cost per piece at the time (landed cost for receipts, average cost for outs).
    unitCost: { type: Number, default: null },
    totalCost: { type: Number, default: null },
    // Sale price per piece (sales / gifts at 0).
    unitPrice: { type: Number, default: null },
    // Vendor's price per piece BEFORE shipment charges (receipts only).
    purchasePrice: { type: Number, default: null },

    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    // Source document: POSOrder, PurchaseOrder, GoodsReceipt,
    // DamageRecord, ShopUse, VendorReturn, Consignment, StockAdjustment, Product...
    refType: { type: String, default: '' },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNo: { type: String, default: '' },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ product: 1, variantId: 1, branch: 1, occurredAt: -1 });
stockMovementSchema.index({ branch: 1, type: 1, occurredAt: -1 });
stockMovementSchema.index({ branch: 1, occurredAt: -1 });
stockMovementSchema.index({ refType: 1, refId: 1 });
stockMovementSchema.index({ vendor: 1, occurredAt: -1 });
stockMovementSchema.index({ type: 1, occurredAt: -1 });

stockMovementSchema.statics.TYPES = MOVEMENT_TYPES;
stockMovementSchema.statics.OUT_TYPES = OUT_TYPES;
stockMovementSchema.statics.IN_TYPES = IN_TYPES;
stockMovementSchema.statics.MOVE_TYPES = MOVE_TYPES;

const StockMovement = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
StockMovement.TYPES = MOVEMENT_TYPES;
StockMovement.OUT_TYPES = OUT_TYPES;
StockMovement.IN_TYPES = IN_TYPES;
StockMovement.MOVE_TYPES = MOVE_TYPES;

module.exports = StockMovement;
