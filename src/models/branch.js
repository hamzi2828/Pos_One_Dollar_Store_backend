// src/models/branch.js
// A shop branch (Branch 1, Branch 2...). Products are shared; each branch has
// its own stock (see product.branchStock / batch.branch), sales and users.
const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Short code shown on receipts / reports, e.g. "B1". Unique.
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    address: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    // Exactly one main branch: old stock/sales without a branch belong to it.
    isMain: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

branchSchema.plugin(require('../helper/softDeletePlugin'));

// Main branch (creates "Main Branch" / "B1" if there is none yet).
branchSchema.statics.getMain = async function getMain() {
  let main = await this.findOne({ isMain: true });
  if (!main) main = await this.findOne({}).sort({ createdAt: 1 });
  if (!main) main = await this.create({ name: 'Main Branch', code: 'B1', isMain: true });
  else if (!main.isMain) {
    main.isMain = true;
    await main.save();
  }
  return main;
};

module.exports = mongoose.models.Branch || mongoose.model('Branch', branchSchema);
