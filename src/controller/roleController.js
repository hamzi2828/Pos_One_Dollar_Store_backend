// src/controller/roleController.js

const Role = require('../models/role');
const User = require('../models/user');
const { clearAccessCache } = require('../middleware/access');
const {
    PERMISSION_SECTIONS,
    PERMISSION_GROUPS,
    buildAllPermissions,
    sanitizePermissions,
    ADMIN_ROLE_NAME,
} = require('../constants/rolePermissions');
const { paginate, buildRegexSearchFilter, readPagingQuery } = require('../helper/paginate');

const ROLE_SORTABLE = ['createdAt', 'name'];
const ROLE_SEARCH_FIELDS = ['name', 'description'];

/**
 * Turn a Mongoose Map into a plain object so responses stay consistent
 * regardless of how the doc was loaded.
 */
function permissionsToPlain(doc) {
    if (!doc) return {};
    const p = doc.permissions;
    if (!p) return {};
    if (typeof p.toObject === 'function') return p.toObject();
    if (p instanceof Map) return Object.fromEntries(p);
    return p;
}

function shapeRole(doc) {
    if (!doc) return null;
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
        id: String(plain._id),
        name: plain.name,
        description: plain.description || '',
        permissions: permissionsToPlain(plain),
        isSystem: !!plain.isSystem,
        userCount: plain.userCount || 0,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
}

/**
 * Ensure the built-in Admin role always exists, is named "Admin", is marked
 * isSystem, and has every permission. Idempotent — safe to call on every
 * list request so the invariant can't drift.
 */
async function ensureAdminRole() {
    let admin = await Role.findOne({ isSystem: true, isDeleted: { $ne: true } });
    const fullPerms = buildAllPermissions();

    if (!admin) {
        admin = await Role.create({
            name: ADMIN_ROLE_NAME,
            description: 'Built-in administrator with full access to every module and setting.',
            permissions: fullPerms,
            isSystem: true,
            userCount: 0,
        });
        return admin;
    }

    // Keep the invariants locked in: name + full permissions (every key AND
    // every action, so new keys/actions added to the catalogue show up).
    let dirty = false;
    if (admin.name !== ADMIN_ROLE_NAME) {
        admin.name = ADMIN_ROLE_NAME;
        dirty = true;
    }
    if (!samePermissions(permissionsToPlain(admin), fullPerms)) {
        admin.permissions = fullPerms;
        dirty = true;
    }
    if (dirty) {
        await admin.save();
        clearAccessCache();
    }
    return admin;
}

function samePermissions(a, b) {
    const ak = Object.keys(a || {});
    const bk = Object.keys(b || {});
    if (ak.length !== bk.length) return false;
    return bk.every((k) => {
        const x = Array.isArray(a[k]) ? [...a[k]].sort() : [];
        const y = Array.isArray(b[k]) ? [...b[k]].sort() : [];
        return x.length === y.length && x.every((v, i) => v === y[i]);
    });
}

/** Live number of (not deleted) users per staff role, for the given role ids. */
async function countUsersByRole(roleIds) {
    const ids = (roleIds || []).filter(Boolean);
    if (!ids.length) return {};
    const rows = await User.aggregate([
        { $match: { staffRole: { $in: ids } } },
        { $group: { _id: '$staffRole', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, r) => {
        acc[String(r._id)] = r.count;
        return acc;
    }, {});
}

const roleController = {
    /** GET /admin/roles/catalogue — sections + groups so the frontend can render. */
    getCatalogue: async (_req, res) => {
        try {
            return res.status(200).json({
                message: 'Permission catalogue fetched',
                data: {
                    sections: PERMISSION_SECTIONS,
                    groups: PERMISSION_GROUPS,
                },
            });
        } catch (error) {
            console.error('Error fetching permission catalogue:', error);
            return res.status(500).json({ message: 'Failed to fetch permission catalogue' });
        }
    },

    /** GET /admin/roles */
    getAllRoles: async (req, res) => {
        try {
            // Seeding the Admin role must never break the list endpoint —
            // if it fails (duplicate key from a concurrent request, cast issue,
            // etc.) just log it and keep going; a later request will heal it.
            try {
                await ensureAdminRole();
            } catch (seedErr) {
                console.error('ensureAdminRole failed (continuing):', seedErr);
            }

            const { search } = req.query;
            const filter = { isDeleted: { $ne: true } };
            const regex = buildRegexSearchFilter(search, ROLE_SEARCH_FIELDS);
            if (regex) Object.assign(filter, regex);

            const paging = readPagingQuery(req.query, {
                defaultSortBy: 'createdAt',
                defaultSortDir: 'desc',
                allowedSortFields: ROLE_SORTABLE,
            });

            const { items, pagination } = await paginate(Role, { filter, ...paging, lean: false });

            // Pin the system Admin role to the top regardless of sort.
            const shaped = items.map(shapeRole);
            // userCount = live count of staff using the role (cheap: one aggregate).
            try {
                const counts = await countUsersByRole(items.map((r) => r._id));
                shaped.forEach((r) => { r.userCount = counts[r.id] || 0; });
            } catch (countErr) {
                console.error('Role user count failed (continuing):', countErr);
            }
            shaped.sort((a, b) => {
                if (a.isSystem && !b.isSystem) return -1;
                if (!a.isSystem && b.isSystem) return 1;
                return 0;
            });

            return res.status(200).json({
                message: 'Roles fetched successfully',
                data: shaped,
                pagination,
            });
        } catch (error) {
            console.error('Error fetching roles:', error);
            return res.status(500).json({
                message: 'Failed to fetch roles',
                error: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error),
            });
        }
    },

    /** GET /admin/roles/:id */
    getRoleById: async (req, res) => {
        try {
            const { id } = req.params;
            const role = await Role.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!role) return res.status(404).json({ message: 'Role not found' });
            return res.status(200).json({
                message: 'Role fetched successfully',
                data: shapeRole(role),
            });
        } catch (error) {
            console.error('Error fetching role:', error);
            return res.status(500).json({ message: 'Failed to fetch role' });
        }
    },

    /** POST /admin/roles */
    createRole: async (req, res) => {
        try {
            const { name, description, permissions } = req.body || {};

            if (!name || !String(name).trim()) {
                return res.status(400).json({ message: 'Role name is required' });
            }
            const trimmedName = String(name).trim();
            if (trimmedName.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
                return res.status(400).json({ message: `"${ADMIN_ROLE_NAME}" is reserved` });
            }

            const dup = await Role.findOne({
                name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
                isDeleted: { $ne: true },
            });
            if (dup) {
                return res.status(409).json({ message: 'A role with that name already exists' });
            }

            const role = await Role.create({
                name: trimmedName,
                description: typeof description === 'string' ? description.trim() : '',
                permissions: sanitizePermissions(permissions),
                isSystem: false,
            });

            return res.status(201).json({
                message: 'Role created successfully',
                data: shapeRole(role),
            });
        } catch (error) {
            console.error('Error creating role:', error);
            return res.status(500).json({ message: 'Failed to create role' });
        }
    },

    /** PUT /admin/roles/:id — rename + description (permissions handled separately). */
    updateRole: async (req, res) => {
        try {
            const { id } = req.params;
            const { name, description } = req.body || {};

            const role = await Role.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!role) return res.status(404).json({ message: 'Role not found' });
            if (role.isSystem) {
                return res.status(403).json({ message: 'System roles cannot be edited' });
            }

            if (name !== undefined) {
                const trimmed = String(name).trim();
                if (!trimmed) return res.status(400).json({ message: 'Role name cannot be empty' });
                if (trimmed.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
                    return res.status(400).json({ message: `"${ADMIN_ROLE_NAME}" is reserved` });
                }
                const dup = await Role.findOne({
                    _id: { $ne: role._id },
                    name: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
                    isDeleted: { $ne: true },
                });
                if (dup) return res.status(409).json({ message: 'A role with that name already exists' });
                role.name = trimmed;
            }
            if (description !== undefined) {
                role.description = String(description).trim();
            }

            await role.save();
            clearAccessCache(); // roleName is cached per user

            return res.status(200).json({
                message: 'Role updated successfully',
                data: shapeRole(role),
            });
        } catch (error) {
            console.error('Error updating role:', error);
            return res.status(500).json({ message: 'Failed to update role' });
        }
    },

    /** PUT /admin/roles/:id/permissions */
    updatePermissions: async (req, res) => {
        try {
            const { id } = req.params;
            const { permissions } = req.body || {};

            const role = await Role.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!role) return res.status(404).json({ message: 'Role not found' });
            if (role.isSystem) {
                return res.status(403).json({ message: 'System role permissions cannot be changed' });
            }

            role.permissions = sanitizePermissions(permissions);
            await role.save();
            clearAccessCache(); // every user with this role must see the change now

            return res.status(200).json({
                message: 'Permissions updated successfully',
                data: shapeRole(role),
            });
        } catch (error) {
            console.error('Error updating permissions:', error);
            return res.status(500).json({ message: 'Failed to update permissions' });
        }
    },

    /** DELETE /admin/roles/:id — soft delete. */
    deleteRole: async (req, res) => {
        try {
            const { id } = req.params;
            const role = await Role.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!role) return res.status(404).json({ message: 'Role not found' });
            if (role.isSystem) {
                return res.status(403).json({ message: 'System roles cannot be deleted' });
            }

            // Staff still using this role would silently lose every permission.
            const inUse = await User.countDocuments({ staffRole: role._id });
            if (inUse > 0) {
                return res.status(409).json({
                    message: `This role is assigned to ${inUse} staff user(s). Move them to another role first.`,
                    userCount: inUse,
                });
            }

            role.isDeleted = true;
            role.deletedAt = new Date();
            role.deletedBy = req.user?.id || req.user?._id || null;
            await role.save();
            clearAccessCache();

            return res.status(200).json({
                message: 'Role deleted successfully',
                data: { id: String(role._id) },
            });
        } catch (error) {
            console.error('Error deleting role:', error);
            return res.status(500).json({ message: 'Failed to delete role' });
        }
    },
};

module.exports = roleController;
module.exports.ensureAdminRole = ensureAdminRole;
