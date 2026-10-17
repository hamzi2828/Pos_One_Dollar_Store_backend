// src/models/asset.js

const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
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
    purchasePrice: {
        type: Number,
        required: true,
        min: 0
    },
    currentValue: {
        type: Number,
        default: null,
        min: 0
    },
    purchaseDate: {
        type: Date,
        required: true
    },
    vendor: {
        type: String,
        default: '',
        trim: true
    },
    location: {
        type: String,
        default: '',
        trim: true
    },
    serialNumber: {
        type: String,
        default: '',
        trim: true
    },
    status: {
        type: String,
        enum: ['active', 'maintenance', 'sold', 'disposed'],
        default: 'active'
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
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

assetSchema.index({ isDeleted: 1, createdAt: -1 });
assetSchema.index({ isDeleted: 1, status: 1 });
assetSchema.index({ isDeleted: 1, type: 1 });
assetSchema.index({ isDeleted: 1, purchaseDate: -1 });
assetSchema.index(
    { name: 'text', description: 'text', vendor: 'text', location: 'text', serialNumber: 'text' },
    { name: 'asset_text_idx', weights: { name: 5, serialNumber: 4, vendor: 2, location: 2, description: 1 } }
);

module.exports = mongoose.models.Asset || mongoose.model('Asset', assetSchema);
