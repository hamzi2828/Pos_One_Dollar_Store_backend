// src/services/analytics/stockUnits.js
// Building blocks for the stock reports (demand list, slow moving).
//
// A "unit" is a single product or one variant; a "row" is a unit in one branch
// (key `${productId}|${variantId || ''}|${branchId}`). Current stock comes from
// the product document (the source of truth); stock timing — when it was
// received, how many left since, when it fell below a level — comes from the
// StockMovement ledger, always through indexed queries
// ({ product, variantId, branch, occurredAt }), never one query per unit.
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const POSOrder = require('../../models/posOrder');
const LocationStock = require('../../models/locationStock');
const { listUnits, unitBranchRows, variantLabel } = require('../../helper/productCodes');
const { toId, idStr, escapeRegex, mapLimit, chunk, SALE_MATCH, PRODUCT_LINE_MATCH } = require('./common');

// Movements that (re)fill a branch: the latest one starts the "since last receipt" window.
const RECEIPT_TYPES = ['purchase_receipt', 'receive', 'consignment_in', 'opening', 'transfer_in'];
// Pieces that left to customers (gifts use stock too); sale_return gives them back.
const SOLD_TYPES = ['sale', 'gift'];

const OR_CHUNK = 200; // $or clauses per ledger query
const PARALLEL = 4;

const UNIT_FIELDS = [
  'stock', 'branchStock', 'batches.branch', 'batches.quantity', 'price', 'discountedPrice', 'costPrice',
  'shortCode', 'sku', 'lastVendor', 'lastVendorName', 'lastReceivedAt', 'lastReceivedQty', 'lastLandedCost',
  'lastPurchasePrice', 'firstReceivedAt',
];
const PRODUCT_SELECT = [
  'name', 'category', 'productType', 'createdAt', 'parLevel', 'reorderPct', 'isConsignment', 'consignmentVendor',
  'consignmentRate', 'piecesPerBox', ...UNIT_FIELDS,
  'variants._id', 'variants.variantId', 'variants.color', 'variants.size', 'variants.attributes',
  ...UNIT_FIELDS.map((f) => `variants.${f}`),
].join(' ');

const rowKey = (productId, variantId, branchId) => `${idStr(productId)}|${variantId ? String(variantId) : ''}|${idStr(branchId)}`;
const unitKeyOf = (productId, variantId) => `${idStr(productId)}|${variantId ? String(variantId) : ''}`;
const numOrNull = (n) => (n === undefined || n === null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n));

/** Product filter from report query params: category, search, productIds. */
function productFilter({ category, search, productIds } = {}) {
  const f = {};
  if (category) f.category = String(category);
  if (search && String(search).trim()) {
    const raw = String(search).trim();
    const rx = new RegExp(escapeRegex(raw), 'i');
    f.$or = [{ name: rx }, { scanCodes: raw.toUpperCase() }, { sku: rx }, { 'variants.sku': rx }];
  }
  if (Array.isArray(productIds)) f._id = { $in: productIds.map(toId).filter(Boolean) };
  return f;
}

/**
 * Units of the matching products with their stock per branch.
 * Returns { rows: Map(key -> row), units: Map(unitKey -> unit), aliasVariant(productId, v), ensureRow(unitKey, branchId) }.
 * Rows exist for every branch holding the unit (stock may be 0); ensureRow()
 * adds a 0-stock row for a branch known only from the ledger.
 */
async function loadUnits(scope, filter = {}) {
  const products = await Product.find(filter).select(PRODUCT_SELECT).lean();
  const units = new Map();
  const rows = new Map();
  const alias = new Map(); // `${pid}|${variant _id or variantId}` -> variantId

  const makeRow = (unit, branchId, stock) => {
    const key = rowKey(unit.productId, unit.variantId, branchId);
    const row = { ...unit, key, unitKey: unit.unitKey, branchId: String(branchId), stock: Math.max(0, Number(stock) || 0) };
    rows.set(key, row);
    return row;
  };

  for (const p of products) {
    for (const { variant, unit } of listUnits(p)) {
      const variantId = variant ? String(variant.variantId) : null;
      if (variant) {
        alias.set(`${p._id}|${variant._id}`, variantId);
        alias.set(`${p._id}|${variantId}`, variantId);
      }
      const info = {
        unitKey: unitKeyOf(p._id, variantId),
        productId: String(p._id),
        variantId,
        name: p.name,
        variantLabel: variant ? variantLabel(variant) : '',
        code: unit.shortCode || unit.sku || p.shortCode || '',
        category: p.category || 'Uncategorized',
        isConsignment: !!p.isConsignment,
        consignmentVendor: p.consignmentVendor ? String(p.consignmentVendor) : null,
        parLevel: numOrNull(p.parLevel),
        reorderPct: numOrNull(p.reorderPct),
        piecesPerBox: Math.max(1, Number(p.piecesPerBox) || 1),
        salePrice: Number(unit.discountedPrice) > 0 ? Number(unit.discountedPrice) : Number(unit.price ?? p.price) || 0,
        costPrice: numOrNull(unit.costPrice) ?? numOrNull(p.costPrice) ?? 0,
        lastLandedCost: numOrNull(unit.lastLandedCost),
        lastPurchasePrice: numOrNull(unit.lastPurchasePrice),
        lastVendor: unit.lastVendor ? String(unit.lastVendor) : p.lastVendor ? String(p.lastVendor) : null,
        lastVendorName: unit.lastVendorName || p.lastVendorName || '',
        lastReceivedAt: unit.lastReceivedAt || null,
        lastReceivedQty: numOrNull(unit.lastReceivedQty),
        firstReceivedAt: unit.firstReceivedAt || null,
        createdAt: p.createdAt || null,
      };
      units.set(info.unitKey, info);
      for (const r of unitBranchRows(unit, scope.mainBranchId)) {
        if (scope.branchId && String(r.branch) !== String(scope.branchId)) continue;
        makeRow(info, r.branch, r.stock);
      }
    }
  }

  const ensureRow = (unitKey, branchId) => {
    const unit = units.get(unitKey);
    if (!unit) return null;
    if (scope.branchId && String(branchId) !== String(scope.branchId)) return null;
    return rows.get(rowKey(unit.productId, unit.variantId, branchId)) || makeRow(unit, branchId, 0);
  };
  const aliasVariant = (productId, v) => (v ? alias.get(`${productId}|${v}`) || String(v) : null);

  return { rows, units, ensureRow, aliasVariant, productIds: products.map((p) => p._id) };
}

/**
 * Latest receipt of every unit in every branch of the scope:
 * Map(key -> { at, qty, type, vendor, unitCost, purchasePrice, firstAt }).
 */
async function lastReceipts(scope, productIds) {
  const match = { type: { $in: RECEIPT_TYPES }, ...scope.stockMatch };
  if (productIds) match.product = { $in: productIds };
  const rows = await StockMovement.aggregate([
    { $match: match },
    { $sort: { occurredAt: 1, _id: 1 } },
    {
      $group: {
        _id: { p: '$product', v: '$variantId', b: '$branch' },
        at: { $last: '$occurredAt' },
        qty: { $last: '$quantity' },
        type: { $last: '$type' },
        vendor: { $last: '$vendor' },
        unitCost: { $last: '$unitCost' },
        purchasePrice: { $last: '$purchasePrice' },
        firstAt: { $first: '$occurredAt' },
      },
    },
  ]).allowDiskUse(true);
  const out = new Map();
  for (const r of rows) {
    out.set(rowKey(r._id.p, r._id.v, r._id.b), {
      at: r.at,
      qty: Number(r.qty) || 0,
      type: r.type,
      vendor: r.vendor ? String(r.vendor) : null,
      unitCost: numOrNull(r.unitCost),
      purchasePrice: numOrNull(r.purchasePrice),
      firstAt: r.firstAt,
    });
  }
  return out;
}

/** Cheapest vendor price ever seen on purchase receipts, per unit (all branches): Map(unitKey -> { vendor, price, at }). */
async function cheapestVendors(productIds) {
  const match = { type: 'purchase_receipt', vendor: { $ne: null }, purchasePrice: { $gt: 0 } };
  if (productIds) match.product = { $in: productIds };
  const rows = await StockMovement.aggregate([
    { $match: match },
    { $group: { _id: { p: '$product', v: '$variantId', vendor: '$vendor' }, price: { $min: '$purchasePrice' }, at: { $max: '$occurredAt' } } },
    { $sort: { price: 1, at: -1 } },
    { $group: { _id: { p: '$_id.p', v: '$_id.v' }, vendor: { $first: '$_id.vendor' }, price: { $first: '$price' }, at: { $first: '$at' }, vendors: { $sum: 1 } } },
  ]).allowDiskUse(true);
  return new Map(rows.map((r) => [unitKeyOf(r._id.p, r._id.v), { vendor: String(r._id.vendor || r.vendor), price: r.price, at: r.at, vendors: r.vendors }]));
}

const ledgerClause = (it, extra = {}) => ({
  product: toId(it.productId),
  variantId: it.variantId || null,
  branch: toId(it.branchId),
  occurredAt: { $gte: new Date(it.since) },
  ...extra,
});

const keyOfGroup = (id) => rowKey(id.p, id.v, id.b);

/**
 * Ledger since each row's `since` date (items: [{ key, productId, variantId, branchId, since, threshold? }]):
 * Map(key -> { sold, peak, lastSaleAt, crossedAt }).
 *   sold       sale + gift pieces − sale returns
 *   peak       highest stock after any movement
 *   crossedAt  first movement that left stock at or below the row's `threshold`
 *              (only when items carry one)
 * The per-row threshold is picked inside the query with a $switch, so the
 * $match stays a plain indexed $or (a balanceAfter filter per clause makes the
 * query planner slow on a cold cache).
 */
async function ledgerSince(items) {
  const out = new Map();
  const list = items.filter((i) => i.since);
  await mapLimit(chunk(list, OR_CHUNK), PARALLEL, async (part) => {
    const withThreshold = part.filter((it) => Number.isFinite(it.threshold));
    const group = {
      _id: { p: '$product', v: '$variantId', b: '$branch' },
      sold: {
        $sum: {
          $cond: [
            { $in: ['$type', SOLD_TYPES] },
            '$quantity',
            { $cond: [{ $eq: ['$type', 'sale_return'] }, { $multiply: [-1, '$quantity'] }, 0] },
          ],
        },
      },
      peak: { $max: '$balanceAfter' },
      lastSaleAt: { $max: { $cond: [{ $in: ['$type', SOLD_TYPES] }, '$occurredAt', null] } },
    };
    const stages = [{ $match: { $or: part.map((it) => ledgerClause(it)) } }];
    if (withThreshold.length) {
      stages.push({
        $set: {
          _thr: {
            $switch: {
              branches: withThreshold.map((it) => ({
                case: {
                  $and: [
                    { $eq: ['$product', toId(it.productId)] },
                    { $eq: ['$branch', toId(it.branchId)] },
                    { $eq: [{ $ifNull: ['$variantId', null] }, it.variantId || null] },
                  ],
                },
                then: it.threshold,
              })),
              default: null,
            },
          },
        },
      });
      group.crossedAt = {
        $min: {
          $cond: [
            { $and: [{ $ne: ['$_thr', null] }, { $isNumber: '$balanceAfter' }, { $lte: ['$balanceAfter', '$_thr'] }] },
            '$occurredAt',
            null,
          ],
        },
      };
    }
    stages.push({ $group: group });
    const rows = await StockMovement.aggregate(stages);
    for (const r of rows) {
      out.set(keyOfGroup(r._id), {
        sold: Math.max(0, r.sold || 0),
        peak: numOrNull(r.peak),
        lastSaleAt: r.lastSaleAt || null,
        crossedAt: r.crossedAt || null,
      });
    }
  });
  return out;
}

/**
 * Pieces sold on bills since `since`, per row (POSOrder; gifts included because
 * they empty the shelf too): Map(key -> { qty, lastAt }).
 */
async function recentSales(scope, since, { productIds, aliasVariant } = {}) {
  const orderMatch = { ...SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: since } };
  if (productIds) orderMatch['items.product'] = { $in: productIds };
  const lineMatch = { ...PRODUCT_LINE_MATCH };
  if (productIds) lineMatch['items.product'] = { $in: productIds };
  const rows = await POSOrder.aggregate([
    { $match: orderMatch },
    { $project: { branch: 1, createdAt: 1, items: { product: 1, variantId: 1, quantity: 1 } } },
    { $unwind: '$items' },
    { $match: lineMatch },
    {
      $group: {
        _id: { p: '$items.product', v: '$items.variantId', b: { $ifNull: ['$branch', scope.mainBranchOid] } },
        qty: { $sum: '$items.quantity' },
        lastAt: { $max: '$createdAt' },
      },
    },
  ]).allowDiskUse(true);
  const out = new Map();
  for (const r of rows) {
    const v = aliasVariant ? aliasVariant(String(r._id.p), r._id.v || null) : r._id.v || null;
    const key = rowKey(r._id.p, v, r._id.b);
    const prev = out.get(key) || { qty: 0, lastAt: null };
    prev.qty += Number(r.qty) || 0;
    if (!prev.lastAt || r.lastAt > prev.lastAt) prev.lastAt = r.lastAt;
    out.set(key, prev);
  }
  return out;
}

/** Shelves holding each row: Map(key -> { shelves: [{ code, qty }], firstPlacedAt }). */
async function shelvesByRow(scope, productIds) {
  const match = { qty: { $gt: 0 }, ...scope.stockMatch };
  if (productIds) match.product = { $in: productIds };
  const rows = await LocationStock.find(match).select('branch product variantId shelfCode qty firstPlacedAt').lean();
  const out = new Map();
  for (const r of rows) {
    const key = rowKey(r.product, r.variantId, r.branch);
    const e = out.get(key) || { shelves: [], firstPlacedAt: null };
    e.shelves.push({ code: r.shelfCode, qty: r.qty });
    if (r.firstPlacedAt && (!e.firstPlacedAt || r.firstPlacedAt < e.firstPlacedAt)) e.firstPlacedAt = r.firstPlacedAt;
    out.set(key, e);
  }
  for (const e of out.values()) e.shelves.sort((a, b) => b.qty - a.qty);
  return out;
}

module.exports = {
  RECEIPT_TYPES,
  SOLD_TYPES,
  rowKey,
  unitKeyOf,
  productFilter,
  loadUnits,
  lastReceipts,
  cheapestVendors,
  ledgerSince,
  recentSales,
  shelvesByRow,
};
