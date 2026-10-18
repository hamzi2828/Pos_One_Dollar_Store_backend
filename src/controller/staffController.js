// src/controller/staffController.js
// Staff logins (admin panel users) + "who am I" for the admin panel.
//
// Routes (see routes/allRoutes.js):
//   GET    /admin/staff                     staff:view
//   GET    /admin/staff/:id                 staff:view
//   POST   /admin/staff                     staff:create
//   PUT    /admin/staff/:id                 staff:edit
//   POST   /admin/staff/:id/reset-password  staff:edit
//   DELETE /admin/staff/:id                 staff:delete
//   GET    /me/access                       any logged-in user
//
// Rules (shared rules live in services/staffService.js)
// - Staff users are stored in the User collection with role 'admin' (so the
//   admin panel lets them in) and a permission role (`staffRole`). They all
//   work in the one shop.
// - Super admin: isSuperAdmin = true, every permission.
// - Only a super admin can create/edit/delete a super admin or change isSuperAdmin.
// - A user with the `staff` permission who is NOT super admin:
//     * never sees or manages super admins;
//     * can only assign a role that (a) has none of the ESCALATION_KEYS
//       (staff, roles) and (b) grants nothing they don't have themselves;
//     * can only manage staff whose CURRENT role they could assign (so a
//       manager can't edit a fellow manager);
//     * cannot edit/reset/delete their own account here.
// - The last active super admin can never be demoted, deactivated or deleted.
// - Password hashes are never returned.

const User = require('../models/user');
const Role = require('../models/role');
const { clearAccessCache } = require('../middleware/access');
const { buildAllPermissions } = require('../constants/rolePermissions');
const { getMainBranchId } = require('../helper/productCodes');
const { paginate, buildRegexSearchFilter } = require('../helper/paginate');
const staffService = require('../services/staffService');

const {
  ESCALATION_KEYS,
  isValidId,
  httpError,
  plainPermissions,
  normalizeEmail,
  assertEmail,
  assertPassword,
  hashPassword,
  assertEmailFree,
  loadRole,
  roleEscalationReason,
  syncRoleUserCount,
} = staffService;

const STAFF_SORTABLE = ['createdAt', 'firstName', 'lastName', 'email', 'lastLogin'];
const SAFE_PROJECTION = { password: 0 };

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

const sendError = (res, error, fallback) => {
  if (error && error.status) return res.status(error.status).json({ message: error.message });
  if (error && error.code === 11000) return res.status(409).json({ message: 'Email already in use' });
  console.error(fallback, error);
  return res.status(500).json({ message: fallback, error: error?.message });
};

/** Same rule as middleware/access.js (old admin accounts = super admin). */
const isEffectiveSuperAdmin = (u) =>
  !!u && (!!u.isSuperAdmin || (u.role === 'admin' && !u.staffRole && !u.branch));

/** Mongo filter for "active super admins" (explicit or old admin accounts). */
const ACTIVE_SUPER_ADMIN_FILTER = {
  isActive: { $ne: false },
  $or: [
    { isSuperAdmin: true },
    { role: 'admin', staffRole: null, branch: null },
  ],
};

/** Who counts as staff (vs. a POS customer). */
const STAFF_FILTER = {
  $or: [
    { role: { $in: ['admin', 'moderator'] } },
    { isSuperAdmin: true },
    { staffRole: { $ne: null } },
  ],
};

function shapeStaff(u) {
  if (!u) return null;
  const plain = typeof u.toObject === 'function' ? u.toObject() : u;
  const role = plain.staffRole;
  return {
    id: String(plain._id),
    _id: String(plain._id),
    firstName: plain.firstName,
    lastName: plain.lastName,
    name: `${plain.firstName || ''} ${plain.lastName || ''}`.trim(),
    email: plain.email,
    phone: plain.phone || null,
    avatarUrl: plain.avatarUrl || null,
    role: plain.role,
    isSuperAdmin: isEffectiveSuperAdmin(plain),
    isActive: plain.isActive !== false,
    staffRole: role
      ? (role._id ? { id: String(role._id), name: role.name || null } : { id: String(role), name: null })
      : null,
    lastLogin: plain.lastLogin || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function countActiveSuperAdmins() {
  return User.countDocuments(ACTIVE_SUPER_ADMIN_FILTER);
}

/**
 * Load a staff user the caller is allowed to manage.
 * Throws 404 if not staff / not visible, 403 if not allowed.
 */
async function loadManageableTarget(req, id, { allowSelf = false } = {}) {
  if (!isValidId(id)) throw httpError(400, 'Invalid staff id');
  const target = await User.findOne({ _id: id, ...STAFF_FILTER });
  if (!target) throw httpError(404, 'Staff user not found');

  const access = req.access;
  const isSelf = String(target._id) === String(access.userId);
  if (access.isSuperAdmin) return { target, isSelf };

  // Non super admin (has the `staff` permission).
  if (isEffectiveSuperAdmin(target)) throw httpError(404, 'Staff user not found');
  if (isSelf && !allowSelf) throw httpError(403, 'You cannot change your own account here');
  if (target.staffRole) {
    const current = await Role.findOne({ _id: target.staffRole }).lean();
    if (roleEscalationReason(access, current)) throw httpError(403, 'You cannot manage a user whose role is above yours');
  }
  return { target, isSelf };
}

async function findPopulated(id) {
  return User.findById(id, SAFE_PROJECTION).populate('staffRole', 'name').lean();
}

/**
 * Access summary for a user (login response + /me/access).
 * { isSuperAdmin, roleName, permissions }
 */
async function buildAccessSummary(user) {
  if (!user) return { isSuperAdmin: false, roleName: null, permissions: {} };
  const isSuper = isEffectiveSuperAdmin(user);
  let role = null;
  if (user.staffRole) {
    role = await Role.findOne({ _id: idOf(user.staffRole), isDeleted: { $ne: true } }).lean();
  }
  return {
    isSuperAdmin: isSuper,
    roleName: isSuper ? 'Super Admin' : (role ? role.name : null),
    permissions: isSuper ? buildAllPermissions() : plainPermissions(role && role.permissions),
  };
}

const staffController = {
  /** GET /admin/staff?search=&isActive=&staffRole=&page=&limit=&sortBy=&sortDir= */
  list: async (req, res) => {
    try {
      const and = [STAFF_FILTER];
      if (!req.access.isSuperAdmin) and.push({ isSuperAdmin: { $ne: true } });

      const { search, isActive, staffRole } = req.query;
      if (isActive === 'true') and.push({ isActive: { $ne: false } });
      if (isActive === 'false') and.push({ isActive: false });
      if (staffRole && isValidId(staffRole)) and.push({ staffRole });
      const regex = buildRegexSearchFilter(search, ['firstName', 'lastName', 'email', 'phone']);
      if (regex) and.push(regex);

      const sortBy = STAFF_SORTABLE.includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
      const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

      const { items, pagination } = await paginate(User, {
        filter: { $and: and },
        page: req.query.page,
        limit: req.query.limit,
        sort: { [sortBy]: sortDir },
        projection: SAFE_PROJECTION,
        populate: [{ path: 'staffRole', select: 'name' }],
      });

      return res.status(200).json({ message: 'Staff fetched', data: items.map(shapeStaff), pagination });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch staff');
    }
  },

  /** GET /admin/staff/:id */
  getById: async (req, res) => {
    try {
      await loadManageableTarget(req, req.params.id, { allowSelf: true });
      const user = await findPopulated(req.params.id);
      return res.status(200).json({ message: 'Staff fetched', data: shapeStaff(user) });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch staff user');
    }
  },

  /**
   * POST /admin/staff
   * { firstName, lastName, email, password, phone?, staffRole, isActive?, isSuperAdmin? }
   */
  create: async (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.firstName || '').trim() || !String(body.lastName || '').trim() || !String(body.email || '').trim()) {
        return res.status(400).json({ message: 'firstName, lastName and email are required' });
      }
      const user = await staffService.createStaffUser(req.access, body);
      return res.status(201).json({ message: 'Staff user created', data: shapeStaff(await findPopulated(user._id)) });
    } catch (error) {
      return sendError(res, error, 'Failed to create staff user');
    }
  },

  /**
   * PUT /admin/staff/:id
   * Any of { firstName, lastName, email, phone, staffRole, isActive, isSuperAdmin }.
   * Password: use POST /admin/staff/:id/reset-password.
   */
  update: async (req, res) => {
    try {
      const access = req.access;
      const body = req.body || {};
      const { target, isSelf } = await loadManageableTarget(req, req.params.id);

      const wasSuper = isEffectiveSuperAdmin(target);
      const wasActive = target.isActive !== false;
      const oldRoleId = idOf(target.staffRole);

      // Super admin flag ------------------------------------------------------
      let willBeSuper = wasSuper;
      if (body.isSuperAdmin !== undefined) {
        willBeSuper = body.isSuperAdmin === true || body.isSuperAdmin === 'true';
        if (willBeSuper !== wasSuper && !access.isSuperAdmin) {
          throw httpError(403, 'Only the super admin can change super admin status');
        }
      }

      // Simple fields ---------------------------------------------------------
      if (body.firstName !== undefined) {
        const v = String(body.firstName).trim();
        if (!v) throw httpError(400, 'firstName cannot be empty');
        target.firstName = v;
      }
      if (body.lastName !== undefined) {
        const v = String(body.lastName).trim();
        if (!v) throw httpError(400, 'lastName cannot be empty');
        target.lastName = v;
      }
      if (body.phone !== undefined) target.phone = body.phone ? String(body.phone).trim() : null;
      if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        assertEmail(email);
        if (email !== target.email) {
          await assertEmailFree(email, target._id);
          target.email = email;
        }
      }

      // Active flag -----------------------------------------------------------
      let willBeActive = wasActive;
      if (body.isActive !== undefined) {
        willBeActive = !(body.isActive === false || body.isActive === 'false');
        if (!willBeActive && isSelf) throw httpError(400, 'You cannot deactivate your own account');
      }

      // Role ------------------------------------------------------------------
      let newRoleId = oldRoleId;
      if (body.staffRole !== undefined) {
        if (body.staffRole === null || body.staffRole === '') {
          newRoleId = null;
        } else {
          const role = await loadRole(body.staffRole);
          if (!access.isSuperAdmin) {
            const reason = roleEscalationReason(access, role);
            if (reason) throw httpError(403, reason);
          }
          newRoleId = String(role._id);
        }
      }
      if (!willBeSuper && !newRoleId) throw httpError(400, 'staffRole is required for staff');

      // Last super admin guard -------------------------------------------------
      if (wasSuper && wasActive && (!willBeSuper || !willBeActive)) {
        const n = await countActiveSuperAdmins();
        if (n <= 1) throw httpError(400, 'This is the last active super admin. Make another user super admin first.');
      }

      target.isSuperAdmin = willBeSuper;
      target.isActive = willBeActive;
      target.staffRole = newRoleId;
      // Staff belong to the shop; a super admin has no branch.
      target.branch = willBeSuper ? null : target.branch || (await getMainBranchId());
      if (target.role === 'user') target.role = 'admin';
      await target.save();

      clearAccessCache(target._id);
      if (oldRoleId !== newRoleId) await syncRoleUserCount([oldRoleId, newRoleId]);

      return res.status(200).json({ message: 'Staff user updated', data: shapeStaff(await findPopulated(target._id)) });
    } catch (error) {
      return sendError(res, error, 'Failed to update staff user');
    }
  },

  /** POST /admin/staff/:id/reset-password { password } */
  resetPassword: async (req, res) => {
    try {
      const password = typeof req.body?.password === 'string' ? req.body.password
        : (typeof req.body?.newPassword === 'string' ? req.body.newPassword : '');
      assertPassword(password);
      const { target } = await loadManageableTarget(req, req.params.id);
      target.password = await hashPassword(password);
      await target.save();
      return res.status(200).json({ message: 'Password reset', data: { id: String(target._id) } });
    } catch (error) {
      return sendError(res, error, 'Failed to reset password');
    }
  },

  /** DELETE /admin/staff/:id — soft delete. */
  remove: async (req, res) => {
    try {
      const { target, isSelf } = await loadManageableTarget(req, req.params.id);
      if (isSelf) throw httpError(400, 'You cannot delete your own account');
      if (isEffectiveSuperAdmin(target) && target.isActive !== false) {
        const n = await countActiveSuperAdmins();
        if (n <= 1) throw httpError(400, 'This is the last active super admin and cannot be deleted');
      }
      await User.softDeleteById(target._id, req.access.userId);
      clearAccessCache(target._id);
      if (target.staffRole) await syncRoleUserCount([target.staffRole]);
      return res.status(200).json({ message: 'Staff user deleted', data: { id: String(target._id) } });
    } catch (error) {
      return sendError(res, error, 'Failed to delete staff user');
    }
  },

  /**
   * GET /me/access — what the logged-in user is and can do.
   * { user, isSuperAdmin, roleName, permissions }
   */
  me: async (req, res) => {
    try {
      const user = await User.findById(req.access.userId)
        .select('firstName lastName email role isSuperAdmin staffRole branch isActive avatarUrl')
        .lean();
      if (!user) return res.status(404).json({ message: 'User not found' });
      const summary = await buildAccessSummary(user);

      return res.status(200).json({
        message: 'Access fetched',
        data: {
          user: {
            id: String(user._id),
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            avatarUrl: user.avatarUrl || null,
          },
          ...summary,
          // Same rule as loadAccess (old admin accounts count too).
          isSuperAdmin: req.access.isSuperAdmin,
        },
      });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch access');
    }
  },
};

module.exports = staffController;
// Helpers (not routes) — used by userController (login) and tests.
module.exports.buildAccessSummary = buildAccessSummary;
module.exports.isEffectiveSuperAdmin = isEffectiveSuperAdmin;
module.exports.roleEscalationReason = roleEscalationReason;
module.exports.countActiveSuperAdmins = countActiveSuperAdmins;
module.exports.ESCALATION_KEYS = ESCALATION_KEYS;
module.exports.STAFF_FILTER = STAFF_FILTER;
