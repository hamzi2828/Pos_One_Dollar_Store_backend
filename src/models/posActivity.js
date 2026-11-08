// src/models/posActivity.js
// What happened on the POS selling screen for one cart (bill): every scan and
// click, and how far it got (completed, held, cleared, failed or still open).
// One document per cart session (client uuid). Deleted 120 days after lastAt.
const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

const STATUSES = ['open', 'completed', 'held', 'cleared', 'failed'];
const MAX_EVENTS = 500;

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    type: { type: String, default: '' },
    label: { type: String, default: '' },
    data: { type: Mixed, default: () => ({}) },
  },
  { _id: false, minimize: false }
);

const posActivitySchema = new mongoose.Schema(
  {
    cartId: { type: String, required: true, unique: true },
    user: { type: ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    counter: { type: ObjectId, ref: 'SaleCounter', default: null },
    counterName: { type: String, default: '' },
    cashSession: { type: ObjectId, ref: 'CashSession', default: null },
    deviceName: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    lastAt: { type: Date, default: Date.now },
    status: { type: String, enum: STATUSES, default: 'open' },
    lastStep: { type: String, default: '' },
    order: { type: ObjectId, ref: 'POSOrder', default: null, index: true },
    orderNumber: { type: String, default: '', index: true },
    itemCount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    events: { type: [eventSchema], default: [] },
    branch: { type: ObjectId, ref: 'Branch', default: null },
  },
  { timestamps: true, minimize: false }
);

posActivitySchema.index({ lastAt: -1 });
posActivitySchema.index({ status: 1, lastAt: -1 });
posActivitySchema.index({ lastAt: 1 }, { expireAfterSeconds: 120 * 24 * 3600, name: 'ttl_lastAt' });

posActivitySchema.statics.STATUSES = STATUSES;
posActivitySchema.statics.MAX_EVENTS = MAX_EVENTS;

module.exports = mongoose.models.PosActivity || mongoose.model('PosActivity', posActivitySchema);
