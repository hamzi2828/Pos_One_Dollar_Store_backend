// src/controller/userController.js
// Staff login + the admin "Users" page (customers and staff accounts).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { clearAccessCache } = require('../middleware/access');
const { assertPassword, hashPassword } = require('../services/staffService');
// Lazy: keeps require order simple (staffController only needs models).
const staffHelpers = () => require('./staffController');

/** Staff = anyone who can open the admin panel or has a staff role. */
const isStaffAccount = (user) =>
    !!user && (user.role === 'admin' || user.role === 'moderator' || !!user.isSuperAdmin || !!user.staffRole);

/** JWT payload. `isSuperAdmin` is informational: loadAccess re-reads the DB. */
const buildTokenPayload = (user) => ({
    id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    isSuperAdmin: staffHelpers().isEffectiveSuperAdmin(user),
});

const DISABLED_MESSAGE = 'Your account is disabled. Please contact the administrator.';

const callerId = (req) => req.access?.userId || req.user?.id || req.user?._id;

/**
 * Guard for the admin user endpoints (/update/status/:id, /update/role/:id,
 * /delete/:id): staff accounts can only be changed by the super admin (normally
 * via /admin/staff), nobody disables/deletes themselves, and the last active
 * super admin can't be disabled/deleted/demoted.
 * Returns an error { status, message } or null.
 */
const guardStaffTarget = async (req, target, { disabling = false } = {}) => {
    if (!target || !isStaffAccount(target)) return null;
    if (!req.access?.isSuperAdmin) {
        return { status: 403, message: 'Staff accounts can only be changed by the super admin' };
    }
    if (disabling && String(target._id) === String(callerId(req))) {
        return { status: 400, message: 'You cannot disable or delete your own account' };
    }
    if (disabling && staffHelpers().isEffectiveSuperAdmin(target) && target.isActive !== false) {
        const n = await staffHelpers().countActiveSuperAdmins();
        if (n <= 1) return { status: 400, message: 'This is the last active super admin' };
    }
    return null;
};

const userController = {
    // POST /user/login — staff sign in to the admin panel; returns a JWT.
    loginUser: async (req, res) => {
        try {
            const { email, password } = req.body || {};
            if (!email || !password) {
                return res.status(400).json({ message: 'Email and password are required' });
            }

            const user = await User.findOne({ email: String(email).toLowerCase().trim() });
            // Customers have no password and cannot sign in.
            if (!user || !user.password || !isStaffAccount(user)) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            const match = await bcrypt.compare(String(password), user.password);
            if (!match) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Disabled accounts (staff switched off by the super admin) cannot log in.
            if (user.isActive === false) {
                return res.status(403).json({ message: DISABLED_MESSAGE });
            }

            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }
            const token = jwt.sign(buildTokenPayload(user), secret, { expiresIn: '7d' });

            user.lastLogin = new Date();
            await user.save();

            const access = await staffHelpers().buildAccessSummary(user);
            const { password: _pw, ...safe } = user.toObject();
            return res.status(200).json({ message: 'Login successful', token, data: safe, access });
        } catch (error) {
            res.status(500).json({ message: 'Error during login', error: error.message });
        }
    },

    // GET /get/allUsers — admin users page.
    getAllUsers: async (req, res) => {
        try {
            // Opt-in server-side pagination: when any of page/limit/search/status/role/sortBy are present,
            // return a paginated response. Otherwise keep the all-at-once behaviour (the admin
            // users page paginates client-side).
            const paginated = ['page', 'limit', 'search', 'status', 'role', 'sortBy', 'sortOrder']
                .some((k) => Object.prototype.hasOwnProperty.call(req.query, k));

            const filter = {};
            if (req.query.status === 'active')   filter.isActive = true;
            if (req.query.status === 'inactive') filter.isActive = false;
            if (req.query.role && ['user', 'admin', 'moderator'].includes(req.query.role)) filter.role = req.query.role;

            if (req.query.search) {
                const s = String(req.query.search).trim();
                if (s.length >= 3) {
                    filter.$text = { $search: s };
                } else if (s) {
                    const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }];
                }
            }

            // Keep password excluded at the DB layer — no need to map/clone per row.
            const projection = { password: 0 };

            if (!paginated) {
                const users = await User.find(filter, projection).lean();
                return res.status(200).json({
                    message: 'Users details retrieved successfully',
                    data: users,
                });
            }

            const pageNum  = Math.max(1, parseInt(req.query.page) || 1);
            const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
            const skip     = (pageNum - 1) * limitNum;

            const validSortKeys = new Set(['createdAt', 'lastLogin', 'firstName', 'lastName', 'email', 'isActive']);
            const sortKey = validSortKeys.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
            const sortDir = req.query.sortOrder === 'asc' ? 1 : -1;

            const [users, total] = await Promise.all([
                User.find(filter, projection)
                    .sort({ [sortKey]: sortDir })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                User.countDocuments(filter),
            ]);

            return res.status(200).json({
                message: 'Users details retrieved successfully',
                data: users,
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.max(1, Math.ceil(total / limitNum)),
                    hasNextPage: pageNum * limitNum < total,
                    hasPreviousPage: pageNum > 1,
                },
            });
        } catch (error) {
            console.error('Get user details error:', error);
            res.status(400).json({
                message: 'Error getting user details',
                error: error.message
            });
        }
    },

    // PUT /update/status/:id - Update a user's active status by ID
    updateUserStatusById: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;
            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            const blocked = await guardStaffTarget(req, target, { disabling: isActive === false });
            if (blocked) return res.status(blocked.status).json({ message: blocked.message });

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { isActive } },
                { new: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

            clearAccessCache(id);
            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Status updated successfully', data: safe });
        } catch (error) {
            console.error('Update user status error:', error);
            return res.status(400).json({ message: 'Error updating user status', error: error.message });
        }
    },

    // PUT /update/role/:id - Update a user's role by ID
    updateUserRoleById: async (req, res) => {
        try {
            const { id } = req.params;
            const { role } = req.body;
            const allowed = ['user', 'admin', 'moderator'];
            if (!allowed.includes(role)) {
                return res.status(400).json({ message: `role must be one of: ${allowed.join(', ')}` });
            }

            // Taking 'admin' away from the last super admin would lock everyone out.
            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            if (role !== 'admin' && target.role === 'admin') {
                const blocked = await guardStaffTarget(req, target, { disabling: true });
                if (blocked) return res.status(blocked.status).json({ message: blocked.message });
            }

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { role } },
                { new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

            clearAccessCache(id);
            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Role updated successfully', data: safe });
        } catch (error) {
            console.error('Update user role error:', error);
            return res.status(400).json({ message: 'Error updating user role', error: error.message });
        }
    },

    // DELETE /delete/:id - Delete a user by ID
    deleteUserById: async (req, res) => {
        try {
            const { id } = req.params;
            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            const blocked = await guardStaffTarget(req, target, { disabling: true });
            if (blocked) return res.status(blocked.status).json({ message: blocked.message });

            const deleted = await User.softDeleteById(id, callerId(req) || null);
            clearAccessCache(id);
            if (!deleted) {
                return res.status(404).json({ message: 'User not found' });
            }

            return res.status(200).json({ message: 'User deleted successfully', id });
        } catch (error) {
            console.error('Delete user error:', error);
            return res.status(400).json({ message: 'Error deleting user', error: error.message });
        }
    },

    // PUT /user/change-password — the logged-in user sets a new password.
    changePassword: async (req, res) => {
        try {
            const { newPassword } = req.body || {};
            try {
                assertPassword(newPassword);
            } catch (err) {
                return res.status(400).json({ message: err.message });
            }

            const user = await User.findById(callerId(req));
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            user.password = await hashPassword(newPassword);
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Password changed successfully'
            });
        } catch (error) {
            console.error('Change password error:', error);
            return res.status(400).json({ message: 'Error changing password', error: error.message });
        }
    },
};

module.exports = userController;
