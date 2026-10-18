// src/models/damageRecord.js
// One damaged / expired / missing item report ("daily damage list").
// Reported by scanning the item's barcode; stock leaves the branch only when a
// manager approves it (services/stockops/damageService.js -> stockService.deductStock
// with a 'damage' movement). Owner: Stock operations module.
const mongoose = require('mongoose');

const REASONS = ['broken', 'expired', 'defective', 'water_damage', 'rodent', 'missing', 'other'];
const STATUSES = ['pending', 'approved', 'rejected'];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const damageRecordSchema = new mongoose.Schema(
  {
    damageNo: { type: String, required: true, unique: true }, // DMG-2026-00001
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // When the damage was found (the daily list groups by this, PKT day).
    date: { type: Date, default: Date.now },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    variantLabel: { type: String, default: '' },
    category: { type: String, default: '' },
    code: { type: String, default: '' }, // unit short code / SKU (printed as barcode)
    scannedCode: { type: String, default: '' }, // what was actually scanned
    batchNo: { type: String, default: '' }, // when a batch label was scanned

    qty: { type: Number, required: true, min: 1 },
    location: { type: String, enum: ['shelf', 'warehouse'], default: 'shelf' },
    shelf: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf', default: null },
    shelfCode: { type: String, default: '' },
    reason: { type: String, enum: REASONS, required: true },
    description: { type: String, trim: true, default: '' },
    photos: { type: [String], default: [] },

    // Average landed cost per piece when reported; totalLoss = qty * unitCost.
    unitCost: { type: Number, default: 0 },
    totalLoss: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 }, // sale price per piece (lost sale value)

    // Last vendor of the item; claimable = can be claimed back from the vendor.
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    vendorName: { type: String, default: '' },
    claimable: { type: Boolean, default: false },

    status: { type: String, enum: STATUSES, default: 'pending' },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: '' },

    // Stock bookkeeping (retry safety): set right after the stock was taken off.
    stockDeducted: { type: Boolean, default: false },
    movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
    // Claim while an approval runs (two managers clicking at once).
    processingAt: { type: Date, default: null },
    // Client idempotency key: the same report sent twice creates one record.
    requestId: { type: String, default: undefined },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

damageRecordSchema.plugin(require('../helper/softDeletePlugin'));

damageRecordSchema.index({ branch: 1, date: -1 });
damageRecordSchema.index({ branch: 1, status: 1, date: -1 });
damageRecordSchema.index({ product: 1, date: -1 });
damageRecordSchema.index({ status: 1, date: -1 });
damageRecordSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });

damageRecordSchema.statics.REASONS = REASONS;
damageRecordSchema.statics.STATUSES = STATUSES;

const DamageRecord = mongoose.models.DamageRecord || mongoose.model('DamageRecord', damageRecordSchema);
DamageRecord.REASONS = REASONS;
DamageRecord.STATUSES = STATUSES;

module.exports = DamageRecord;
