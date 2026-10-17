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
// Rules
// - Staff users are stored in the User collection with role 'admin' (so the
//   admin panel lets them in), a permission role (`staffRole`) and a `branch`.
// - Super admin: isSuperAdmin = true, no branch (works on every branch).
// - Only a super admin can create/edit/delete a super admin or change isSuperAdmin.
// - A user with the `staff` permission who is NOT super admin:
//     * only sees/manages staff of their own branch (and never super admins);
//     * cannot create staff in another branch or move staff to another branch;
//     * can only assign a role that (a) has none of the ESCALATION_KEYS
//       (staff, branches, roles) and (b) grants nothing they don't have
//       themselves -> no privilege escalation;
//     * can only manage staff whose CURRENT role they could assign (so a branch
//       manager can't edit a fellow manager);
//     * cannot edit/reset/delete their own account here (use the profile page).
// - The last active super admin can never be demoted, deactivated or deleted.
// - Password hashes are never returned.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Role = require('../models/role');
const Branch = require('../models/branch');
const { clearAccessCache } = require('../middleware/access');
const { buildAllPermissions } = require('../constants/rolePermissions');
const { paginate, buildRegexSearchFilter } = require('../helper/paginate');

const MIN_PASSWORD = 8;
const ESCALATION_KEYS = ['staff', 'branches', 'roles'];
const STAFF_SORTABLE = ['createdAt', 'firstName', 'lastName', 'email', 'lastLogin'];
const SAFE_PROJECTION = { password: 0, addresses: 0, cars: 0, carDetails: 0 };

const isValidId = (id) => !!id && mongoose.Types.ObjectId.isValid(String(id));
const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

const httpError = (status, message, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
};

const sendError = (res, error, fallback) => {
  if (error && error.status) {
    const body = { message: error.message };
    if (error.details) body.details = error.details;
    return res.status(error.status).json(body);
  }
  if (error && error.code === 11000) return res.status(409).json({ message: 'Email already in use' });
  console.error(fallback, error);
  return res.status(500).json({ message: fallback, error: error?.message });
};

const plainPermissions = (perms) => {
  if (!perms) return {};
  if (perms instanceof Map) return Object.fromEntries(perms);
  if (typeof perms.toObject === 'function') return perms.toObject();
  return { ...perms };
};

/** Same rule as middleware/access.js (legacy admins = super admin until migrated). */
const isEffectiveSuperAdmin = (u) =>
  !!u && (!!u.isSuperAdmin || (u.role === 'admin' && !u.staffRole && !u.branch));

/** Mongo filter for "active super admins" (explicit or legacy). */
const ACTIVE_SUPER_ADMIN_FILTER = {
  isActive: { $ne: false },
  $or: [
    { isSuperAdmin: true },
    { role: 'admin', staffRole: null, branch: null },
  ],
};

/** Who counts as staff (vs. a website/POS customer). */
const STAFF_FILTER = {
  $or: [
    { role: { $in: ['admin', 'moderator'] } },
    { isSuperAdmin: true },
    { staffRole: { $ne: null } },
  ],
};

function shapeBranch(b) {
  if (!b) return null;
  if (!b._id) return { id: String(b), name: null, code: null };
  return { id: String(b._id), name: b.name || null, code: b.code || null };
}

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
    branch: shapeBranch(plain.branch),
    lastLogin: plain.lastLogin || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function loadRole(roleId) {
  if (!isValidId(roleId)) throw httpError(400, 'Invalid staffRole');
  const role = await Role.findOne({ _id: roleId, isDeleted: { $ne: true } }).lean();
  if (!role) throw httpError(400, 'Role not found');
  return role;
}

async function loadBranch(branchId) {
  if (!isValidId(branchId)) throw httpError(400, 'Invalid branch');
  const branch = await Branch.findById(branchId).lean();
  if (!branch) throw httpError(400, 'Branch not found');
  if (branch.isActive === false) throw httpError(400, 'Branch is inactive');
  return branch;
}

/**
 * Can `access` (req.access of a NON super admin) hand out `role`?
 * Returns null if yes, otherwise the reason.
 */
function roleEscalationReason(access, role) {
  if (!role) return null;
  const perms = plainPermissions(role.permissions);
  const bad = ESCALATION_KEYS.filter((k) => Array.isArray(perms[k]) && perms[k].length);
  if (bad.length) return `Only the super admin can assign a role with ${bad.join(', ')} permission`;
  if (role.isSystem) return 'Only the super admin can assign the system Admin role';
  const mine = access.permissions || {};
  for (const [key, actions] of Object.entries(perms)) {
    for (const a of actions || []) {
      if (!(Array.isArray(mine[key]) && mine[key].includes(a))) {
        return `You cannot assign a role with permission ${key}:${a} that you don't have`;
      }
    }
  }
  return null;
}

async function countActiveSuperAdmins() {
  return User.countDocuments(ACTIVE_SUPER_ADMIN_FILTER);
}

/** Keep Role.userCount in sync (best effort). */
async function syncRoleUserCount(roleIds) {
  const ids = [...new Set((roleIds || []).filter(Boolean).map(String))];
  await Promise.all(ids.map(async (id) => {
    try {
      const n = await User.countDocuments({ staffRole: id });
      await Role.updateOne({ _id: id }, { $set: { userCount: n } });
    } catch (err) {
      console.error('syncRoleUserCount failed:', err.message);
    }
  }));
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
  if (!access.userBranchId || idOf(target.branch) !== String(access.userBranchId)) {
    throw httpError(404, 'Staff user not found');
  }
  if (isSelf && !allowSelf) throw httpError(403, 'You cannot change your own account here');
  if (target.staffRole) {
    const current = await Role.findOne({ _id: target.staffRole }).lean();
    const reason = roleEscalationReason(access, current);
    if (reason) throw httpError(403, 'You cannot manage a user whose role is above yours');
  }
  return { target, isSelf };
}

async function findPopulated(id) {
  return User.findById(id, SAFE_PROJECTION)
    .populate('staffRole', 'name')
    .populate('branch', 'name code')
    .lean();
}

/**
 * Access summary for a user (login response + /me/access).
 * { isSuperAdmin, roleName, branch: {id,name,code}|null, permissions }
 */
async function buildAccessSummary(user) {
  if (!user) return { isSuperAdmin: false, roleName: null, branch: null, permissions: {} };
  const isSuper = isEffectiveSuperAdmin(user);
  let role = null;
  if (user.staffRole) {
    role = await Role.findOne({ _id: idOf(user.staffRole), isDeleted: { $ne: true } }).lean();
  }
  let branch = null;
  if (user.branch) {
    const b = user.branch._id && user.branch.name
      ? user.branch
      : await Branch.findById(idOf(user.branch)).select('name code isActive').lean();
    branch = b ? shapeBranch(b) : null;
  }
  return {
    isSuperAdmin: isSuper,
    roleName: isSuper ? 'Super Admin' : (role ? role.name : null),
    branch,
    permissions: isSuper ? buildAllPermissions() : plainPermissions(role && role.permissions),
  };
}

const staffController = {
  /** GET /admin/staff?search=&isActive=&staffRole=&page=&limit=&sortBy=&sortDir= */
  list: async (req, res) => {
    try {
      const access = req.access;
      const and = [STAFF_FILTER];

      if (access.isSuperAdmin) {
        if (access.branchId) and.push({ branch: new mongoose.Types.ObjectId(access.branchId) });
      } else {
        if (!access.userBranchId) {
          return res.status(200).json({ message: 'Staff fetched', data: [], pagination: { page: 1, limit: 0, total: 0, totalPages: 0, hasNext: false, hasPrev: false } });
        }
        and.push({ branch: new mongoose.Types.ObjectId(access.userBranchId) });
        and.push({ isSuperAdmin: { $ne: true } });
      }

      const { search, isActive, staffRole } = req.query;
      if (isActive === 'true') and.push({ isActive: { $ne: false } });
      if (isActive === 'false') and.push({ isActive: false });
      if (staffRole && isValidId(staffRole)) and.push({ staffRole: new mongoose.Types.ObjectId(staffRole) });
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
        populate: [
          { path: 'staffRole', select: 'name' },
          { path: 'branch', select: 'name code' },
        ],
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
   * { firstName, lastName, email, password, phone?, staffRole, branch, isActive?, isSuperAdmin? }
   */
  create: async (req, res) => {
    try {
      const access = req.access;
      const body = req.body || {};
      const firstName = String(body.firstName || '').trim();
      const lastName = String(body.lastName || '').trim();
      const email = String(body.email || '').toLowerCase().trim();
      const password = typeof body.password === 'string' ? body.password : '';
      const makeSuper = body.isSuperAdmin === true || body.isSuperAdmin === 'true';

      if (!firstName || !lastName || !email) {
        return res.status(400).json({ message: 'firstName, lastName and email are required' });
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Invalid email' });
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters` });
      }
      if (makeSuper && !access.isSuperAdmin) {
        return res.status(403).json({ message: 'Only the super admin can create a super admin' });
      }

      let role = null;
      let branchId = null;
      if (!makeSuper) {
        if (!body.staffRole) return res.status(400).json({ message: 'staffRole is required' });
        role = await loadRole(body.staffRole);

        let wanted = body.branch || null;
        if (!access.isSuperAdmin) {
          if (!access.userBranchId) throw httpError(403, 'Your account is not assigned to a branch');
          if (wanted && String(wanted) !== String(access.userBranchId)) {
            throw httpError(403, 'You can only add staff to your own branch');
          }
          wanted = access.userBranchId;
          const reason = roleEscalationReason(access, role);
          if (reason) throw httpError(403, reason);
        }
        if (!wanted) return res.status(400).json({ message: 'branch is required' });
        branchId = String((await loadBranch(wanted))._id);
      } else if (body.staffRole) {
        role = await loadRole(body.staffRole); // optional, informational for a super admin
      }

      const existing = await User.findOne({ email }).setOptions({ withDeleted: true }).select('_id isDeleted').lean();
      if (existing) {
        return res.status(409).json({
          message: existing.isDeleted ? 'Email belongs to a deleted account' : 'Email already in use',
        });
      }

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password, salt);

      const user = await User.create({
        firstName,
        lastName,
        email,
        password: hashed,
        provider: 'local',
        phone: body.phone ? String(body.phone).trim() : null,
        role: 'admin',
        isSuperAdmin: makeSuper,
        staffRole: role ? role._id : null,
        branch: makeSuper ? null : branchId,
        isActive: body.isActive === false || body.isActive === 'false' ? false : true,
      });

      if (role) await syncRoleUserCount([role._id]);
      const fresh = await findPopulated(user._id);
      return res.status(201).json({ message: 'Staff user created', data: shapeStaff(fresh) });
    } catch (error) {
      return sendError(res, error, 'Failed to create staff user');
    }
  },

  /**
   * PUT /admin/staff/:id
   * Any of { firstName, lastName, email, phone, staffRole, branch, isActive, isSuperAdmin }.
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
        const email = String(body.email).toLowerCase().trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Invalid email');
        if (email !== target.email) {
          const dup = await User.findOne({ email, _id: { $ne: target._id } })
            .setOptions({ withDeleted: true }).select('_id').lean();
          if (dup) throw httpError(409, 'Email already in use');
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

      // Branch ----------------------------------------------------------------
      let newBranchId = idOf(target.branch);
      if (body.branch !== undefined) {
        const wanted = body.branch === '' ? null : body.branch;
        if (!access.isSuperAdmin) {
          if (String(wanted || '') !== String(access.userBranchId)) {
            throw httpError(403, 'You cannot move staff to another branch');
          }
        } else if (wanted) {
          newBranchId = String((await loadBranch(wanted))._id);
        } else {
          newBranchId = null;
        }
      }

      if (willBeSuper) {
        newBranchId = null; // super admin works on every branch
      } else {
        if (!newRoleId) throw httpError(400, 'staffRole is required for branch staff');
        if (!newBranchId) throw httpError(400, 'branch is required for branch staff');
      }

      // Last super admin guard -------------------------------------------------
      if (wasSuper && wasActive && (!willBeSuper || !willBeActive)) {
        const n = await countActiveSuperAdmins();
        if (n <= 1) throw httpError(400, 'This is the last active super admin. Make another user super admin first.');
      }

      target.isSuperAdmin = willBeSuper;
      target.isActive = willBeActive;
      target.staffRole = newRoleId;
      target.branch = newBranchId;
      if (target.role === 'user') target.role = 'admin';
      await target.save();

      clearAccessCache(target._id);
      if (oldRoleId !== newRoleId) await syncRoleUserCount([oldRoleId, newRoleId]);

      const fresh = await findPopulated(target._id);
      return res.status(200).json({ message: 'Staff user updated', data: shapeStaff(fresh) });
    } catch (error) {
      return sendError(res, error, 'Failed to update staff user');
    }
  },

  /** POST /admin/staff/:id/reset-password { password } */
  resetPassword: async (req, res) => {
    try {
      const password = typeof req.body?.password === 'string' ? req.body.password
        : (typeof req.body?.newPassword === 'string' ? req.body.newPassword : '');
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters` });
      }
      const { target } = await loadManageableTarget(req, req.params.id);
      const salt = await bcrypt.genSalt(10);
      target.password = await bcrypt.hash(password, salt);
      if (!target.provider) target.provider = 'local';
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
   * { user, isSuperAdmin, roleName, branch, currentBranchId, permissions, branches }
   * branches = branches the user can switch to (super admin: all active; staff: own).
   */
  me: async (req, res) => {
    try {
      const access = req.access;
      const user = await User.findById(access.userId)
        .select('firstName lastName email role isSuperAdmin staffRole branch isActive avatarUrl')
        .lean();
      if (!user) return res.status(404).json({ message: 'User not found' });
      const summary = await buildAccessSummary(user);

      let branches = [];
      if (access.isSuperAdmin) {
        branches = await Branch.find({ isActive: { $ne: false } })
          .select('name code isMain isActive')
          .sort({ isMain: -1, name: 1 })
          .lean();
      } else if (access.userBranchId) {
        const own = await Branch.findById(access.userBranchId).select('name code isMain isActive').lean();
        branches = own ? [own] : [];
      }

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
          // Super admin: legacy admins count too (same rule as loadAccess).
          isSuperAdmin: access.isSuperAdmin,
          currentBranchId: access.branchId || null,
          branches: branches.map((b) => ({
            id: String(b._id),
            name: b.name,
            code: b.code,
            isMain: !!b.isMain,
          })),
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
