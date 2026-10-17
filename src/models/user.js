//src/model/user.js

const mongoose = require('mongoose');

// Address sub-schema
const addressSchema = new mongoose.Schema({
    label: { type: String, enum: ['primary', 'secondary'], default: 'primary' },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    isDefault: { type: Boolean, default: false }
}, { _id: true, timestamps: true });

// User car sub-schema — a car that belongs to the user (for personalised
// recommendations + win-a-gift campaign). References the Make/Model/Variant
// catalog managed in admin/products/attributes?tab=cars. Users can own many.
const userCarSchema = new mongoose.Schema({
    makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'CarMake', required: true },
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'CarModel', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'CarVariant', default: null },
    makeName: { type: String, trim: true },
    makeLogoUrl: { type: String, trim: true, default: '' },
    modelName: { type: String, trim: true },
    variantName: { type: String, trim: true, default: '' }
}, { _id: true, timestamps: true });

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: false, default: null },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, default: null, index: true },
    avatarUrl: { type: String, default: null },
    phone: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null },
    role: { type: String, enum: ['user', 'admin', 'moderator'], default: 'user' },
    // ----- Staff access (see middleware/access.js) -----
    // Super admin: every branch, every permission.
    isSuperAdmin: { type: Boolean, default: false, index: true },
    // Permission role (Role collection). Staff only.
    staffRole: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, index: true },
    // Branch this staff user works in. null = all branches (super admin only).
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    addresses: [addressSchema],
    cars: { type: [userCarSchema], default: [] },

    // POS-specific optional fields — shared with the /admin/pos customer selector.
    // Populated when a walk-in is captured from the counter; safe to leave empty for
    // web signups.
    customerType: { type: String, enum: ['walk-in', 'online', null], default: null },
    source: {
      type: String,
      enum: ['facebook', 'tiktok', 'instagram', 'word-of-mouth', ''],
      default: '',
    },
    carDetails: [{
      brand: { type: String, default: '', trim: true },
      model: { type: String, default: '', trim: true },
      numberPlate: { type: String, default: '', trim: true },
    }],
}, { timestamps: true });

// Admin listing: filter by status + newest-first
userSchema.index({ isActive: 1, createdAt: -1 });
// Admin listing: filter by role + newest-first
userSchema.index({ role: 1, createdAt: -1 });
// Admin listing default sort
userSchema.index({ createdAt: -1 });
// "Last seen" sort column
userSchema.index({ lastLogin: -1 });
// Full-text search on name + email (admin users page search box)
userSchema.index(
  { firstName: 'text', lastName: 'text', email: 'text' },
  { name: 'user_text_idx', weights: { email: 5, firstName: 3, lastName: 3 } }
);

userSchema.plugin(require('../helper/softDeletePlugin'));
module.exports = mongoose.models.User || mongoose.model('User', userSchema);
