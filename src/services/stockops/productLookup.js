// src/services/stockops/productLookup.js
// Find the unit (product / variant) behind a scanned barcode or a typed name,
// with what the stock-ops screens need: pieces in the branch, shelves holding
// it, warehouse qty, average cost and last vendor.
const Product = require('../../models/product');
const LocationStock = require('../../models/locationStock');
const { findProductByCode, normalizeCode, variantLabel } = require('../../helper/productCodes');
const { httpError, toObjectId, escapeRegex, unitAvailable, unitSnapshot, pickUnit } = require('./common');

const SELECT =
  'name category productType price costPrice stock shortCode sku thumbnailUrl lastVendor lastVendorName branchStock batches.branch batches.quantity ' +
  'variants.variantId variants._id variants.color variants.size variants.attributes variants.price variants.costPrice variants.stock variants.shortCode ' +
  'variants.sku variants.branchStock variants.batches.branch variants.batches.quantity variants.lastVendor variants.lastVendorName';

/** Shelf rows of a unit in a branch: [{ shelfId, code, qty }] */
async function shelvesOf(branchId, productId, variantId) {
  const rows = await LocationStock.find({
    branch: toObjectId(branchId),
    product: toObjectId(productId),
    variantId: variantId || null,
    qty: { $gt: 0 },
  })
    .sort({ firstPlacedAt: 1 })
    .lean();
  return rows.map((r) => ({ shelfId: String(r.shelf), code: r.shelfCode || '', qty: Number(r.qty) || 0 }));
}

/** Plain description of one unit in a branch. */
async function describeUnit(product, picked, branchId, { withShelves = true } = {}) {
  const snap = unitSnapshot(product, picked);
  const available = await unitAvailable(picked.unit, branchId);
  const shelves = withShelves ? await shelvesOf(branchId, product._id, picked.variantId) : [];
  const shelved = shelves.reduce((s, x) => s + x.qty, 0);
  return {
    productId: String(product._id),
    variantId: picked.variantId,
    name: snap.productName,
    variantLabel: snap.variantLabel,
    category: snap.category,
    code: snap.code,
    thumbnailUrl: product.thumbnailUrl || null,
    price: snap.salePrice,
    costPrice: snap.unitCost,
    vendorId: snap.vendor ? String(snap.vendor) : null,
    vendorName: snap.vendorName,
    available,
    shelves,
    warehouse: Math.max(0, available - shelved),
  };
}

/**
 * Scanned / typed code -> unit in `branchId`.
 * When the code names a variant product but not one variant, returns
 * { needsVariant: true, variants: [...] } so the screen can ask which one.
 */
async function lookupCode(rawCode, branchId) {
  const code = normalizeCode(rawCode);
  if (!code) throw httpError('Scan or type a code', 400);
  const found = await findProductByCode(code);
  if (!found) throw httpError(`No product uses the code "${code}"`, 404, 'CODE_NOT_FOUND');
  const product = typeof found.product.toObject === 'function' ? found.product.toObject() : found.product;
  const m = found.match || {};
  const base = { scannedCode: code, batchNo: m.batchNo || null, packQty: Math.max(1, Number(m.qty) || 1) };

  const picked = pickUnit(product, m.variantId, { required: false });
  if (!picked) {
    const variants = [];
    for (const v of product.variants || []) {
      variants.push(await describeUnit(product, { unit: v, variant: v, variantId: String(v.variantId) }, branchId));
    }
    return { ...base, needsVariant: true, productId: String(product._id), name: product.name, variants };
  }
  return { ...base, needsVariant: false, ...(await describeUnit(product, picked, branchId)) };
}

/** Units matching a name / code (variants listed one by one). */
async function searchUnits(search, branchId, { limit = 15 } = {}) {
  const q = String(search || '').trim();
  if (!q) return [];
  const rx = new RegExp(escapeRegex(q), 'i');
  const products = await Product.find({ $or: [{ name: rx }, { scanCodes: normalizeCode(q) }, { 'variants.sku': rx }] })
    .select(SELECT)
    .limit(Math.min(50, Math.max(1, limit)))
    .lean();
  // Shelf rows of every found product in one query.
  const rows = products.length
    ? await LocationStock.find({ branch: toObjectId(branchId), product: { $in: products.map((p) => p._id) }, qty: { $gt: 0 } })
        .sort({ firstPlacedAt: 1 })
        .lean()
    : [];
  const out = [];
  for (const p of products) {
    const units =
      p.productType === 'variant'
        ? (p.variants || []).map((v) => ({ unit: v, variant: v, variantId: String(v.variantId) }))
        : [{ unit: p, variant: null, variantId: null }];
    for (const u of units) {
      const d = await describeUnit(p, u, branchId, { withShelves: false });
      d.shelves = rows
        .filter((r) => String(r.product) === String(p._id) && (r.variantId || null) === u.variantId)
        .map((r) => ({ shelfId: String(r.shelf), code: r.shelfCode || '', qty: Number(r.qty) || 0 }));
      d.warehouse = Math.max(0, d.available - d.shelves.reduce((s, x) => s + x.qty, 0));
      out.push(d);
    }
  }
  return out.slice(0, 60);
}

module.exports = { lookupCode, searchUnits, describeUnit, shelvesOf, variantLabel };
