// src/models/user.js
// Users of the admin panel (staff logins) and POS customers.
//   staff:    role 'admin' + a permission role (staffRole), or isSuperAdmin
//   customer: role 'user' (walk-in / regular customers picked at the POS)

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    // Optional: many people use a single name.
    lastName: { type: String, trim: true, default: '' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // bcrypt hash; null for POS customers (they never log in).
    password: { type: String, required: false, default: null },
    avatarUrl: { type: String, default: null },
    phone: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null },
    role: { type: String, enum: ['user', 'admin', 'moderator'], default: 'user' },
    // ----- Staff access (see middleware/access.js) -----
    // Super admin: every permission.
    isSuperAdmin: { type: Boolean, default: false, index: true },
    // Permission role (Role collection). Staff only.
    staffRole: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, index: true },
    // The shop (staff logins only; null for the super admin).
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },

    // POS customer fields (the /admin/pos customer picker).
    customerType: { type: String, enum: ['walk-in', 'online', null], default: null },
    source: {
      type: String,
      enum: ['facebook', 'tiktok', 'instagram', 'word-of-mouth', ''],
      default: '',
    },
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
