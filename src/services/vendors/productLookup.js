// src/services/vendors/productLookup.js
// Product search for the vendor screens (returns, consignment intake / swap):
// by scanned code, name or id, with each unit's stock in the working branch,
// its shelves, our cost and THIS vendor's last price to us (the default
// price a returned piece goes back at).
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const LocationStock = require('../../models/locationStock');
const { unitAvailable } = require('../stockService');
const { normalizeCode, variantLabel, resolveScan, getMainBranchId } = require('../../helper/productCodes');
const { oid, isId, str, escapeRx, round4 } = require('./common');

const unitKey = (productId, variantId) => `${String(productId)}|${variantId ? String(variantId) : ''}`;

/** Map unitKey -> { price, unitCost, at } of the vendor's LAST receipt of each unit. */
async function vendorLastPrices(vendorId, productIds) {
  const vendor = oid(vendorId);
  const ids = (productIds || []).map(oid).filter(Boolean);
  const out = new Map();
  if (!vendor || !ids.length) return out;
  const rows = await StockMovement.aggregate([
    { $match: { vendor, product: { $in: ids }, type: { $in: ['purchase_receipt', 'consignment_in'] } } },
    { $sort: { occurredAt: -1, _id: -1 } },
    {
      $group: {
        _id: { product: '$product', variantId: '$variantId' },
        purchasePrice: { $first: '$purchasePrice' },
        unitCost: { $first: '$unitCost' },
        at: { $first: '$occurredAt' },
      },
    },
  ]);
  for (const r of rows) {
    const price = r.purchasePrice !== null && r.purchasePrice !== undefined ? r.purchasePrice : r.unitCost;
    out.set(unitKey(r._id.product, r._id.variantId), { price, unitCost: r.unitCost, at: r.at });
  }
  return out;
}

/**
 * Default price a unit goes back to the vendor at:
 * this vendor's last purchase price, else our average cost, else 0.
 */
function defaultReturnCost(prices, product, unit, variantId) {
  const hit = prices.get(unitKey(product._id, variantId));
  if (hit && Number.isFinite(Number(hit.price))) return { unitCost: round4(hit.price), source: 'vendor_last_price', at: hit.at };
  const cost = unit && unit.costPrice !== undefined && unit.costPrice !== null ? unit.costPrice : product.costPrice;
  if (Number.isFinite(Number(cost))) return { unitCost: round4(cost), source: 'cost_price', at: null };
  return { unitCost: 0, source: 'none', at: null };
}

const SELECT =
  'name category price costPrice stock shortCode sku thumbnailUrl productType isConsignment consignmentVendor consignmentRate lastPurchasePrice lastVendor lastVendorName ' +
  'branchStock batches.branch batches.quantity batches.batchNo batches.barcode ' +
  'variants.variantId variants.color variants.size variants.attributes variants.price variants.costPrice variants.stock variants.shortCode variants.sku ' +
  'variants.branchStock variants.batches.branch variants.batches.quantity variants.batches.batchNo variants.batches.barcode ' +
  'variants.barcodes variants.lastPurchasePrice barcodes scanCodes';

/**
 * GET /api/vendor-products/search?search=&productId=&vendorId=&limit=
 * Working branch = the request's branch (super admin without one: main).
 */
async function search(req, query = {}) {
  const mainBranchId = await getMainBranchId();
  const branchId = req.access && req.access.branchId ? String(req.access.branchId) : mainBranchId ? String(mainBranchId) : null;
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 15));
  const text = str(query.search, 80);

  let filter;
  const ids = String(query.productId || query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(isId);
  if (ids.length) filter = { _id: { $in: ids.map(oid) } };
  else if (text) {
    const code = normalizeCode(text);
    const rx = new RegExp(escapeRx(text), 'i');
    filter = { $or: [{ scanCodes: code }, { name: rx }, { sku: rx }, { 'variants.sku': rx }] };
  } else return [];
  if (query.consignmentOnly === 'true') filter.isConsignment = true;

  const products = await Product.find(filter).select(SELECT).limit(limit).lean();
  if (!products.length) return [];
  const prices = await vendorLastPrices(query.vendorId, products.map((p) => p._id));
  const shelfRows = branchId
    ? await LocationStock.find({ branch: oid(branchId), product: { $in: products.map((p) => p._id) }, qty: { $gt: 0 } })
        .select('product variantId shelf shelfCode qty')
        .lean()
    : [];

  // Exact code hits first.
  const code = text ? normalizeCode(text) : '';
  const ranked = products
    .map((p) => ({ p, scan: code ? resolveScan(p, code) : null }))
    .sort((a, b) => (b.scan ? 1 : 0) - (a.scan ? 1 : 0));

  return ranked.map(({ p, scan }) => {
    const units =
      p.productType === 'variant'
        ? (p.variants || []).map((v) => ({ unit: v, variantId: String(v.variantId), label: variantLabel(v) }))
        : [{ unit: p, variantId: null, label: '' }];
    return {
      _id: p._id,
      name: p.name,
      category: p.category,
      productType: p.productType,
      thumbnailUrl: p.thumbnailUrl || null,
      isConsignment: !!p.isConsignment,
      consignmentVendor: p.consignmentVendor || null,
      consignmentRate: p.consignmentRate ?? null,
      lastVendor: p.lastVendor || null,
      lastVendorName: p.lastVendorName || '',
      match: scan ? { variantId: scan.variantId || null, kind: scan.kind } : null,
      branchId,
      units: units.map(({ unit, variantId, label }) => {
        const def = defaultReturnCost(prices, p, unit, variantId);
        return {
          variantId,
          label,
          code: unit.shortCode || unit.sku || '',
          price: unit.price ?? p.price,
          costPrice: unit.costPrice ?? p.costPrice ?? null,
          stock: branchId ? unitAvailable(unit, branchId, mainBranchId) : Number(unit.stock) || 0,
          vendorLastPrice: prices.has(unitKey(p._id, variantId)) ? prices.get(unitKey(p._id, variantId)).price : null,
          defaultUnitCost: def.unitCost,
          defaultCostSource: def.source,
          shelves: shelfRows
            .filter((r) => String(r.product) === String(p._id) && (r.variantId || null) === variantId)
            .map((r) => ({ shelfId: r.shelf, code: r.shelfCode, qty: r.qty })),
        };
      }),
    };
  });
}

module.exports = { unitKey, vendorLastPrices, defaultReturnCost, search };
