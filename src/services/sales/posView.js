// src/services/sales/posView.js
// What the POS screen may show to whom, plus shelf codes for product results.
//
//   orderForViewer(order, access)   -> plain order; cost / cogs / profit only for `dashboard` viewers
//   productForViewer(product, access) -> plain product without landed costs for cashiers
//   await attachShelfCodes(products, branchId) -> adds shelfCodes ['A1-S2', ...] (product + variants)
const mongoose = require('mongoose');
const LocationStock = require('../../models/locationStock');
const { canSeeCost, round2 } = require('./pricingService');

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc);

// Purchase / cost fields cashiers do not need to see.
const COST_FIELDS = ['costPrice', 'lastPurchasePrice', 'lastLandedCost', 'firstPurchasePrice', 'lastVendor', 'lastVendorName', 'consignmentRate'];

function stripUnitCosts(unit) {
  if (!unit || typeof unit !== 'object') return unit;
  const out = { ...unit };
  for (const f of COST_FIELDS) delete out[f];
  if (Array.isArray(out.batches)) out.batches = out.batches.map(({ costPrice, ...b }) => b); // eslint-disable-line no-unused-vars
  return out;
}

function productForViewer(product, access) {
  const p = toPlain(product);
  if (!p || canSeeCost(access)) return p;
  const out = stripUnitCosts(p);
  if (Array.isArray(out.variants)) out.variants = out.variants.map(stripUnitCosts);
  return out;
}

function orderForViewer(order, access) {
  const o = toPlain(order);
  if (!o) return o;
  if (canSeeCost(access)) {
    o.profit = round2((Number(o.total) || 0) - (Number(o.tax) || 0) - (Number(o.cogs) || 0));
    return o;
  }
  delete o.cogs;
  delete o.giftCost;
  delete o.profit;
  o.items = (o.items || []).map(({ costPrice, ...rest }) => { // eslint-disable-line no-unused-vars
    if (rest.product && typeof rest.product === 'object') rest.product = stripUnitCosts(rest.product);
    return rest;
  });
  return o;
}

/**
 * Shelf codes of many products in one query (this branch only, shelves with
 * pieces or a home shelf). Home shelf first, then most pieces.
 * Returns Map "<productId>|<variantId or ''>" -> [{ code, qty, isHome }].
 */
async function shelfCodeMap(productIds, branchId) {
  const ids = [...new Set((productIds || []).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!ids.length || !branchId || !mongoose.Types.ObjectId.isValid(String(branchId))) return new Map();
  const rows = await LocationStock.find({
    branch: new mongoose.Types.ObjectId(String(branchId)),
    product: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    $or: [{ qty: { $gt: 0 } }, { isHome: true }],
  })
    .select('product variantId shelfCode qty isHome')
    .lean();
  const map = new Map();
  for (const r of rows) {
    const key = `${r.product}|${r.variantId || ''}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ code: r.shelfCode, qty: Number(r.qty) || 0, isHome: !!r.isHome });
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.isHome) - Number(a.isHome) || b.qty - a.qty);
  return map;
}

const codesOf = (list) => [...new Set((list || []).map((s) => s.code).filter(Boolean))];

/** Adds `shelfCodes` to each product (all its units) and to each variant. Mutates + returns the list. */
async function attachShelfCodes(products, branchId) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return list;
  let map;
  try {
    map = await shelfCodeMap(list.map((p) => p._id), branchId);
  } catch (err) {
    console.error('[pos] shelf codes failed:', err.message);
    return list;
  }
  for (const p of list) {
    if (p.productType === 'variant') {
      const all = [];
      p.variants = (p.variants || []).map((v) => {
        const shelves = map.get(`${p._id}|${v.variantId}`) || [];
        all.push(...shelves);
        return { ...v, shelfCodes: codesOf(shelves) };
      });
      p.shelfCodes = codesOf(all);
    } else {
      p.shelfCodes = codesOf(map.get(`${p._id}|`));
    }
  }
  return list;
}

module.exports = { productForViewer, orderForViewer, shelfCodeMap, attachShelfCodes, stripUnitCosts };
