// src/models/stockAdjustment.js
// Stock count sheet / manual correction. Each line has the system qty (frozen
// when the sheet was last saved), the counted qty and the difference. Applying
// the sheet moves stock by `diff` (receiveStock for +, deductStock for -), one
// ledger row per line. Owner: Stock operations module.
const mongoose = require('mongoose');

const REASONS = ['count_correction', 'found', 'lost', 'opening', 'other'];

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    systemQty: { type: Number, default: 0 },
    countedQty: { type: Number, default: null }, // null = qty mode (diff typed)
    diff: { type: Number, default: 0 }, // + in, - out
    unitCost: { type: Number, default: 0 }, // average cost when saved (value of the diff)
    applied: { type: Boolean, default: false },
    movementType: { type: String, default: '' },
    movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
    error: { type: String, default: '' },
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

const stockAdjustmentSchema = new mongoose.Schema(
  {
    adjNo: { type: String, required: true, unique: true }, // ADJ-2026-00001
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    reason: { type: String, enum: REASONS, default: 'count_correction' },
    lines: { type: [lineSchema], default: [] },
    notes: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['draft', 'applied', 'cancelled'], default: 'draft' },
    totals: {
      lines: { type: Number, default: 0 },
      piecesIn: { type: Number, default: 0 },
      piecesOut: { type: Number, default: 0 },
      valueIn: { type: Number, default: 0 },
      valueOut: { type: Number, default: 0 },
    },
    processingAt: { type: Date, default: null },
    requestId: { type: String, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appliedAt: { type: Date, default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

stockAdjustmentSchema.index({ branch: 1, createdAt: -1 });
stockAdjustmentSchema.index({ branch: 1, status: 1, createdAt: -1 });
stockAdjustmentSchema.index({ 'lines.product': 1, createdAt: -1 });
stockAdjustmentSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });

const StockAdjustment = mongoose.models.StockAdjustment || mongoose.model('StockAdjustment', stockAdjustmentSchema);
StockAdjustment.REASONS = REASONS;

module.exports = StockAdjustment;
