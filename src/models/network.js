// src/models/network.js
//
// A mobile network / operator whose easyload balance the shop resells
// (Jazz, Zong, Telenor, Ufone, ...). The running balance itself is not stored
// here — it lives in the per-day ledger, see models/networkDay.js.

const mongoose = require('mongoose');

const networkSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    // Short uppercase handle used for display chips and lookups (JAZZ, ZONG, ...)
    code: {
        type: String,
        required: true,
        trim: true,
        uppercase: true
    },
    // Brand colour, used for the card accent in the admin UI
    color: {
        type: String,
        default: '#dc2626',
        trim: true
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

networkSchema.index({ isDeleted: 1, createdAt: -1 });
networkSchema.index({ isDeleted: 1, isActive: 1 });
// Two live networks must not share a code. Partial filter keeps soft-deleted
// rows from blocking a re-create of the same code.
networkSchema.index(
    { code: 1 },
    { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);

module.exports = mongoose.models.Network || mongoose.model('Network', networkSchema);
