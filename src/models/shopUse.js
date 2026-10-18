// src/models/shopUse.js
// Items the shop takes from its own stock for its own use (cleaning items,
// bags, bulbs...). Stock leaves the branch ('internal_use' movements, warehouse
// first) and the cost at average landed cost is posted as an Expense
// (source 'shop_use'). Voiding puts the stock back and soft-deletes the expense.
// Owner: Stock operations module (services/stockops/shopUseService.js).
const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    code: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, default: 0 }, // average landed cost per piece
    total: { type: Number, default: 0 },
    // Batches the pieces came out of (used to put them back on void).
    allocations: { type: [{ _id: false, batchNo: String, quantity: Number }], default: [] },
    restored: { type: Boolean, default: false }, // put back by a void
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

const shopUseSchema = new mongoose.Schema(
  {
    shopUseNo: { type: String, required: true, unique: true }, // SU-2026-00001
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    date: { type: Date, default: Date.now },
    lines: { type: [lineSchema], default: [] },
    purpose: { type: String, trim: true, required: true },
    // Staff member who took the items (user) and/or a typed name.
    takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    takenByName: { type: String, trim: true, default: '' },
    totalCost: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },
    expense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
    status: { type: String, enum: ['active', 'voided'], default: 'active' },

    stockDeducted: { type: Boolean, default: false },
    processingAt: { type: Date, default: null },
    requestId: { type: String, default: undefined },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: '' },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

shopUseSchema.index({ branch: 1, date: -1 });
shopUseSchema.index({ branch: 1, status: 1, date: -1 });
shopUseSchema.index({ 'lines.product': 1, date: -1 });
shopUseSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });

module.exports = mongoose.models.ShopUse || mongoose.model('ShopUse', shopUseSchema);
