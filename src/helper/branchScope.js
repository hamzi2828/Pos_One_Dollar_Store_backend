// src/helper/branchScope.js
// Branch scoping for sales / held orders / purchases / expenses / reports.
//
// Rule: records saved before branches existed have `branch: null` and belong
// to the MAIN branch. So when a request is scoped to the main branch we match
// `{ branch: { $in: [mainId, null] } }`, otherwise `{ branch: id }`.
// Super admin viewing "all branches" -> no branch condition at all.
//
//   scopedBranchFilter(req, field='branch')  -> {} | { [field]: id } | { [field]: { $in: [mainId, null] } }
//   getMainBranchId()                         -> main branch id (string), cached 60s
//   branchScope(req)                          -> { allBranches, branchId, mainBranchId, isMain }
//   branchByIdMap(ids?)                       -> Map(idString -> { _id, name, code, isMain })
//   byBranchBreakdown(Model, match, opts)     -> [{ branchId, name, code, total, count }]
//   branchProductStockQuery(branchId, mainId) -> Product filter: stock > 0 in that branch
//   branchStockExpr(branchId, isMain)         -> aggregation expr: product pieces in that branch
//
// Per-branch stock helpers (withBranchStock, unitBranchStock, branchStockQuery)
// come from helper/productCodes.js (agent STOCK). Fallbacks below follow the
// shared contract so this file works even before those helpers land.
const mongoose = require('mongoose');
const Branch = require('../models/branch');
const { branchFilter } = require('../middleware/access');
const productCodes = require('./productCodes');

// Main branch id (string). Uses productCodes' cache when present so one
// clearMainBranchCache() (after "set main branch") resets both.
const MAIN_TTL_MS = 60 * 1000;
let mainCache = { at: 0, id: null };

async function getMainBranchId() {
  if (typeof productCodes.getMainBranchId === 'function') return productCodes.getMainBranchId();
  if (mainCache.id && Date.now() - mainCache.at < MAIN_TTL_MS) return mainCache.id;
  const main = await Branch.getMain();
  mainCache = { at: Date.now(), id: main ? String(main._id) : null };
  return mainCache.id;
}

const clearMainBranchCache = () => {
  mainCache = { at: 0, id: null };
  if (typeof productCodes.clearMainBranchCache === 'function') productCodes.clearMainBranchCache();
};

const toObjectId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

// Mongo condition for the request's branch (see header).
async function scopedBranchFilter(req, field = 'branch') {
  const f = branchFilter(req, field);
  if (!Object.prototype.hasOwnProperty.call(f, field)) return {}; // all branches
  const id = f[field];
  const mainId = await getMainBranchId();
  if (mainId && String(id) === mainId) return { [field]: { $in: [toObjectId(id), null] } };
  return f;
}

// What branch a request works on (for reads).
async function branchScope(req) {
  const f = branchFilter(req);
  const mainBranchId = await getMainBranchId();
  if (!Object.prototype.hasOwnProperty.call(f, 'branch')) {
    return { allBranches: true, branchId: null, mainBranchId, isMain: false };
  }
  const branchId = String(f.branch);
  return { allBranches: false, branchId, mainBranchId, isMain: branchId === mainBranchId };
}

// Records with no branch concept at all (web orders, salaries) belong to the
// main branch: include them only when viewing all branches or the main one.
const includesMainOnlyData = (scope) => scope.allBranches || scope.isMain;

// Map of branches by id (includes soft-deleted ones so old reports still name them).
async function branchByIdMap(ids) {
  const filter = ids && ids.length ? { _id: { $in: ids.filter(Boolean).map(toObjectId) } } : {};
  let q = Branch.find(filter).select('name code isMain isActive');
  if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  if (q && typeof q.lean === 'function') q = q.lean();
  const rows = (await q) || [];
  const map = new Map();
  for (const b of rows) map.set(String(b._id), b);
  return map;
}

/**
 * Totals per branch for the documents matching `match` (records without a
 * branch are counted for the main branch). Every non-deleted branch is listed,
 * even with zero. opts: { field='branch', sum='$total', mainBranchId? }.
 */
async function byBranchBreakdown(Model, match, opts = {}) {
  const field = opts.field || 'branch';
  const sum = opts.sum || '$total';
  const mainBranchId = opts.mainBranchId || (await getMainBranchId());
  const rows = await Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: [`$${field}`, toObjectId(mainBranchId)] },
        total: { $sum: sum },
        count: { $sum: 1 },
      },
    },
  ]);
  let list = Branch.find({}).select('name code isMain isActive');
  if (list && typeof list.lean === 'function') list = list.lean();
  const branches = (await list) || [];
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const out = branches.map((b) => {
    const r = byId.get(String(b._id));
    byId.delete(String(b._id));
    return { branchId: String(b._id), name: b.name, code: b.code, total: r ? r.total || 0 : 0, count: r ? r.count || 0 : 0 };
  });
  // Sales of branches that were deleted since: keep them visible.
  if (byId.size) {
    const extra = await branchByIdMap([...byId.keys()]);
    for (const [id, r] of byId) {
      const b = extra.get(id) || {};
      out.push({ branchId: id, name: b.name || 'Deleted branch', code: b.code || '', total: r.total || 0, count: r.count || 0 });
    }
  }
  return out;
}

// ---------------- per-branch stock (fallbacks per contract) ----------------

const sameId = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

function fallbackUnitBranchStock(unit, branchId, mainBranchId) {
  if (!unit) return 0;
  if (!branchId) return Math.max(0, Number(unit.stock) || 0);
  const isMain = sameId(branchId, mainBranchId);
  if (Array.isArray(unit.batches) && unit.batches.length) {
    return unit.batches
      .filter((b) => (b.branch ? sameId(b.branch, branchId) : isMain))
      .reduce((s, b) => s + (Number(b.quantity) || 0), 0);
  }
  if (Array.isArray(unit.branchStock) && unit.branchStock.length) {
    const row = unit.branchStock.find((r) => sameId(r.branch, branchId));
    return row ? Math.max(0, Number(row.stock) || 0) : 0;
  }
  return isMain ? Math.max(0, Number(unit.stock) || 0) : 0; // not migrated yet
}

function fallbackWithBranchStock(product, branchId, mainBranchId) {
  const p = { ...product, totalStock: Number(product.stock) || 0 };
  if (!branchId) return p;
  const isMain = sameId(branchId, mainBranchId);
  const pickBatches = (batches) =>
    (batches || []).filter((b) => (b.branch ? sameId(b.branch, branchId) : isMain));
  if (p.productType === 'variant') {
    p.variants = (p.variants || []).map((v) => ({
      ...v,
      totalStock: Number(v.stock) || 0,
      stock: fallbackUnitBranchStock(v, branchId, mainBranchId),
      batches: pickBatches(v.batches),
    }));
    p.stock = p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
  } else {
    p.stock = fallbackUnitBranchStock(product, branchId, mainBranchId);
    p.batches = pickBatches(product.batches);
  }
  return p;
}

function fallbackBranchStockQuery(branchId) {
  const branch = toObjectId(branchId);
  return {
    $or: [
      { branchStock: { $elemMatch: { branch, stock: { $gt: 0 } } } },
      { 'variants.branchStock': { $elemMatch: { branch, stock: { $gt: 0 } } } },
    ],
  };
}

const unitBranchStock = (...a) => (productCodes.unitBranchStock || fallbackUnitBranchStock)(...a);
const withBranchStock = (...a) => (productCodes.withBranchStock || fallbackWithBranchStock)(...a);

// Products with stock > 0 in this branch. For the main branch also products
// that were never migrated (no branchStock anywhere -> all stock is main's).
function branchProductStockQuery(branchId, mainBranchId) {
  if (!branchId) return { stock: { $gt: 0 } };
  // STOCK's helper already adds the un-migrated clause for the main branch.
  if (typeof productCodes.branchStockQuery === 'function') return productCodes.branchStockQuery(branchId, mainBranchId);
  const q = fallbackBranchStockQuery(branchId);
  if (!sameId(branchId, mainBranchId)) return q;
  const legacy = { stock: { $gt: 0 }, 'branchStock.0': { $exists: false }, 'variants.branchStock.0': { $exists: false } };
  return { $or: [q, legacy] };
}

// Aggregation expression: pieces of a product in branch `branchId` (from
// branchStock on the product / its variants). Products never migrated (no
// branchStock anywhere) hold all their stock in the main branch.
function branchStockExpr(branchId, isMain) {
  const bid = new mongoose.Types.ObjectId(String(branchId));
  const unitSum = (arr) => ({
    $sum: {
      $map: {
        input: { $filter: { input: { $ifNull: [arr, []] }, as: 'bs', cond: { $eq: ['$$bs.branch', bid] } } },
        as: 'x',
        in: { $ifNull: ['$$x.stock', 0] },
      },
    },
  });
  const variants = { $ifNull: ['$variants', []] };
  const migrated = {
    $or: [
      { $gt: [{ $size: { $ifNull: ['$branchStock', []] } }, 0] },
      {
        $anyElementTrue: [
          { $map: { input: variants, as: 'v', in: { $gt: [{ $size: { $ifNull: ['$$v.branchStock', []] } }, 0] } } },
        ],
      },
    ],
  };
  return {
    $cond: [
      migrated,
      {
        $cond: [
          { $eq: ['$productType', 'variant'] },
          { $sum: { $map: { input: variants, as: 'v', in: unitSum('$$v.branchStock') } } },
          unitSum('$branchStock'),
        ],
      },
      isMain ? { $ifNull: ['$stock', 0] } : 0,
    ],
  };
}

module.exports = {
  getMainBranchId,
  clearMainBranchCache,
  scopedBranchFilter,
  branchScope,
  includesMainOnlyData,
  branchByIdMap,
  byBranchBreakdown,
  unitBranchStock,
  withBranchStock,
  branchProductStockQuery,
  branchStockExpr,
  sameId,
};
