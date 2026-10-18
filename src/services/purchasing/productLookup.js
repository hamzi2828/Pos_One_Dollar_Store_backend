// src/services/purchasing/productLookup.js
// Products for purchase-order lines: search / scan, unit snapshot (price, cost,
// last purchase price, pieces per box) and "new product from a PO line".
const Product = require('../../models/product');
const {
  normalizeCode,
  variantLabel,
  listUnits,
  findProductByCode,
  unitBranchStock,
  unitTotalStock,
  getMainBranchId,
  PRODUCT_UNIT,
} = require('../../helper/productCodes');
const { unitKey } = require('./costing');
const { httpError, escapeRegex, isId, toText, toAmount } = require('./helpers');

const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const numOrNull = (n) => (n === undefined || n === null || !Number.isFinite(Number(n)) ? null : Number(n));

// POS price of a unit: discounted price when set and lower, else price.
const salePriceOf = (unit) => {
  const price = num(unit.price);
  const disc = num(unit.discountedPrice);
  return disc > 0 && disc < price ? disc : price;
};

/** Find the unit of a product (null = single product / only variant). */
function pickUnit(product, variantId) {
  if (product.productType !== 'variant') return { unit: product, variant: null };
  const variants = product.variants || [];
  let v = null;
  if (variantId) v = variants.find((x) => String(x.variantId) === String(variantId) || String(x._id) === String(variantId));
  else if (variants.length === 1) v = variants[0];
  return v ? { unit: v, variant: v } : null;
}

/** Everything a PO / costing screen needs about one unit. */
function unitInfo(product, variant, { branchId = null, mainBranchId = null } = {}) {
  const unit = variant || product;
  const label = variant ? variantLabel(variant) : '';
  return {
    productId: product._id,
    variantId: variant ? String(variant.variantId) : null,
    name: product.name,
    variantLabel: label,
    productName: label ? `${product.name} (${label})` : product.name,
    code: unit.shortCode || unit.sku || '',
    sku: unit.sku || '',
    category: product.category || '',
    thumbnailUrl: product.thumbnailUrl || null,
    price: num(unit.price),
    salePrice: salePriceOf(unit),
    costPrice: numOrNull(unit.costPrice),
    lastPurchasePrice: numOrNull(unit.lastPurchasePrice),
    lastLandedCost: numOrNull(unit.lastLandedCost),
    lastVendorName: unit.lastVendorName || product.lastVendorName || '',
    piecesPerBox: Math.max(1, Math.floor(num(product.piecesPerBox)) || 1),
    stockTotal: unitTotalStock(unit),
    branchStock: branchId ? unitBranchStock(unit, branchId, mainBranchId) : unitTotalStock(unit),
    isDeleted: !!product.isDeleted,
  };
}

/**
 * Load one unit for a new PO line. Throws 404 / 400 with a clear message.
 */
async function loadUnit(productId, variantId, opts = {}) {
  if (!isId(productId)) throw httpError('Choose a product for this line');
  const product = await Product.findById(productId).lean();
  if (!product) throw httpError('Product not found', 404);
  const picked = pickUnit(product, variantId);
  if (!picked) {
    throw httpError(variantId ? `Variant not found on ${product.name}` : `Choose a variant of ${product.name}`, 400);
  }
  const mainBranchId = opts.mainBranchId || (await getMainBranchId());
  return unitInfo(product, picked.variant, { ...opts, mainBranchId });
}

/** Map unitKey -> unitInfo for every line of a PO / GRN (deleted products included). */
async function loadUnitsFor(lines, { branchId = null } = {}) {
  const ids = [...new Set(lines.map((l) => String(l.product && l.product._id ? l.product._id : l.product)).filter(isId))];
  const out = new Map();
  if (!ids.length) return out;
  const products = await Product.find({ _id: { $in: ids } }).setOptions({ withDeleted: true }).lean();
  const mainBranchId = await getMainBranchId();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  for (const l of lines) {
    const p = byId.get(String(l.product && l.product._id ? l.product._id : l.product));
    if (!p) continue;
    const picked = pickUnit(p, l.variantId);
    if (!picked) continue;
    out.set(unitKey(p._id, l.variantId), unitInfo(p, picked.variant, { branchId, mainBranchId }));
  }
  return out;
}

/**
 * Search products for PO lines by name / short code / SKU / any scan code,
 * or load given ids (`ids` = "a,b,c", e.g. from the demand report).
 * Variant products are listed one row per variant.
 */
async function searchUnits({ search = '', ids = '', branchId = null, limit = 20 } = {}) {
  const max = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const mainBranchId = await getMainBranchId();
  const rows = [];
  const seen = new Set();
  const push = (product, variant) => {
    const key = unitKey(product._id, variant ? variant.variantId : null);
    if (seen.has(key) || rows.length >= max) return;
    seen.add(key);
    rows.push(unitInfo(product, variant, { branchId, mainBranchId }));
  };
  const pushAll = (product) => {
    for (const { key, variant } of listUnits(product)) push(product, key === PRODUCT_UNIT ? null : variant);
  };

  const idList = String(ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(isId)
    .slice(0, 100);
  if (idList.length) {
    const products = await Product.find({ _id: { $in: idList } }).lean();
    const order = new Map(idList.map((id, i) => [id, i]));
    products.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
    const all = [];
    for (const p of products) {
      for (const { key, variant } of listUnits(p)) all.push(unitInfo(p, key === PRODUCT_UNIT ? null : variant, { branchId, mainBranchId }));
    }
    return all;
  }

  const q = String(search || '').trim();
  if (!q) return [];

  // 1. Exact code (barcode / short code / SKU / batch) -> that unit first.
  const hit = await findProductByCode(q);
  if (hit && hit.product) {
    const p = hit.product.toObject ? hit.product.toObject() : hit.product;
    if (hit.match && hit.match.variantId) {
      const v = (p.variants || []).find((x) => String(x.variantId) === String(hit.match.variantId));
      if (v) push(p, v);
    } else {
      pushAll(p);
    }
  }

  // 2. Name / code prefix matches.
  const rx = new RegExp(escapeRegex(q), 'i');
  const codeRx = new RegExp(`^${escapeRegex(normalizeCode(q))}`);
  const products = await Product.find({
    $or: [{ name: rx }, { scanCodes: codeRx }, { sku: rx }, { 'variants.sku': rx }],
  })
    .sort({ name: 1 })
    .limit(max)
    .lean();
  for (const p of products) pushAll(p);
  return rows;
}

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'product';

/**
 * Create a NEW single product from a PO line (stock 0 — stock comes from the
 * GRN). Reuses the normal product create service, so short code, SKU and scan
 * codes are generated exactly as on the product form.
 */
async function createProductForLine(input, { branchId }) {
  const name = toText(input.name, 200);
  const category = toText(input.category, 100);
  if (!name) throw httpError('Product name is required');
  if (!category) throw httpError('Category is required');
  const price = toAmount(input.salePrice ?? input.price, 'Sale price');
  if (!(price > 0)) throw httpError('Sale price must be more than 0');
  const piecesPerBox = toAmount(input.piecesPerBox, 'Pieces per box', { int: true, fallback: 1, min: 1 });

  const createProductService = require('../products/createProductService');
  const random = Math.random().toString(36).slice(2, 7);
  const created = await createProductService.createProduct(
    {
      name,
      slug: `${slugify(name)}-${random}`,
      category,
      price,
      stock: 0,
      piecesPerBox,
      // 0 stock: receiving the GRN republishes it automatically
      status: 'out_of_stock',
    },
    {},
    { branchId, warnings: [] }
  );
  const plain = created.toObject ? created.toObject() : created;
  return unitInfo(plain, null, { branchId, mainBranchId: await getMainBranchId() });
}

module.exports = { salePriceOf, pickUnit, unitInfo, loadUnit, loadUnitsFor, searchUnits, createProductForLine };
