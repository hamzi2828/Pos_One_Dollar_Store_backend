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
    // negative on a "moved" row: printed stickers that left with pieces moved to another vendor
    count: { type: Number, required: true },
    total: { type: Number, default: 0 },
    // sale = one per sale (set items), piece = all pieces, custom = a typed number
    // removed = extra stickers (more than the pieces) taken off the log (negative count)
    mode: { type: String, enum: ['sale', 'piece', 'custom', 'moved', 'scanned', 'removed'], default: 'custom' },
    // Vendor bill (receiving) the stickers were printed for; null = printed outside receiving.
    bill: { type: mongoose.Schema.Types.ObjectId, default: null },
    note: { type: String, default: '' },
    piecesPerSale: { type: Number, default: 1 },
    // printer = straight to the label printer (desktop app), browser = print window
    via: { type: String, enum: ['printer', 'browser'], default: 'browser' },
    size: { type: String, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    // Test / wrong prints the shop chose to ignore: kept, but not counted or listed.
    ignored: { type: Boolean, default: false },
    ignoredBy: { type: String, default: '' },
    ignoredAt: { type: Date, default: null },
    // Own-barcode rows: pieces per scanned barcode on this trip ({ "6971326241177": 40 }).
    codes: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

labelPrintSchema.index({ product: 1, createdAt: -1 });
labelPrintSchema.index({ createdAt: -1 });

module.exports = mongoose.models.LabelPrint || mongoose.model('LabelPrint', labelPrintSchema);
