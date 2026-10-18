// src/services/priceHistoryService.js
// Log sale-price / cost changes (models/priceChange.js). Never throws.
//
//   await priceHistory.log({ productId, variantId, productName, field: 'price',
//     oldValue: 250, newValue: 280, source: 'price_tier', refType: 'PriceTier', refId, userId });
//
//   await priceHistory.logProductDiff(before, after, { source: 'product_form', userId })
//     compares two plain products (and their variants) and logs every change
//     of price / costPrice / discountedPrice.
const PriceChange = require('../models/priceChange');

const FIELDS = ['price', 'costPrice', 'discountedPrice'];
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function log({ productId, variantId = null, productName = '', field, oldValue, newValue, source = 'other', refType = '', refId = null, note = '', userId = null, changedAt }) {
  try {
    const o = num(oldValue);
    const n = num(newValue);
    if (!productId || !FIELDS.includes(field) || o === n) return null;
    const row = await PriceChange.create({
      product: productId,
      variantId: variantId ? String(variantId) : null,
      productName,
      field,
      oldValue: o,
      newValue: n,
      source,
      refType,
      refId: refId || null,
      note,
      user: userId || null,
      changedAt: changedAt ? new Date(changedAt) : new Date(),
    });
    return row.toObject();
  } catch (err) {
    console.error('[price-history] log failed:', err.message);
    return null;
  }
}

async function logProductDiff(before, after, { source = 'product_form', userId = null, refType = '', refId = null } = {}) {
  if (!before || !after) return 0;
  let count = 0;
  const name = after.name || before.name || '';
  for (const f of FIELDS) {
    if (await log({ productId: after._id || before._id, productName: name, field: f, oldValue: before[f], newValue: after[f], source, userId, refType, refId })) count++;
  }
  const oldVariants = new Map((before.variants || []).map((v) => [String(v.variantId), v]));
  for (const v of after.variants || []) {
    const old = oldVariants.get(String(v.variantId));
    if (!old) continue;
    for (const f of FIELDS) {
      if (await log({ productId: after._id, variantId: v.variantId, productName: name, field: f, oldValue: old[f], newValue: v[f], source, userId, refType, refId })) count++;
    }
  }
  return count;
}

/** Changes of one unit, newest first. */
async function list(productId, { variantId = null, field = null, limit = 100 } = {}) {
  const match = { product: productId };
  if (variantId) match.variantId = String(variantId);
  if (field) match.field = field;
  return PriceChange.find(match).sort({ changedAt: -1 }).limit(Math.min(500, limit)).lean();
}

module.exports = { log, logProductDiff, list, FIELDS };
