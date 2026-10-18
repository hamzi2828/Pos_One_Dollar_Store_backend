// src/services/staffService.js
// Staff logins: a User with role 'admin' (opens the admin panel) and a
// permission Role (`staffRole`). Shared by /admin/staff (staffController) and
// "create a login for an employee" (services/hr/employeeService.js), so both
// follow the same rules:
// - password at least MIN_PASSWORD characters, stored as a bcrypt hash;
// - e-mail unique (deleted accounts included);
// - only a super admin can create a super admin;
// - a non-super-admin can only hand out a role without ESCALATION_KEYS that
//   grants nothing they don't have themselves (no privilege escalation).

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Role = require('../models/role');
const { getMainBranchId } = require('../helper/productCodes');
const { sanitizePermissions } = require('../constants/rolePermissions');

const MIN_PASSWORD = 8;
const ESCALATION_KEYS = ['staff', 'roles'];
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const isValidId = (id) => !!id && mongoose.Types.ObjectId.isValid(String(id));

const httpError = (status, message) => Object.assign(new Error(message), { status });

const plainPermissions = (perms) => {
  if (!perms) return {};
  if (perms instanceof Map) return Object.fromEntries(perms);
  if (typeof perms.toObject === 'function') return perms.toObject();
  return { ...perms };
};

const normalizeEmail = (email) => String(email || '').toLowerCase().trim();

function assertEmail(email) {
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Invalid email');
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}

/** 409 when the e-mail is used by any account (deleted ones included). */
async function assertEmailFree(email, exceptUserId = null) {
  const filter = { email, ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) };
  const existing = await User.findOne(filter).setOptions({ withDeleted: true }).select('_id isDeleted').lean();
  if (existing) throw httpError(409, existing.isDeleted ? 'Email belongs to a deleted account' : 'Email already in use');
}

async function loadRole(roleId) {
  if (!isValidId(roleId)) throw httpError(400, 'Invalid staffRole');
  const role = await Role.findOne({ _id: roleId, isDeleted: { $ne: true } }).lean();
  if (!role) throw httpError(400, 'Role not found');
  return role;
}

/**
 * Can `access` (req.access of a NON super admin) hand out `role`?
 * Returns null if yes, otherwise the reason.
 */
function roleEscalationReason(access, role) {
  if (!role) return null;
  // Only catalogue keys count — stale keys left on old roles (e.g. a removed
  // report) must not block assigning the role.
  const perms = sanitizePermissions(plainPermissions(role.permissions));
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

/** Keep Role.userCount in sync (best effort). */
async function syncRoleUserCount(roleIds) {
  const ids = [...new Set((roleIds || []).filter(Boolean).map(String))];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const n = await User.countDocuments({ staffRole: id });
        await Role.updateOne({ _id: id }, { $set: { userCount: n } });
      } catch (err) {
        console.error('syncRoleUserCount failed:', err.message);
      }
    })
  );
}

/**
 * Create a staff login. `access` = req.access of the caller.
 * input: { firstName, lastName?, email, password, phone?, staffRole, isActive?, isSuperAdmin? }
 * Throws err.status 400 / 403 / 409. Returns the new User document.
 */
async function createStaffUser(access, input = {}) {
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const email = normalizeEmail(input.email);
  const makeSuper = input.isSuperAdmin === true || input.isSuperAdmin === 'true';

  if (!firstName) throw httpError(400, 'firstName is required');
  if (!email) throw httpError(400, 'email is required');
  assertEmail(email);
  assertPassword(input.password);
  if (makeSuper && !access.isSuperAdmin) throw httpError(403, 'Only the super admin can create a super admin');

  let role = null;
  if (!makeSuper) {
    if (!input.staffRole) throw httpError(400, 'staffRole is required');
    role = await loadRole(input.staffRole);
    if (!access.isSuperAdmin) {
      const reason = roleEscalationReason(access, role);
      if (reason) throw httpError(403, reason);
    }
  } else if (input.staffRole) {
    role = await loadRole(input.staffRole); // optional, informational for a super admin
  }

  await assertEmailFree(email);

  let user;
  try {
    user = await User.create({
      firstName,
      lastName,
      email,
      password: await hashPassword(input.password),
      phone: input.phone ? String(input.phone).trim() : null,
      role: 'admin',
      isSuperAdmin: makeSuper,
      staffRole: role ? role._id : null,
      // Staff belong to the shop; a super admin has no branch.
      branch: makeSuper ? null : await getMainBranchId(),
      isActive: !(input.isActive === false || input.isActive === 'false'),
    });
  } catch (err) {
    if (err && err.code === 11000) throw httpError(409, 'Email already in use');
    throw err;
  }

  if (role) await syncRoleUserCount([role._id]);
  return user;
}

module.exports = {
  MIN_PASSWORD,
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
  createStaffUser,
};
