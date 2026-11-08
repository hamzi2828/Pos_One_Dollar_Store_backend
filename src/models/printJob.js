// src/models/printJob.js
// A receipt sent from a counter without a printer to the counter that has one.
// The printer counter's POS claims it, prints it locally, then marks it done.
// Rows delete themselves 3 days after they were made.
const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

const printJobSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['receipt'], default: 'receipt' },
    // { order: <POS order JSON>, storeName, symbol }
    payload: { type: Mixed, default: () => ({}) },
    orderNumber: { type: String, default: '' },
    branch: { type: ObjectId, ref: 'Branch', default: null },
    fromCounter: { type: ObjectId, ref: 'SaleCounter', default: null },
    fromCounterName: { type: String, default: '' },
    toCounter: { type: ObjectId, ref: 'SaleCounter', required: true, index: true },
    toCounterName: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'claimed', 'printed', 'failed'], default: 'pending' },
    claimedAt: { type: Date, default: null },
    claimedBy: { type: ObjectId, ref: 'User', default: null },
    printedAt: { type: Date, default: null },
    error: { type: String, default: '' },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false }
);

printJobSchema.index({ toCounter: 1, status: 1, createdAt: 1 });
printJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });

module.exports = mongoose.models.PrintJob || mongoose.model('PrintJob', printJobSchema);
