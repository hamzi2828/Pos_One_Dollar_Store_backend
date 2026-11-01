// src/models/labelPrint.js
// History of sticker prints: what was printed, how many, which way (by sale /
// all pieces), who and when. Written by the sticker page's Print buttons
// through services/labelPrintLog.js.
const mongoose = require('mongoose');

const labelPrintSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: String, default: null },
    productName: { type: String, default: '' },
    code: { type: String, default: '' },
    // stickers printed of this product in this run / stickers on the page
    count: { type: Number, required: true, min: 1 },
    total: { type: Number, default: 0 },
    // sale = one per sale (set items), piece = all pieces, custom = a typed number
    mode: { type: String, enum: ['sale', 'piece', 'custom'], default: 'custom' },
    piecesPerSale: { type: Number, default: 1 },
    // printer = straight to the label printer (desktop app), browser = print window
    via: { type: String, enum: ['printer', 'browser'], default: 'browser' },
    size: { type: String, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

labelPrintSchema.index({ product: 1, createdAt: -1 });
labelPrintSchema.index({ createdAt: -1 });

module.exports = mongoose.models.LabelPrint || mongoose.model('LabelPrint', labelPrintSchema);
