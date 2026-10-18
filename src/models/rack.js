// src/models/rack.js
// A physical rack in a branch, e.g. "A1". Racks are grouped by zone letter
// (A, B, C, D...) and numbered inside the zone (A1..A20). Each rack has
// shelves (see models/shelf.js), normally 4: A1-S1 .. A1-S4.
const mongoose = require('mongoose');

const rackSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    // Zone letter(s), e.g. "A". Uppercase.
    zone: { type: String, required: true, trim: true, uppercase: true },
    // Number inside the zone, e.g. 1 for "A1".
    number: { type: Number, required: true, min: 1 },
    // Rack code = zone + number, e.g. "A1". Unique per branch.
    code: { type: String, required: true, trim: true, uppercase: true },
    // Optional friendly name, e.g. "Kitchen items".
    name: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    // Category names usually kept on this rack (hint only, not enforced).
    categories: { type: [String], default: [] },
    // Number of active shelves (kept in sync by the racks service).
    shelfCount: { type: Number, min: 0, default: 0 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

rackSchema.plugin(require('../helper/softDeletePlugin'));

// One live rack per code per branch (a deleted rack's code can be reused).
rackSchema.index(
  { branch: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
rackSchema.index({ branch: 1, zone: 1, number: 1 });

module.exports = mongoose.models.Rack || mongoose.model('Rack', rackSchema);
