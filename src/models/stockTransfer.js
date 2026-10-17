// src/models/stockTransfer.js
// History of stock moved between branches. The move itself happens when the
// transfer is created (services/stockService.transferStock, one product line at
// a time); this record says what moved and which lines failed.
const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema(
  {
    batchNo: { type: String },
    quantity: { type: Number },
  },
  { _id: false }
);

const transferItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true, default: '' },
    variantId: { type: String, default: null },
    variantLabel: { type: String, trim: true, default: '' },
    sku: { type: String, trim: true, default: '' },
    quantity: { type: Number, required: true, min: 1 }, // pieces asked for
    batchNo: { type: String, default: null }, // batch asked for (optional)
    // Batches the pieces came out of (same batchNo lands in the target branch).
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: ['done', 'failed'], default: 'done' },
    error: { type: String, default: '' },
  },
  { _id: true }
);

const stockTransferSchema = new mongoose.Schema(
  {
    transferNo: { type: String, required: true, unique: true, trim: true }, // TR-YYYYMMDD-0001
    fromBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    toBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    items: { type: [transferItemSchema], default: [] },
    note: { type: String, trim: true, default: '' },
    // completed = every line moved; partial = some failed; failed = nothing moved
    status: { type: String, enum: ['completed', 'partial', 'failed'], default: 'completed', index: true },
    totalQuantity: { type: Number, default: 0 }, // pieces actually moved
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

stockTransferSchema.index({ createdAt: -1 });
stockTransferSchema.index({ fromBranch: 1, createdAt: -1 });
stockTransferSchema.index({ toBranch: 1, createdAt: -1 });
stockTransferSchema.index({ 'items.product': 1 });

// Next free number for today: TR-20261017-0001, TR-20261017-0002, ...
stockTransferSchema.statics.generateTransferNo = async function generateTransferNo(date = new Date()) {
  const d = new Date(date);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `TR-${ymd}-`;
  const last = await this.findOne({ transferNo: { $regex: `^${prefix}` } })
    .sort({ transferNo: -1 })
    .select('transferNo')
    .lean();
  const n = last ? parseInt(String(last.transferNo).slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
};

module.exports = mongoose.models.StockTransfer || mongoose.model('StockTransfer', stockTransferSchema);
