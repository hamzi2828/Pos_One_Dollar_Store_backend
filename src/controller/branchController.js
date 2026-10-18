// src/controller/branchController.js
// Shop branches (Branch 1, Branch 2...). Products are shared; every branch has
// its own stock, sales, staff.
//
// Routes (see routes/allRoutes.js):
//   GET    /admin/branches               any logged-in staff (see visibility below)
//   GET    /admin/branches/:id           same visibility
//   POST   /admin/branches               super admin
//   PUT    /admin/branches/:id           super admin
//   DELETE /admin/branches/:id           super admin (soft delete; refused for the main
//                                        branch or when the branch still has stock/staff)
//   POST   /admin/branches/:id/set-main  super admin
//
// Visibility for GET:
//   super admin                                   -> every branch (also inactive)
//   permission branches:view or stock_transfers:* -> every ACTIVE branch (to pick a
//                                                    transfer destination)
//   other staff                                   -> only their own branch

const mongoose = require('mongoose');
const Branch = require('../models/branch');
const User = require('../models/user');
const Product = require('../models/product');
const { clearAccessCache } = require('../middleware/access');
const { escapeRegex } = require('../helper/paginate');

// The main branch id is cached by productCodes / branchScope helpers: reset
// both whenever the main branch changes.
function clearMainBranchCaches() {
  try {
    const scope = require('../helper/branchScope');
    if (typeof scope.clearMainBranchCache === 'function') return scope.clearMainBranchCache();
  } catch (_) { /* helper not present */ }
  try {
    const codes = require('../helper/productCodes');
    if (typeof codes.clearMainBranchCache === 'function') codes.clearMainBranchCache();
  } catch (_) { /* helper not present */ }
  return undefined;
}

const isValidId = (id) => !!id && mongoose.Types.ObjectId.isValid(String(id));

const shape = (b, extra = {}) => ({
  id: String(b._id),
  _id: String(b._id),
  name: b.name,
  code: b.code,
  address: b.address || '',
  phone: b.phone || '',
  isActive: b.isActive !== false,
  isMain: !!b.isMain,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  ...extra,
});

const canSeeAll = (access) =>
  !!access && (access.isSuperAdmin
    || access.can('branches', 'view')
    || access.can('stock_transfers', 'view')
    || access.can('stock_transfers', 'create'));

const normCode = (v) => String(v || '').trim().toUpperCase();

async function codeTaken(code, exceptId) {
  const filter = { code };
  if (exceptId) filter._id = { $ne: exceptId };
  return Branch.findOne(filter).setOptions({ withDeleted: true }).select('_id isDeleted').lean();
}

/** True if any product still holds pieces in this branch. */
async function branchHasStock(branchId) {
  const id = new mongoose.Types.ObjectId(String(branchId));
  const has = await Product.exists({
    $or: [
      { branchStock: { $elemMatch: { branch: id, stock: { $gt: 0 } } } },
      { 'variants.branchStock': { $elemMatch: { branch: id, stock: { $gt: 0 } } } },
      { batches: { $elemMatch: { branch: id, quantity: { $gt: 0 } } } },
      { 'variants.batches': { $elemMatch: { branch: id, quantity: { $gt: 0 } } } },
    ],
  });
  return !!has;
}

const branchController = {
  /** GET /admin/branches?search=&isActive= */
  list: async (req, res) => {
    try {
      const access = req.access;
      const filter = {};
      if (access.isSuperAdmin) {
        if (req.query.isActive === 'true') filter.isActive = { $ne: false };
        if (req.query.isActive === 'false') filter.isActive = false;
      } else if (canSeeAll(access)) {
        filter.isActive = { $ne: false };
      } else {
        if (!access.userBranchId) return res.status(200).json({ message: 'Branches fetched', data: [] });
        filter._id = new mongoose.Types.ObjectId(access.userBranchId);
      }
      const term = String(req.query.search || '').trim();
      if (term) {
        const rx = new RegExp(escapeRegex(term), 'i');
        filter.$or = [{ name: rx }, { code: rx }];
      }

      const branches = await Branch.find(filter).sort({ isMain: -1, name: 1 }).lean();

      // Staff counts are extra info for the Branches screen: never let them
      // break the list (pickers like the stock transfer form need the branches).
      let counts = {};
      if (access.isSuperAdmin && branches.length) {
        try {
          const rows = await User.aggregate([
            { $match: { branch: { $in: branches.map((b) => b._id) } } },
            { $group: { _id: '$branch', count: { $sum: 1 } } },
          ]);
          counts = rows.reduce((acc, r) => { acc[String(r._id)] = r.count; return acc; }, {});
        } catch (countErr) {
          console.error('Branch staff counts failed:', countErr.message);
        }
      }

      const data = branches.map((b) => shape(b, access.isSuperAdmin ? { staffCount: counts[String(b._id)] || 0 } : {}));
      return res.status(200).json({ message: 'Branches fetched', data });
    } catch (error) {
      console.error('List branches error:', error);
      return res.status(500).json({ message: 'Failed to fetch branches', error: error.message });
    }
  },

  /** GET /admin/branches/:id */
  getById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: 'Invalid branch id' });
      const access = req.access;
      const branch = await Branch.findById(id).lean();
      if (!branch) return res.status(404).json({ message: 'Branch not found' });

      const own = access.userBranchId && String(access.userBranchId) === String(branch._id);
      const visible = access.isSuperAdmin || own || (canSeeAll(access) && branch.isActive !== false);
      if (!visible) return res.status(404).json({ message: 'Branch not found' });

      const extra = {};
      if (access.isSuperAdmin) extra.staffCount = await User.countDocuments({ branch: branch._id });
      return res.status(200).json({ message: 'Branch fetched', data: shape(branch, extra) });
    } catch (error) {
      console.error('Get branch error:', error);
      return res.status(500).json({ message: 'Failed to fetch branch', error: error.message });
    }
  },

  /** POST /admin/branches { name, code, address?, phone?, isActive?, isMain? } */
  create: async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const code = normCode(body.code);
      if (!name) return res.status(400).json({ message: 'Branch name is required' });
      if (!code) return res.status(400).json({ message: 'Branch code is required (e.g. B2)' });
      if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
        return res.status(400).json({ message: 'Branch code may only use letters, numbers, - and _ (max 20)' });
      }
      const dup = await codeTaken(code);
      if (dup) return res.status(409).json({ message: `Branch code ${code} is already used` });

      const isFirst = (await Branch.countDocuments({})) === 0;
      const makeMain = isFirst || body.isMain === true || body.isMain === 'true';
      const isActive = !(body.isActive === false || body.isActive === 'false');
      if (makeMain && !isActive) return res.status(400).json({ message: 'The main branch must be active' });

      const branch = await Branch.create({
        name,
        code,
        address: body.address ? String(body.address).trim() : '',
        phone: body.phone ? String(body.phone).trim() : '',
        isActive,
        isMain: false,
      });
      if (makeMain) {
        await Branch.updateMany({ _id: { $ne: branch._id }, isMain: true }, { $set: { isMain: false } });
        branch.isMain = true;
        await branch.save();
        clearMainBranchCaches();
      }
      return res.status(201).json({ message: 'Branch created', data: shape(branch.toObject()) });
    } catch (error) {
      if (error && error.code === 11000) return res.status(409).json({ message: 'Branch code is already used' });
      console.error('Create branch error:', error);
      return res.status(500).json({ message: 'Failed to create branch', error: error.message });
    }
  },

  /** PUT /admin/branches/:id { name?, code?, address?, phone?, isActive? } (isMain: use set-main) */
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: 'Invalid branch id' });
      const body = req.body || {};
      const branch = await Branch.findById(id);
      if (!branch) return res.status(404).json({ message: 'Branch not found' });

      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ message: 'Branch name cannot be empty' });
        branch.name = name;
      }
      if (body.code !== undefined) {
        const code = normCode(body.code);
        if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
          return res.status(400).json({ message: 'Branch code may only use letters, numbers, - and _ (max 20)' });
        }
        if (code !== branch.code) {
          const dup = await codeTaken(code, branch._id);
          if (dup) return res.status(409).json({ message: `Branch code ${code} is already used` });
          branch.code = code;
        }
      }
      if (body.address !== undefined) branch.address = body.address ? String(body.address).trim() : '';
      if (body.phone !== undefined) branch.phone = body.phone ? String(body.phone).trim() : '';
      let activeChanged = false;
      if (body.isActive !== undefined) {
        const isActive = !(body.isActive === false || body.isActive === 'false');
        if (!isActive && branch.isMain) {
          return res.status(400).json({ message: 'The main branch cannot be deactivated. Make another branch main first.' });
        }
        activeChanged = isActive !== (branch.isActive !== false);
        branch.isActive = isActive;
      }
      await branch.save();
      if (activeChanged) clearAccessCache();

      return res.status(200).json({ message: 'Branch updated', data: shape(branch.toObject()) });
    } catch (error) {
      if (error && error.code === 11000) return res.status(409).json({ message: 'Branch code is already used' });
      console.error('Update branch error:', error);
      return res.status(500).json({ message: 'Failed to update branch', error: error.message });
    }
  },

  /** DELETE /admin/branches/:id — soft delete. */
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: 'Invalid branch id' });
      const branch = await Branch.findById(id);
      if (!branch) return res.status(404).json({ message: 'Branch not found' });
      if (branch.isMain) {
        return res.status(400).json({ message: 'The main branch cannot be deleted. Make another branch main first.' });
      }
      const staff = await User.countDocuments({ branch: branch._id });
      if (staff > 0) {
        return res.status(409).json({ message: `This branch still has ${staff} staff user(s). Move or delete them first.`, staffCount: staff });
      }
      if (await branchHasStock(branch._id)) {
        return res.status(409).json({ message: 'This branch still has stock. Transfer it to another branch first.' });
      }

      // Free the code so it can be reused by a new branch.
      const originalCode = branch.code;
      branch.code = `${originalCode}-DEL-${Date.now().toString(36)}`.toUpperCase();
      branch.isActive = false;
      branch.isDeleted = true;
      branch.deletedAt = new Date();
      branch.deletedBy = req.access?.userId || null;
      await branch.save();

      return res.status(200).json({ message: 'Branch deleted', data: { id: String(branch._id), code: originalCode } });
    } catch (error) {
      console.error('Delete branch error:', error);
      return res.status(500).json({ message: 'Failed to delete branch', error: error.message });
    }
  },

  /**
   * POST /admin/branches/:id/set-main
   * Note: records/stock without a branch (from before branches) are read as
   * the MAIN branch — run the branches migration before changing the main branch.
   */
  setMain: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: 'Invalid branch id' });
      const branch = await Branch.findById(id);
      if (!branch) return res.status(404).json({ message: 'Branch not found' });
      if (branch.isActive === false) return res.status(400).json({ message: 'An inactive branch cannot be the main branch' });

      await Branch.updateMany({ _id: { $ne: branch._id }, isMain: true }, { $set: { isMain: false } });
      if (!branch.isMain) {
        branch.isMain = true;
        await branch.save();
      }
      clearMainBranchCaches();
      return res.status(200).json({ message: 'Main branch updated', data: shape(branch.toObject()) });
    } catch (error) {
      console.error('Set main branch error:', error);
      return res.status(500).json({ message: 'Failed to set main branch', error: error.message });
    }
  },
};

module.exports = branchController;
