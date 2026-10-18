// src/services/inventory/locationService.js
// Where stock sits inside a branch: on shelves (models/locationStock.js) or
// in the warehouse.
//
//   branch total  = product.branchStock (services/stockService.js, unchanged)
//   shelved       = sum of LocationStock rows of the unit in that branch
//   warehouse     = branch total - shelved   (never stored, never negative)
//
// So new receipts and old stock are automatically "in the warehouse" until
// someone puts them on a shelf (putaway). Sales take pieces off shelves
// first; vendor returns / shop use take from the warehouse first.
// Invariant kept after every out: shelved <= branch total.
const mongoose = require('mongoose');
const LocationStock = require('../../models/locationStock');
const Shelf = require('../../models/shelf');
const Product = require('../../models/product');
const movementService = require('./movementService');
const { unitBranchStock, getMainBranchId, toBranchId } = require('../../helper/productCodes');

const WAREHOUSE_CODE = 'WAREHOUSE';

// Types that take pieces off shelves first (customer / staff picks from the shelf).
const SHELF_FIRST_TYPES = ['sale', 'gift', 'damage'];

const locError = (message, status = 400, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  err.isLocationError = true;
  Object.assign(err, extra);
  return err;
};

const oid = (v) => {
  const s = toBranchId(v); // same 24-hex check works for any id
  return s ? new mongoose.Types.ObjectId(s) : null;
};
const vkey = (variantId) => (variantId === undefined || variantId === null || variantId === '' ? null : String(variantId));

const unitFilter = (branchId, productId, variantId) => ({
  branch: oid(branchId),
  product: oid(productId),
  variantId: vkey(variantId),
});

const loadProduct = async (productId) => {
  let q = Product.findById(productId);
  if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  return q.lean();
};

const pickUnit = (product, variantId) => {
  if (!product) return null;
  if (product.productType === 'variant') {
    const vs = product.variants || [];
    if (!variantId) return vs.length === 1 ? vs[0] : null;
    return vs.find((v) => String(v.variantId) === String(variantId) || String(v._id) === String(variantId)) || null;
  }
  return product;
};

/** Normalized variant key for a product: null for single products, the variant's variantId otherwise. */
const unitVariantKey = (product, variantId) => {
  if (!product || product.productType !== 'variant') return null;
  const unit = pickUnit(product, variantId);
  return unit ? String(unit.variantId) : vkey(variantId);
};

/** Branch total of a unit (pieces) from a plain product. */
async function branchTotalOf(product, variantId, branchId) {
  const unit = pickUnit(product, variantId);
  if (!unit) return 0;
  const mainBranchId = await getMainBranchId();
  return Math.max(0, Number(unitBranchStock(unit, branchId, mainBranchId)) || 0);
}

async function shelfRows(branchId, productId, variantId, { onlyStocked = true } = {}) {
  const filter = unitFilter(branchId, productId, variantId);
  if (onlyStocked) filter.qty = { $gt: 0 };
  return LocationStock.find(filter).sort({ firstPlacedAt: 1, _id: 1 }).lean();
}

async function shelvedTotal(branchId, productId, variantId) {
  const rows = await shelfRows(branchId, productId, variantId);
  return rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
}

/** { total, shelved, warehouse } for one unit in one branch. */
async function unitSplit({ branchId, productId, variantId, product = null }) {
  const p = product || (await loadProduct(productId));
  if (!p) throw locError('Product not found', 404);
  const key = unitVariantKey(p, variantId);
  const total = await branchTotalOf(p, key, branchId);
  const shelved = await shelvedTotal(branchId, p._id, key);
  return { total, shelved, warehouse: Math.max(0, total - shelved), variantId: key, product: p };
}

const loadShelf = async (shelfId, branchId) => {
  const id = oid(shelfId);
  if (!id) throw locError('Invalid shelf id');
  const shelf = await Shelf.findById(id).lean();
  if (!shelf) throw locError('Shelf not found', 404);
  if (branchId && String(shelf.branch) !== String(branchId)) {
    throw locError(`Shelf ${shelf.code} was not found`, 400, { code: 'SHELF_OTHER_BRANCH' });
  }
  if (shelf.isActive === false) throw locError(`Shelf ${shelf.code} is inactive`, 400);
  return shelf;
};

/** Add pieces to a shelf row (creates it). Low level: no checks, no ledger. */
async function addToShelf({ branchId, productId, variantId, shelf, qty }) {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0) return null;
  const now = new Date();
  const filter = { ...unitFilter(branchId, productId, variantId), shelf: oid(shelf._id || shelf) };
  const before = await LocationStock.findOneAndUpdate(
    filter,
    {
      $inc: { qty: n },
      $set: { lastMovedAt: now, shelfCode: shelf.code || '' },
      $setOnInsert: { firstPlacedAt: now, isHome: false },
    },
    { upsert: true, new: false }
  ).lean();
  // Row existed but was empty: the pieces now on it arrived now.
  if (before && !(Number(before.qty) > 0)) {
    await LocationStock.updateOne(filter, { $set: { firstPlacedAt: now } });
  }
  return { shelf: shelf._id || shelf, code: shelf.code || '', qty: n };
}

/** Take up to `qty` pieces off one row. Returns pieces actually taken. */
async function takeFromRow(row, qty) {
  let want = Math.floor(Number(qty) || 0);
  for (let attempt = 0; attempt < 3 && want > 0; attempt++) {
    const fresh = attempt === 0 ? row : await LocationStock.findById(row._id).lean();
    if (!fresh) return 0;
    const take = Math.min(want, Math.max(0, Number(fresh.qty) || 0));
    if (take <= 0) return 0;
    const res = await LocationStock.updateOne(
      { _id: fresh._id, qty: { $gte: take } },
      { $inc: { qty: -take }, $set: { lastMovedAt: new Date() } }
    );
    if (res.modifiedCount) {
      if (take === Number(fresh.qty) && !fresh.isHome) {
        await LocationStock.deleteOne({ _id: fresh._id, qty: 0, isHome: { $ne: true } });
      }
      return take;
    }
  }
  return 0;
}

/**
 * After the shop total of a unit DROPPED by `qty` (sale, damage, shop use...),
 * take the matching pieces off shelves.
 *   strategy 'shelf_first'     : shelves first (sales, gifts, damage on the floor)
 *   strategy 'warehouse_first' : warehouse first, shelves only for the rest
 *   fromShelfId                : that shelf first
 * Always keeps shelved <= branchTotalAfter. Returns [{shelf, code, qty}].
 */
async function consumeShelves({ branchId, productId, variantId, qty, branchTotalAfter, strategy = 'shelf_first', fromShelfId = null }) {
  const n = Math.floor(Number(qty) || 0);
  const rows = await shelfRows(branchId, productId, variantId);
  if (!rows.length) return [];
  const shelved = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const after = Math.max(0, Math.floor(Number(branchTotalAfter) || 0));
  const before = after + n;
  const warehouseBefore = Math.max(0, before - shelved);

  let fromShelves = strategy === 'warehouse_first' ? Math.max(0, n - warehouseBefore) : Math.min(n, shelved);
  if (fromShelfId && strategy === 'warehouse_first') {
    // A named shelf means the pieces physically came from that shelf.
    const named = rows.find((r) => String(r.shelf) === String(fromShelfId));
    if (named) fromShelves = Math.max(fromShelves, Math.min(n, Number(named.qty) || 0));
  }
  // Invariant: what stays on shelves must fit in the new branch total.
  fromShelves = Math.min(shelved, Math.max(fromShelves, shelved - after));
  if (fromShelves <= 0) return [];

  const ordered = fromShelfId
    ? [...rows.filter((r) => String(r.shelf) === String(fromShelfId)), ...rows.filter((r) => String(r.shelf) !== String(fromShelfId))]
    : rows;
  const taken = [];
  let remaining = fromShelves;
  for (const row of ordered) {
    if (remaining <= 0) break;
    const got = await takeFromRow(row, Math.min(remaining, Number(row.qty) || 0));
    if (got > 0) {
      taken.push({ shelf: row.shelf, code: row.shelfCode || '', qty: got });
      remaining -= got;
    }
  }
  return taken;
}

/**
 * Put pieces from the warehouse onto a shelf (records a 'putaway' movement).
 * @returns {{ shelf, qty, split }} split = {total, shelved, warehouse} after
 */
async function putaway({ branchId, productId, variantId, shelfId, qty, userId = null, note = '' }) {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0) throw locError('Quantity must be at least 1');
  const branch = toBranchId(branchId);
  if (!branch) throw locError('Choose a branch first', 400, { code: 'INVALID_BRANCH' });
  const shelf = await loadShelf(shelfId, branch);
  const split = await unitSplit({ branchId: branch, productId, variantId });
  if (split.product.productType === 'variant' && !split.variantId) throw locError('Choose a variant');
  if (n > split.warehouse) {
    throw locError(`Only ${split.warehouse} piece(s) of ${split.product.name} are in the warehouse`, 400, {
      code: 'NOT_ENOUGH_IN_WAREHOUSE',
      available: split.warehouse,
    });
  }
  const placed = await addToShelf({ branchId: branch, productId: split.product._id, variantId: split.variantId, shelf, qty: n });
  await movementService.record({
    type: 'putaway',
    branchId: branch,
    productId: split.product._id,
    variantId: split.variantId,
    product: split.product,
    quantity: n,
    balanceAfter: split.total,
    from: { kind: 'warehouse', code: WAREHOUSE_CODE },
    to: { kind: 'shelf', shelf: shelf._id, code: shelf.code },
    shelves: [placed],
    userId,
    note,
  });
  return {
    shelf,
    qty: n,
    split: { total: split.total, shelved: split.shelved + n, warehouse: split.warehouse - n },
  };
}

/**
 * Move pieces shelf -> shelf, or shelf -> warehouse (toShelfId null).
 * Records a 'location_move' movement.
 */
async function moveStock({ branchId, productId, variantId, fromShelfId, toShelfId = null, qty, userId = null, note = '' }) {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0) throw locError('Quantity must be at least 1');
  const branch = toBranchId(branchId);
  if (!branch) throw locError('Choose a branch first', 400, { code: 'INVALID_BRANCH' });
  const product = await loadProduct(productId);
  if (!product) throw locError('Product not found', 404);
  const key = unitVariantKey(product, variantId);
  const fromShelf = await loadShelf(fromShelfId, branch);
  const toShelf = toShelfId ? await loadShelf(toShelfId, branch) : null;
  if (toShelf && String(toShelf._id) === String(fromShelf._id)) throw locError('Choose a different shelf');

  const row = await LocationStock.findOne({ ...unitFilter(branch, product._id, key), shelf: fromShelf._id }).lean();
  const have = row ? Number(row.qty) || 0 : 0;
  if (n > have) {
    throw locError(`Only ${have} piece(s) of ${product.name} are on ${fromShelf.code}`, 400, { code: 'NOT_ENOUGH_ON_SHELF', available: have });
  }
  const got = await takeFromRow(row, n);
  if (got < n) {
    // Someone moved pieces at the same moment: put back what we took.
    if (got > 0) await addToShelf({ branchId: branch, productId: product._id, variantId: key, shelf: fromShelf, qty: got });
    throw locError('Stock on this shelf changed. Please try again.', 409, { code: 'LOCATION_CONFLICT' });
  }
  if (toShelf) await addToShelf({ branchId: branch, productId: product._id, variantId: key, shelf: toShelf, qty: n });

  const total = await branchTotalOf(product, key, branch);
  await movementService.record({
    type: 'location_move',
    branchId: branch,
    productId: product._id,
    variantId: key,
    product,
    quantity: n,
    balanceAfter: total,
    from: { kind: 'shelf', shelf: fromShelf._id, code: fromShelf.code },
    to: toShelf ? { kind: 'shelf', shelf: toShelf._id, code: toShelf.code } : { kind: 'warehouse', code: WAREHOUSE_CODE },
    shelves: [{ shelf: fromShelf._id, code: fromShelf.code, qty: n }],
    userId,
    note,
  });
  return { from: fromShelf, to: toShelf, qty: n };
}

/** Mark / unmark a shelf as the home location of a unit (row kept at qty 0). */
async function setHomeShelf({ branchId, productId, variantId, shelfId, isHome = true }) {
  const branch = toBranchId(branchId);
  const shelf = await loadShelf(shelfId, branch);
  const product = await loadProduct(productId);
  if (!product) throw locError('Product not found', 404);
  const key = unitVariantKey(product, variantId);
  const filter = { ...unitFilter(branch, product._id, key), shelf: shelf._id };
  if (isHome) {
    await LocationStock.updateOne(
      filter,
      { $set: { isHome: true, shelfCode: shelf.code }, $setOnInsert: { qty: 0, firstPlacedAt: null } },
      { upsert: true }
    );
  } else {
    await LocationStock.updateOne(filter, { $set: { isHome: false } });
    await LocationStock.deleteOne({ ...filter, qty: { $lte: 0 } });
  }
  return { shelf, isHome: !!isHome };
}

/**
 * Where a product is, per branch and unit:
 * [{ branchId, variantId, total, shelved, warehouse, shelves: [{shelfId, code, qty, isHome, firstPlacedAt}] }]
 */
async function getProductLocations(productId, { branchId = null } = {}) {
  const product = await loadProduct(productId);
  if (!product) throw locError('Product not found', 404);
  const filter = { product: product._id };
  if (branchId) filter.branch = oid(branchId);
  const rows = await LocationStock.find(filter).sort({ firstPlacedAt: 1 }).lean();
  const mainBranchId = await getMainBranchId();

  const units = product.productType === 'variant' ? (product.variants || []).map((v) => ({ unit: v, key: String(v.variantId) })) : [{ unit: product, key: null }];
  const branchIds = new Set();
  for (const { unit } of units) for (const r of unit.branchStock || []) branchIds.add(String(r.branch));
  for (const r of rows) branchIds.add(String(r.branch));
  if (!branchIds.size && mainBranchId) branchIds.add(String(mainBranchId));
  if (branchId) {
    branchIds.clear();
    branchIds.add(String(branchId));
  }

  const out = [];
  for (const b of branchIds) {
    for (const { unit, key } of units) {
      const total = Math.max(0, Number(unitBranchStock(unit, b, mainBranchId)) || 0);
      const mine = rows.filter((r) => String(r.branch) === b && (r.variantId || null) === key);
      const shelved = mine.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      if (!total && !mine.length) continue;
      out.push({
        branchId: b,
        variantId: key,
        total,
        shelved,
        warehouse: Math.max(0, total - shelved),
        shelves: mine.map((r) => ({
          shelfId: String(r.shelf),
          code: r.shelfCode,
          qty: Number(r.qty) || 0,
          isHome: !!r.isHome,
          firstPlacedAt: r.firstPlacedAt,
        })),
      });
    }
  }
  return out;
}

/** Rows on one shelf with product names: [{ productId, variantId, name, qty, isHome, firstPlacedAt, ... }] */
async function getShelfContents(shelfId) {
  const id = oid(shelfId);
  if (!id) throw locError('Invalid shelf id');
  const rows = await LocationStock.find({ shelf: id }).sort({ firstPlacedAt: 1 }).lean();
  if (!rows.length) return [];
  const productIds = [...new Set(rows.map((r) => String(r.product)))];
  let q = Product.find({ _id: { $in: productIds } });
  if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  const products = await q
    .select('name category price costPrice shortCode sku thumbnailUrl productType variants.variantId variants.color variants.size variants.attributes variants.price variants.costPrice variants.shortCode variants.sku')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return rows.map((r) => {
    const p = byId.get(String(r.product)) || {};
    const unit = pickUnit(p, r.variantId) || p;
    return {
      id: String(r._id),
      productId: String(r.product),
      variantId: r.variantId || null,
      name: p.name || '(deleted product)',
      category: p.category || '',
      code: unit.shortCode || unit.sku || '',
      price: unit.price ?? p.price ?? null,
      costPrice: unit.costPrice ?? p.costPrice ?? null,
      thumbnailUrl: p.thumbnailUrl || null,
      qty: Number(r.qty) || 0,
      isHome: !!r.isHome,
      firstPlacedAt: r.firstPlacedAt,
      lastMovedAt: r.lastMovedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Added by the Racks & Warehouse module (new functions only).
// ---------------------------------------------------------------------------
const { branchStockQuery } = require('../../helper/productCodes');

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Shelf of a branch by id, or by its code (a scanned shelf label "A1-S2").
 * Same checks as loadShelf (right branch, active).
 */
async function findShelf({ branchId, shelfId = null, shelfCode = null }) {
  if (shelfId) return loadShelf(shelfId, branchId);
  const code = String(shelfCode || '').trim().toUpperCase();
  if (!code) throw locError('Choose a shelf');
  const branch = oid(branchId);
  if (!branch) throw locError('Choose a branch first', 400, { code: 'INVALID_BRANCH' });
  const shelf = await Shelf.findOne({ branch, code }).lean();
  if (!shelf) throw locError(`Shelf ${code} was not found`, 404, { code: 'SHELF_NOT_FOUND' });
  if (shelf.isActive === false) throw locError(`Shelf ${shelf.code} is inactive`, 400);
  return shelf;
}

// Product fields needed to compute per-unit branch stock (kept small: ~10k products).
const WAREHOUSE_PRODUCT_FIELDS = [
  'name', 'category', 'price', 'costPrice', 'shortCode', 'sku', 'thumbnailUrl', 'productType',
  'stock', 'branchStock', 'batches.branch', 'batches.quantity', 'lastReceivedAt',
  'variants.variantId', 'variants.color', 'variants.size', 'variants.attributes', 'variants.price',
  'variants.costPrice', 'variants.shortCode', 'variants.sku', 'variants.stock', 'variants.branchStock',
  'variants.batches.branch', 'variants.batches.quantity', 'variants.lastReceivedAt',
].join(' ');

const unitLabel = (v) => {
  if (!v) return '';
  const attrs = v.attributes && typeof v.attributes === 'object' ? Object.values(v.attributes) : [];
  return [v.color, v.size, ...attrs].filter(Boolean).join(' / ');
};

/**
 * Units of a branch that still have pieces in the warehouse
 * (branch total - shelved > 0). Two queries for the whole branch:
 * products with stock here (projected) + one LocationStock $group.
 *
 * @param {object} o
 * @param {string} o.branchId
 * @param {string} [o.search]   name words / code prefix / category
 * @param {string} [o.category]
 * @param {'name'|'qty'|'newest'|'oldest'} [o.sort='name']
 * @returns {{ items, total, totalPieces, page, limit }}
 */
async function listWarehouse({ branchId, search = '', category = '', sort = 'name', page = 1, limit = 25 } = {}) {
  const branch = toBranchId(branchId);
  if (!branch) throw locError('Choose a branch first', 400, { code: 'INVALID_BRANCH' });
  const mainBranchId = await getMainBranchId();

  const and = [branchStockQuery(branch, mainBranchId)];
  const term = String(search || '').trim();
  if (term) {
    const words = term.split(/\s+/).filter(Boolean).map(escapeRx);
    and.push({
      $or: [
        { name: { $regex: words.map((w) => `(?=.*${w})`).join(''), $options: 'i' } },
        { scanCodes: { $regex: `^${escapeRx(term.toUpperCase())}` } },
        { category: { $regex: escapeRx(term), $options: 'i' } },
      ],
    });
  }
  if (category) and.push({ category: String(category) });

  const [products, rows] = await Promise.all([
    Product.find({ $and: and }).select(WAREHOUSE_PRODUCT_FIELDS).lean(),
    LocationStock.aggregate([
      { $match: { branch: oid(branch), $or: [{ qty: { $gt: 0 } }, { isHome: true }] } },
      {
        $group: {
          _id: { product: '$product', variantId: '$variantId' },
          shelved: { $sum: '$qty' },
          shelves: { $push: { shelfId: '$shelf', code: '$shelfCode', qty: '$qty', isHome: '$isHome' } },
        },
      },
    ]),
  ]);

  const byUnit = new Map(rows.map((r) => [`${r._id.product}|${r._id.variantId || ''}`, r]));
  const items = [];
  for (const p of products) {
    const units = p.productType === 'variant' ? (p.variants || []).map((v) => ({ u: v, key: String(v.variantId) })) : [{ u: p, key: null }];
    for (const { u, key } of units) {
      const total = Math.max(0, Number(unitBranchStock(u, branch, mainBranchId)) || 0);
      if (!total) continue;
      const loc = byUnit.get(`${p._id}|${key || ''}`);
      const shelved = loc ? Number(loc.shelved) || 0 : 0;
      const warehouse = total - shelved;
      if (warehouse <= 0) continue;
      const shelves = loc ? loc.shelves.map((s) => ({ ...s, shelfId: String(s.shelfId), isHome: !!s.isHome })) : [];
      shelves.sort((a, b) => Number(b.isHome) - Number(a.isHome) || b.qty - a.qty);
      items.push({
        productId: String(p._id),
        variantId: key,
        name: p.name,
        variantLabel: key ? unitLabel(u) : '',
        category: p.category || '',
        code: u.shortCode || u.sku || '',
        price: u.price ?? p.price ?? null,
        costPrice: u.costPrice ?? p.costPrice ?? null,
        thumbnailUrl: p.thumbnailUrl || null,
        total,
        shelved,
        warehouse,
        lastReceivedAt: u.lastReceivedAt || p.lastReceivedAt || null,
        homeShelf: shelves.find((s) => s.isHome) || null,
        shelves: shelves.filter((s) => s.qty > 0 || s.isHome),
      });
    }
  }

  const time = (d) => (d ? new Date(d).getTime() : 0);
  const byName = (a, b) => a.name.localeCompare(b.name) || a.variantLabel.localeCompare(b.variantLabel);
  const sorters = {
    name: byName,
    qty: (a, b) => b.warehouse - a.warehouse || byName(a, b),
    newest: (a, b) => time(b.lastReceivedAt) - time(a.lastReceivedAt) || byName(a, b),
    // waiting longest first (never-received / old stock at the top)
    oldest: (a, b) => time(a.lastReceivedAt) - time(b.lastReceivedAt) || byName(a, b),
  };
  items.sort(sorters[sort] || sorters.name);

  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  return {
    items: items.slice((pg - 1) * lim, pg * lim),
    total: items.length,
    totalPieces: items.reduce((s, x) => s + x.warehouse, 0),
    page: pg,
    limit: lim,
  };
}

module.exports = {
  WAREHOUSE_CODE,
  SHELF_FIRST_TYPES,
  unitSplit,
  shelvedTotal,
  addToShelf,
  consumeShelves,
  putaway,
  moveStock,
  setHomeShelf,
  getProductLocations,
  getShelfContents,
  loadShelf,
  unitVariantKey,
  // Racks & Warehouse module
  findShelf,
  listWarehouse,
  unitLabel,
  WAREHOUSE_PRODUCT_FIELDS,
};
