// src/services/sales/priceTierService.js
// Dollar-store price points (models/priceTier.js).
//
//   list / detail / create / update / remove
//   assign(tierId, productIds)  -> product.priceTier = tier, sale price = tier price (all variants)
//   unassign(productIds)        -> product.priceTier = null (price stays as it is)
//   update(...price)            -> every linked product is re-priced
// Every sale-price change is logged with priceHistoryService.log({ source: 'price_tier' }).
// Margins use the weighted-average landed cost (product/variant costPrice).
const mongoose = require('mongoose');
const PriceTier = require('../../models/priceTier');
const Product = require('../../models/product');
const priceHistory = require('../priceHistoryService');
const config = require('../configService');
const { round2, httpError, unitSalePrice, unitCost } = require('./pricingService');

const DEFAULT_LOW_MARGIN_PCT = 20;
const MAX_BULK = 1000;
const HEX = /^#[0-9a-f]{3,8}$/i;

const isOid = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function lowMarginPct() {
  const v = Number(await config.get('pricing.lowMarginPct', DEFAULT_LOW_MARGIN_PCT));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_LOW_MARGIN_PCT;
}

function cleanIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(isOid);
  if (!list.length) throw httpError(400, 'Pick at least one product', 'NO_PRODUCTS');
  if (list.length > MAX_BULK) throw httpError(400, `At most ${MAX_BULK} products at a time`, 'TOO_MANY');
  return list;
}

/** Validated tier fields from a request body. `partial` = only what was sent (PUT). */
function readTierInput(body = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Name is required (e.g. "Rs 280")', 'NAME_REQUIRED');
    out.name = name.slice(0, 60);
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw httpError(400, 'Price must be more than 0', 'INVALID_PRICE');
    out.price = round2(price);
  }
  if (body.color !== undefined) {
    const color = String(body.color || '').trim();
    if (color && !HEX.test(color)) throw httpError(400, 'Colour must look like #F59E0B', 'INVALID_COLOR');
    out.color = color || '#F59E0B';
  }
  if (body.sortOrder !== undefined) out.sortOrder = Math.round(Number(body.sortOrder) || 0);
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === 'true';
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 500);
  return out;
}

async function loadTier(id) {
  if (!isOid(id)) throw httpError(404, 'Price tier not found');
  const tier = await PriceTier.findById(id).lean();
  if (!tier) throw httpError(404, 'Price tier not found');
  return tier;
}

async function ensureUniqueName(name, excludeId = null) {
  const q = { name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } };
  if (excludeId) q._id = { $ne: excludeId };
  if (await PriceTier.exists(q)) throw httpError(409, `A tier named "${name}" already exists`, 'DUPLICATE_NAME');
}

/** { tierId: count } of linked products. */
async function productCounts(tierIds) {
  if (!tierIds.length) return {};
  const rows = await Product.aggregate([
    { $match: { isDeleted: { $ne: true }, priceTier: { $in: tierIds.map(oid) } } },
    { $group: { _id: '$priceTier', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
}

async function list({ search = '', isActive, page = 1, limit = 100 } = {}) {
  const q = {};
  if (search) q.name = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
  if (isActive === 'true' || isActive === true) q.isActive = true;
  if (isActive === 'false' || isActive === false) q.isActive = false;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
  const [total, tiers] = await Promise.all([
    PriceTier.countDocuments(q),
    PriceTier.find(q).sort({ sortOrder: 1, price: 1 }).skip((p - 1) * l).limit(l).lean(),
  ]);
  const counts = await productCounts(tiers.map((t) => String(t._id)));
  return {
    data: tiers.map((t) => ({ ...t, productCount: counts[String(t._id)] || 0 })),
    meta: { page: p, limit: l, total, pages: Math.max(1, Math.ceil(total / l)) },
  };
}

async function create(body, { userId } = {}) {
  const input = readTierInput(body);
  await ensureUniqueName(input.name);
  const tier = await PriceTier.create({ ...input, createdBy: userId || null, updatedBy: userId || null });
  return { ...tier.toObject(), productCount: 0 };
}

// ---------------------------------------------------------------- re-pricing

const PRODUCT_PRICE_FIELDS = 'name price discountedPrice productType priceTier variants.variantId variants.price variants.discountedPrice';

/**
 * Link products to `tier` (when `link`) and set their sale price to tier.price.
 * Variant products: every variant. discountedPrice (the "sale price" the form
 * keeps equal to price) follows when it is set. Logs every changed price.
 */
async function repriceProducts(products, tier, { userId = null, link = true } = {}) {
  if (!products.length) return 0;
  const P = round2(tier.price);
  const now = new Date();
  const ops = [];
  for (const p of products) {
    const set = { price: P, updatedAt: now };
    if (link) set.priceTier = tier._id;
    if (Number(p.discountedPrice) > 0) set.discountedPrice = P;
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } });
    if (p.productType === 'variant' && (p.variants || []).length) {
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { 'variants.$[].price': P } } } });
      ops.push({
        updateOne: {
          filter: { _id: p._id },
          update: { $set: { 'variants.$[d].discountedPrice': P } },
          arrayFilters: [{ 'd.discountedPrice': { $gt: 0 } }],
        },
      });
    }
  }
  await Product.bulkWrite(ops, { ordered: false });

  // Price history: one row per unit whose price really changed.
  const logs = [];
  const base = { source: 'price_tier', refType: 'PriceTier', refId: tier._id, userId, note: `Price tier ${tier.name}` };
  for (const p of products) {
    const units = p.productType === 'variant' ? p.variants || [] : [p];
    for (const u of units) {
      const variantId = p.productType === 'variant' ? u.variantId : null;
      logs.push({ ...base, productId: p._id, variantId, productName: p.name, field: 'price', oldValue: u.price, newValue: P });
      if (Number(u.discountedPrice) > 0) {
        logs.push({ ...base, productId: p._id, variantId, productName: p.name, field: 'discountedPrice', oldValue: u.discountedPrice, newValue: P });
      }
    }
  }
  for (let i = 0; i < logs.length; i += 25) {
    await Promise.all(logs.slice(i, i + 25).map((row) => priceHistory.log(row))); // log() never throws, skips unchanged
  }
  return products.length;
}

async function assign(tierId, productIds, { userId } = {}) {
  const tier = await loadTier(tierId);
  if (!tier.isActive) throw httpError(400, 'This tier is switched off. Switch it on first.', 'TIER_INACTIVE');
  const ids = cleanIds(productIds);
  const products = await Product.find({ _id: { $in: ids } }).select(PRODUCT_PRICE_FIELDS).lean();
  if (!products.length) throw httpError(404, 'No products found', 'NO_PRODUCTS');
  const moved = products.filter((p) => p.priceTier && String(p.priceTier) !== String(tier._id)).length;
  const updated = await repriceProducts(products, tier, { userId, link: true });
  return { tier, updated, movedFromOtherTier: moved };
}

async function unassign(productIds, { tierId = null } = {}) {
  const ids = cleanIds(productIds);
  const q = { _id: { $in: ids }, priceTier: { $ne: null } };
  if (isOid(tierId)) q.priceTier = oid(tierId);
  const r = await Product.updateMany(q, { $set: { priceTier: null } });
  return { updated: r.modifiedCount || 0 };
}

async function update(id, body, { userId } = {}) {
  const tier = await loadTier(id);
  const input = readTierInput(body, { partial: true });
  if (input.name && input.name.toLowerCase() !== String(tier.name).toLowerCase()) await ensureUniqueName(input.name, tier._id);
  const saved = await PriceTier.findByIdAndUpdate(tier._id, { $set: { ...input, updatedBy: userId || null } }, { new: true }).lean();
  let repriced = 0;
  if (input.price !== undefined && round2(input.price) !== round2(tier.price)) {
    const linked = await Product.find({ priceTier: tier._id }).select(PRODUCT_PRICE_FIELDS).lean();
    repriced = await repriceProducts(linked, saved, { userId, link: false });
  }
  const counts = await productCounts([String(saved._id)]);
  return { tier: { ...saved, productCount: counts[String(saved._id)] || 0 }, repriced };
}

/** Soft-delete the tier; linked products keep their price but lose the link. */
async function remove(id, { userId } = {}) {
  const tier = await loadTier(id);
  const r = await Product.updateMany({ priceTier: tier._id }, { $set: { priceTier: null } });
  await PriceTier.softDeleteById(tier._id, userId || null);
  return { unlinked: r.modifiedCount || 0 };
}

// ---------------------------------------------------------------- margins

/** Margin of one product at its sale price vs average landed cost (worst unit decides the flag). */
function productMargin(p, lowPct) {
  const units = p.productType === 'variant' && (p.variants || []).length ? p.variants : [p];
  const priced = units.map((u) => ({ price: unitSalePrice(u, p.price), cost: unitCost(u, p) }));
  const price = round2(priced.reduce((s, u) => s + u.price, 0) / priced.length);
  const known = priced.filter((u) => u.cost !== null);
  if (!known.length) return { price, cost: null, margin: null, marginPct: null, flag: 'no_cost' };
  const cost = round2(known.reduce((s, u) => s + u.cost, 0) / known.length);
  const margin = round2(price - cost);
  const pctOf = (u) => (u.price > 0 ? ((u.price - u.cost) / u.price) * 100 : -100);
  const worstPct = Math.min(...known.map(pctOf));
  const flag = known.some((u) => u.price - u.cost < 0) ? 'negative' : worstPct < lowPct ? 'low' : 'ok';
  return { price, cost, margin, marginPct: price > 0 ? round2((margin / price) * 100) : null, flag };
}

const FLAG_ORDER = { negative: 0, low: 1, no_cost: 2, ok: 3 };

/** Tier + its products with margins. ?flag=negative|low|ok|no_cost, ?search, paginated (worst first). */
async function detail(id, { search = '', flag = '', page = 1, limit = 50 } = {}) {
  const tier = await loadTier(id);
  const lowPct = await lowMarginPct();
  const q = { priceTier: tier._id };
  const products = await Product.find(q)
    .select('name category productType price discountedPrice costPrice stock shortCode sku thumbnailUrl status variants.variantId variants.color variants.size variants.price variants.discountedPrice variants.costPrice variants.stock')
    .lean();
  const rows = products.map((p) => ({
    _id: p._id,
    name: p.name,
    category: p.category,
    productType: p.productType,
    shortCode: p.shortCode,
    sku: p.sku,
    thumbnailUrl: p.thumbnailUrl,
    status: p.status,
    stock: Number(p.stock) || 0,
    variantCount: p.productType === 'variant' ? (p.variants || []).length : 0,
    priceMatchesTier: (p.productType === 'variant' && (p.variants || []).length ? p.variants : [p]).every(
      (u) => unitSalePrice(u, p.price) === round2(tier.price)
    ),
    ...productMargin(p, lowPct),
  }));
  const summary = { productCount: rows.length, negative: 0, low: 0, ok: 0, noCost: 0, avgMarginPct: null, lowMarginPct: lowPct };
  for (const r of rows) {
    if (r.flag === 'no_cost') summary.noCost++;
    else summary[r.flag]++;
  }
  const withPct = rows.filter((r) => r.marginPct !== null);
  if (withPct.length) summary.avgMarginPct = round2(withPct.reduce((s, r) => s + r.marginPct, 0) / withPct.length);

  let filtered = rows;
  if (search) {
    const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
    filtered = filtered.filter((r) => rx.test(r.name) || rx.test(r.category || '') || rx.test(r.shortCode || '') || rx.test(r.sku || ''));
  }
  if (flag && FLAG_ORDER[flag] !== undefined) filtered = filtered.filter((r) => r.flag === flag);
  filtered.sort((a, b) => FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag] || (a.marginPct ?? 1e9) - (b.marginPct ?? 1e9) || a.name.localeCompare(b.name));

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  return {
    tier: { ...tier, productCount: rows.length },
    summary,
    products: filtered.slice((p - 1) * l, p * l),
    meta: { page: p, limit: l, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / l)) },
  };
}

/** Product search for the "assign products" picker: price, cost, margin at the tier price, current tier. */
async function candidates({ search = '', tierId = null, notInTier = true, page = 1, limit = 25 } = {}) {
  const q = {};
  const s = String(search || '').trim();
  if (s) {
    const rx = { $regex: escapeRegex(s), $options: 'i' };
    q.$or = [{ name: rx }, { category: rx }, { sku: rx }, { shortCode: rx }, { 'variants.sku': rx }, { scanCodes: s.toUpperCase() }];
  }
  let tier = null;
  if (isOid(tierId)) {
    tier = await loadTier(tierId);
    if (notInTier === true || notInTier === 'true') q.priceTier = { $ne: tier._id };
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [total, products] = await Promise.all([
    Product.countDocuments(q),
    Product.find(q)
      .select('name category productType price discountedPrice costPrice stock shortCode sku priceTier thumbnailUrl variants.variantId variants.price variants.discountedPrice variants.costPrice')
      .sort({ name: 1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate('priceTier', 'name price color')
      .lean(),
  ]);
  const lowPct = await lowMarginPct();
  const data = products.map((prod) => {
    const now = productMargin(prod, lowPct);
    const atTier = tier ? productMargin(withPrice(prod, tier.price), lowPct) : null;
    return {
      _id: prod._id,
      name: prod.name,
      category: prod.category,
      productType: prod.productType,
      shortCode: prod.shortCode,
      sku: prod.sku,
      thumbnailUrl: prod.thumbnailUrl,
      stock: Number(prod.stock) || 0,
      variantCount: prod.productType === 'variant' ? (prod.variants || []).length : 0,
      priceTier: prod.priceTier || null,
      price: now.price,
      cost: now.cost,
      marginPct: now.marginPct,
      atTier: atTier ? { price: atTier.price, margin: atTier.margin, marginPct: atTier.marginPct, flag: atTier.flag } : null,
    };
  });
  return { data, meta: { page: p, limit: l, total, pages: Math.max(1, Math.ceil(total / l)) } };
}

// A copy of a product priced at `price` (for "margin if moved to this tier").
function withPrice(p, price) {
  const set = (u) => ({ ...u, price, discountedPrice: undefined });
  return p.productType === 'variant' ? { ...set(p), variants: (p.variants || []).map(set) } : set(p);
}

/** Tier of one product (ProductForm). */
async function tierOfProduct(productId) {
  if (!isOid(productId)) throw httpError(404, 'Product not found');
  const p = await Product.findById(productId).select('priceTier').populate('priceTier', 'name price color isActive').lean();
  if (!p) throw httpError(404, 'Product not found');
  return p.priceTier || null;
}

module.exports = {
  list,
  create,
  update,
  remove,
  assign,
  unassign,
  detail,
  candidates,
  tierOfProduct,
  productMargin,
  readTierInput,
  loadTier,
};
