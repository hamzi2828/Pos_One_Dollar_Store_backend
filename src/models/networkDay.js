// src/models/networkDay.js
//
// One row per network per calendar day — the shop's daily easyload register.
//
//   openingBalance  balance at the start of the day (carried from yesterday's close)
//   loads[]         top-ups bought from the load provider during the day
//   closingBalance  balance read off the network at the end of the day
//
//   sold = openingBalance + sum(loads.amount) - closingBalance
//
// `date` is a plain 'YYYY-MM-DD' string rather than a Date on purpose: the shop
// closes its books on Pakistan local time, and storing a Date would make the
// day boundary depend on the server's timezone.

const mongoose = require('mongoose');

const loadEntrySchema = new mongoose.Schema({
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    // Who the load was bought from (distributor / franchise / online portal)
    provider: {
        type: String,
        default: '',
        trim: true
    },
    // Transaction id or slip number from the provider
    reference: {
        type: String,
        default: '',
        trim: true
    },
    note: {
        type: String,
        default: '',
        trim: true
    },
    at: {
        type: Date,
        default: Date.now
    },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { _id: true });

const networkDaySchema = new mongoose.Schema({
    network: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Network',
        required: true,
        index: true
    },
    // 'YYYY-MM-DD'
    date: {
        type: String,
        required: true,
        trim: true,
        match: /^\d{4}-\d{2}-\d{2}$/
    },
    openingBalance: {
        type: Number,
        default: 0
    },
    // null until the day is closed off
    closingBalance: {
        type: Number,
        default: null
    },
    loads: {
        type: [loadEntrySchema],
        default: []
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// One ledger row per network per day.
networkDaySchema.index(
    { network: 1, date: 1 },
    { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);
networkDaySchema.index({ network: 1, date: -1 });
networkDaySchema.index({ isDeleted: 1, date: -1 });

module.exports = mongoose.models.NetworkDay || mongoose.model('NetworkDay', networkDaySchema);
