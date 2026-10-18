// src/models/role.js
// Roles & Permissions — each role holds a map of module -> allowed actions.
// The built-in "Admin" role is flagged with isSystem: true and cannot be
// renamed, edited, or deleted from the admin UI.

const mongoose = require('mongoose');

const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

const roleSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        description: { type: String, default: '', trim: true },

        // permissions: Map of permission-group key -> array of allowed actions.
        // e.g. { orders: ['view', 'edit'], products: ['view', 'create'] }
        permissions: {
            type: Map,
            of: [{ type: String, enum: PERMISSION_ACTIONS }],
            default: () => ({}),
        },

        // System roles (e.g. Admin) cannot be edited/deleted from the UI.
        isSystem: { type: Boolean, default: false, index: true },
        // Permission keys that existed when this role was last saved. Keys added to
        // the catalogue later are "new" for this role, so "Add default roles" can
        // give default roles their new permissions without undoing the owner's edits.
        knownPermissionKeys: { type: [String], default: undefined },

        userCount: { type: Number, default: 0 },

        // Soft-delete
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

roleSchema.index({ isDeleted: 1, createdAt: -1 });
roleSchema.index({ name: 1, isDeleted: 1 });

roleSchema.statics.PERMISSION_ACTIONS = PERMISSION_ACTIONS;

module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);
module.exports.PERMISSION_ACTIONS = PERMISSION_ACTIONS;
