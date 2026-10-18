// src/models/asset.js
// Asset register: things the shop owns (racks, counters, POS PCs, AC, generator...).
//
// Money: purchasePrice and salvageValue are PER UNIT; totals = x quantity.
// Depreciation (straight line, monthly) is computed on read by
// services/hr/depreciation.js — `currentValue` in API responses is computed,
// the stored `currentValue` is the old manual value (kept for the old /assets screen).
// `type` is the old fixed category list, kept in step with `category` for old screens.

const mongoose = require('mongoose');
const { nextNumber } = require('../services/sequenceService');

const { ObjectId } = mongoose.Schema.Types;

// Old `type` <-> default category codes (models/assetCategory.js).
const LEGACY_TYPE_TO_CODE = { furniture: 'FUR', electronics: 'IT', equipment: 'MCH', vehicle: 'VEH', property: 'BLD', other: 'OTH' };
const CODE_TO_LEGACY_TYPE = { FUR: 'furniture', IT: 'electronics', MCH: 'equipment', VEH: 'vehicle', BLD: 'property', SEC: 'equipment', SW: 'other', OTH: 'other' };

const assetSchema = new mongoose.Schema({
    // AST-2026-00001 (sequenceService). Set automatically on create.
    assetCode: { type: String, default: undefined, trim: true },
    name: {
        type: String,
        required: true,
        trim: true
    },
    category: { type: ObjectId, ref: 'AssetCategory', default: null },
    type: {
        type: String,
        enum: ['vehicle', 'equipment', 'property', 'furniture', 'electronics', 'other'],
        default: 'other'
    },
    description: {
        type: String,
        default: '',
        trim: true
    },
    branch: { type: ObjectId, ref: 'Branch', default: null },
    // Free text inside the branch, e.g. "Counter 1", "Rack A1", "Store room".
    location: {
        type: String,
        default: '',
        trim: true
    },
    assignedTo: { type: ObjectId, ref: 'Employee', default: null },
    quantity: { type: Number, default: 1, min: 1 },
    purchasePrice: { // per unit
        type: Number,
        required: true,
        min: 0
    },
    // Old manual value (see header). New code returns the computed value instead.
    currentValue: {
        type: Number,
        default: null,
        min: 0
    },
    purchaseDate: {
        type: Date,
        required: true
    },
    vendor: { // vendor name (text); vendorRef links a Vendor when there is one
        type: String,
        default: '',
        trim: true
    },
    vendorRef: { type: ObjectId, ref: 'Vendor', default: null },
    invoiceNo: { type: String, default: '', trim: true },
    warrantyUntil: { type: Date, default: null },
    serialNumber: {
        type: String,
        default: '',
        trim: true
    },
    // null = use the category's setting.
    depreciationMethod: { type: String, enum: ['straight_line', 'none', null], default: null },
    usefulLifeYears: { type: Number, default: null, min: 0 },
    salvageValue: { type: Number, default: 0, min: 0 }, // per unit
    status: {
        type: String,
        enum: ['active', 'maintenance', 'sold', 'disposed'],
        default: 'active'
    },
    photos: { type: [String], default: [] },
    maintenanceLog: [{
        date: { type: Date, default: Date.now },
        cost: { type: Number, default: 0, min: 0 },
        note: { type: String, default: '', trim: true },
        by: { type: ObjectId, ref: 'User', default: null },
    }],
    disposal: {
        date: { type: Date, default: null },
        amount: { type: Number, default: null, min: 0 }, // money received (0 when scrapped)
        note: { type: String, default: '', trim: true },
        bookValue: { type: Number, default: null }, // value on the disposal date
        by: { type: ObjectId, ref: 'User', default: null },
    },
    history: [{
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: ObjectId, ref: 'User', default: null },
        action: { type: String, required: true },
        note: { type: String, default: '' },
    }],
    notes: {
        type: String,
        default: '',
        trim: true
    },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedAt: {
        type: Date,
        default: null
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
}, { timestamps: true });

// Code for new rows; old screens (which only send `type`) still get a category.
assetSchema.pre('validate', async function fillDefaults() {
    if (this.isNew && !this.assetCode) this.assetCode = await nextNumber('AST');
    if (!this.category && this.type) {
        const AssetCategory = require('./assetCategory');
        const code = LEGACY_TYPE_TO_CODE[this.type];
        const cat = code ? await AssetCategory.findOne({ code }).select('_id').lean() : null;
        if (cat) this.category = cat._id;
    }
});

assetSchema.index({ isDeleted: 1, createdAt: -1 });
assetSchema.index({ isDeleted: 1, status: 1 });
assetSchema.index({ isDeleted: 1, type: 1 });
assetSchema.index({ isDeleted: 1, purchaseDate: -1 });
assetSchema.index({ isDeleted: 1, branch: 1, category: 1, status: 1, createdAt: -1 });
assetSchema.index({ assignedTo: 1 });
assetSchema.index({ assetCode: 1 }, { unique: true, partialFilterExpression: { assetCode: { $type: 'string' } } });
assetSchema.index(
    { name: 'text', description: 'text', vendor: 'text', location: 'text', serialNumber: 'text' },
    { name: 'asset_text_idx', weights: { name: 5, serialNumber: 4, vendor: 2, location: 2, description: 1 } }
);

const Asset = mongoose.models.Asset || mongoose.model('Asset', assetSchema);
Object.assign(Asset, { LEGACY_TYPE_TO_CODE, CODE_TO_LEGACY_TYPE });

module.exports = Asset;
