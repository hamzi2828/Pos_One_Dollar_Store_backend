// src/middleware/access.js
// Who is calling and what they may do. DOLLAR & Co is ONE shop: every record
// belongs to the main branch (models/branch.js -> Branch.getMain()).
//
// Use AFTER `auth` (which only verifies the JWT):
//   router.get('/x', auth, loadAccess, requirePermission('products', 'view'), handler)
//
// req.access = {
//   userId, isSuperAdmin, roleName,
//   branchId, userBranchId,  // both = the shop (main branch id) for every user
//   permissions,             // { products: ['view','create'], ... }
//   can(key, action)
// }
//
// Helpers kept for the store modules (they stamp records with the shop's branch):
//   branchFilter(req)        -> {} (one shop = every record)
//   resolveWriteBranch(req)  -> the shop's branch id

const User = require('../models/user');
const Role = require('../models/role');
const { getMainBranchId } = require('../helper/productCodes');

const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { at, data }

const clearAccessCache = (userId) => {
  if (userId) cache.delete(String(userId));
  else cache.clear();
};

const toPlainPermissions = (perms) => {
  if (!perms) return {};
  if (perms instanceof Map) return Object.fromEntries(perms);
  return { ...perms };
};

async function loadUserAccess(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const user = await User.findById(userId)
    .select('role isSuperAdmin staffRole branch isActive firstName lastName email')
    .lean();
  if (!user) return null;

  let permissions = {};
  let roleName = null;
  if (user.staffRole) {
    const role = await Role.findOne({ _id: user.staffRole, isDeleted: { $ne: true } }).lean();
    if (role) {
      permissions = toPlainPermissions(role.permissions);
      roleName = role.name;
    }
  }

  // Old admin accounts (role 'admin', no staff role, no shop) are super admins.
  const legacyAdmin = user.role === 'admin' && !user.staffRole && !user.branch;
  const data = {
    user,
    isSuperAdmin: !!user.isSuperAdmin || legacyAdmin,
    permissions,
    roleName,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function loadAccess(req, res, next) {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Authorization token required' });

    const info = await loadUserAccess(userId);
    if (!info) return res.status(401).json({ message: 'User not found' });
    if (info.user.isActive === false) return res.status(403).json({ message: 'Account is disabled' });

    const shopId = await getMainBranchId();
    req.access = {
      userId: String(userId),
      isSuperAdmin: info.isSuperAdmin,
      roleName: info.isSuperAdmin ? 'Super Admin' : info.roleName,
      userBranchId: shopId,
      branchId: shopId,
      permissions: info.permissions,
      can(key, action = 'view') {
        if (this.isSuperAdmin) return true;
        const list = this.permissions[key];
        return Array.isArray(list) && list.includes(action);
      },
    };
    return next();
  } catch (err) {
    console.error('loadAccess error:', err);
    return res.status(500).json({ message: 'Could not load access', error: err.message });
  }
}

// Middleware factory: needs req.access (loadAccess). Accepts one key or a list
// (any one of them is enough), e.g. requirePermission(['pos', 'pos_orders'], 'view').
const requirePermission = (keys, action = 'view') => {
  const list = Array.isArray(keys) ? keys : [keys];
  return (req, res, next) => {
    if (!req.access) return res.status(500).json({ message: 'Access not loaded' });
    if (list.some((k) => req.access.can(k, action))) return next();
    return res.status(403).json({
      message: 'You do not have permission for this action',
      required: { keys: list, action },
    });
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (req.access?.isSuperAdmin) return next();
  return res.status(403).json({ message: 'Only the super admin can do this' });
};

// One shop: lists are never filtered by branch.
const branchFilter = () => ({});

// The shop's branch id (stamped on new records / used by the stock engine).
const resolveWriteBranch = async (req) => req?.access?.branchId || getMainBranchId();

module.exports = {
  loadAccess,
  requirePermission,
  requireSuperAdmin,
  branchFilter,
  resolveWriteBranch,
  clearAccessCache,
  loadUserAccess,
};
