// src/models/shelf.js
// One shelf of a rack, e.g. "A1-S2" (rack A1, level 2). Stock placed on a
// shelf lives in models/locationStock.js. Stock of a branch that is not on
// any shelf is "in the warehouse" (see services/inventory/locationService.js).
const mongoose = require('mongoose');

const shelfSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    rack: { type: mongoose.Schema.Types.ObjectId, ref: 'Rack', required: true, index: true },
    // Denormalized rack code ("A1") for fast lists and labels.
    rackCode: { type: String, required: true, trim: true, uppercase: true },
    // Level inside the rack: 1 = bottom (or top — shop's own convention).
    level: { type: Number, required: true, min: 1 },
    // Shelf code = "<rackCode>-S<level>", e.g. "A1-S2". Unique per branch.
    // Printed as a barcode on the shelf label and scanned during put-away.
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, trim: true, default: '' },
    // Optional capacity in pieces (warning only).
    capacity: { type: Number, min: 0, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

shelfSchema.plugin(require('../helper/softDeletePlugin'));

shelfSchema.index(
  { branch: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
shelfSchema.index({ rack: 1, level: 1 });

module.exports = mongoose.models.Shelf || mongoose.model('Shelf', shelfSchema);
