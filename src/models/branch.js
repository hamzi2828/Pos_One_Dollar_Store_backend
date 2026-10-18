// src/models/branch.js
// The shop. DOLLAR & Co runs ONE shop: Branch.getMain() is that shop. The stock
// engine (product.branchStock, batch.branch) and the store modules stamp every
// record with its id. There are no screens or routes to add more branches.
const mongoose = require('mongoose');

const SHOP_DEFAULTS = { name: 'DOLLAR & Co', code: 'MAIN' };

const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Short code shown on receipts / reports. Unique.
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    address: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    // The shop. Records without a branch (old data) belong to it.
    isMain: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

branchSchema.plugin(require('../helper/softDeletePlugin'));

// The shop (created as "DOLLAR & Co" / "MAIN" the first time it is needed).
branchSchema.statics.getMain = async function getMain() {
  let main = await this.findOne({ isMain: true });
  if (!main) main = await this.findOne({}).sort({ createdAt: 1 });
  if (!main) main = await this.create({ ...SHOP_DEFAULTS, isMain: true });
  else if (!main.isMain) {
    main.isMain = true;
    await main.save();
  }
  return main;
};

branchSchema.statics.SHOP_DEFAULTS = SHOP_DEFAULTS;

module.exports = mongoose.models.Branch || mongoose.model('Branch', branchSchema);
