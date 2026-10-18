// src/models/vendor.js
// A supplier we buy from (or who places sale-or-return stock with us).
// Their account — what we owe them — lives in models/vendorLedgerEntry.js
// (services/vendorLedgerService.js), never on this document.
//
// Soft delete is manual (isDeleted) because older code filters it by hand.
const mongoose = require('mongoose');

const bankDetailsSchema = new mongoose.Schema(
  {
    bankName: { type: String, default: '', trim: true },
    accountTitle: { type: String, default: '', trim: true },
    accountNumber: { type: String, default: '', trim: true },
    iban: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Short vendor code, e.g. "VEN-0001" (auto when left empty). Unique among live vendors.
    code: { type: String, trim: true, uppercase: true, default: undefined },
    contactPerson: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    whatsapp: { type: String, default: '', trim: true },
    cnic: { type: String, default: '', trim: true },
    ntn: { type: String, default: '', trim: true },
    // Old single category (kept for older screens) + every category the vendor supplies.
    category: { type: String, default: '', trim: true },
    categories: { type: [String], default: [] },
    city: { type: String, default: '', trim: true }, // mirrored into address.city
    address: {
      street: { type: String, default: '', trim: true },
      city: { type: String, default: '', trim: true },
      state: { type: String, default: '', trim: true },
      country: { type: String, default: '', trim: true },
      postalCode: { type: String, default: '', trim: true },
    },
    bankDetails: { type: bankDetailsSchema, default: () => ({}) },
    // Days we normally get to pay a bill (0 = cash on delivery).
    paymentTermsDays: { type: Number, min: 0, default: 0 },
    // Places sale-or-return stock (consignment) with us.
    isConsignment: { type: Boolean, default: false },
    notes: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Keep the old and new copies of city / category in step.
vendorSchema.pre('validate', function syncCopies(next) {
  if (!this.address) this.address = {};
  if (this.city) this.address.city = this.city;
  else if (this.address.city) this.city = this.address.city;

  const cats = [...new Set((this.categories || []).map((c) => String(c || '').trim()).filter(Boolean))];
  if (!cats.length && this.category) cats.push(this.category);
  this.categories = cats;
  this.category = cats[0] || '';

  if (this.code === '') this.code = undefined;
  next();
});

// Common query patterns — filter by deletion + status, sort by createdAt desc.
vendorSchema.index({ isDeleted: 1, isActive: 1, createdAt: -1 });
vendorSchema.index({ isDeleted: 1, category: 1 });
vendorSchema.index({ isDeleted: 1, email: 1 });
vendorSchema.index({ isDeleted: 1, isConsignment: 1, name: 1 });
vendorSchema.index({ isDeleted: 1, name: 1 });
vendorSchema.index(
  { code: 1 },
  { unique: true, name: 'vendor_code_unique', partialFilterExpression: { isDeleted: false, code: { $type: 'string' } } }
);
vendorSchema.index(
  { name: 'text', contactPerson: 'text', email: 'text', phone: 'text', category: 'text', notes: 'text' },
  { name: 'vendor_text_idx', weights: { name: 10, contactPerson: 5, email: 3, phone: 3, category: 2, notes: 1 } }
);

module.exports = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
