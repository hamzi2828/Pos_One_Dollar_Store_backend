// src/controller/store/racksCommon.js
// Shared bits of the Racks & Warehouse controllers.
//
// Racks, shelves and the warehouse belong to the shop (resolveWriteBranch).
// Every response carries `meta.branch` (the shop).
const Branch = require('../../models/branch');
const { resolveWriteBranch } = require('../../middleware/access');

const httpError = (message, status = 400, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
};

/** { branchId, branch: { _id, name, code, isMain } } or 403/404. */
async function moduleBranch(req) {
  const branchId = await resolveWriteBranch(req);
  const b = await Branch.findById(branchId).select('name code isMain isActive').lean();
  if (!b) throw httpError('Shop not found', 404, { code: 'BRANCH_NOT_FOUND' });
  return {
    branchId: String(b._id),
    branch: { _id: String(b._id), name: b.name, code: b.code, isMain: !!b.isMain, isActive: b.isActive !== false },
  };
}

const userIdOf = (req) => (req.access && req.access.userId) || (req.user && (req.user._id || req.user.id)) || null;

module.exports = { httpError, moduleBranch, userIdOf };
