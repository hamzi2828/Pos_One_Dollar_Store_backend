const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    category: { type: String, default: '', trim: true },
    address: {
      street: { type: String, default: '', trim: true },
      city: { type: String, default: '', trim: true },
      state: { type: String, default: '', trim: true },
      country: { type: String, default: '', trim: true },
      postalCode: { type: String, default: '', trim: true },
    },
    notes: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Common query patterns — filter by deletion + status, sort by createdAt desc.
vendorSchema.index({ isDeleted: 1, isActive: 1, createdAt: -1 });
vendorSchema.index({ isDeleted: 1, category: 1 });
vendorSchema.index({ isDeleted: 1, email: 1 });
vendorSchema.index(
  { name: 'text', contactPerson: 'text', email: 'text', phone: 'text', category: 'text', notes: 'text' },
  { name: 'vendor_text_idx', weights: { name: 10, contactPerson: 5, email: 3, phone: 3, category: 2, notes: 1 } }
);

module.exports = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
