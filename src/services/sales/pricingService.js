// src/services/sales/pricingService.js
// Server-side bill pricing for the POS. The browser NEVER decides money:
// POST /api/pos/quote (cart preview) and POST /api/pos/orders (the sale) both
// call computeBill(), so the cashier always sees exactly what will be charged.
//
//   const pricing = require('../services/sales/pricingService');
//   const bill = await pricing.computeBill({ items, branchId, access, manualDiscount, taxIds });
//   bill = { lines, subtotal, appliedDiscounts, discount, tax, appliedTaxes, total,
//            cogs, giftCost, nextDiscount, limits, ... }
//
// Rules:
//   - Stock line price = the unit's sale price in the DB. A typed price is used
//     only when the line says priceOverride and the user has `pos` 'edit'
//     (going BELOW the list price also needs `discounts` 'edit').
//   - Line cost = the unit's weighted-average landed cost (client value ignored).
//   - Gift lines (isGift) need `pos_gifts` 'create' + a reason; they sell at 0
//     but their cost still counts in cogs (and giftCost).
//   - Subtotal = sale lines only (gifts excluded). Discount rules: best
//     non-stackable + all stackable. Manual discount on top, limited to config
//     "pos.maxManualDiscountPct" (default 10) of the subtotal unless `discounts` 'edit'.
//   - Tax on (subtotal - discount), from the store settings taxes the cashier picked.
const mongoose = require('mongoose');
const Product = require('../../models/product');
const DiscountRule = require('../../models/discountRule');
const Settings = require('../../models/settings');
const config = require('../configService');
const { findProductByCode, resolveScan, variantLabel, normalizeCode, getMainBranchId, unitBranchStock } = require('../../helper/productCodes');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const isNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const isOid = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const idOf = (v) => (v && v._id ? v._id : v);

const MAX_LINES = 300;
const DEFAULT_MAX_MANUAL_PCT = 10;

function httpError(status, message, code, extra = {}) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
}

const canDo = (access, key, action = 'view') => !!access && typeof access.can === 'function' && access.can(key, action);

/** Profit / cost numbers are only for people who can see the dashboard. */
const canSeeCost = (access) => canDo(access, 'dashboard', 'view');

const rs = (n) => `Rs ${Number(round2(n)).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

/** Sale price of a unit: the discounted (sale) price when set and lower, else the price. */
function unitSalePrice(unit, fallback = 0) {
  const price = isNum(unit && unit.price) ? Number(unit.price) : Number(fallback) || 0;
  const dp = isNum(unit && unit.discountedPrice) ? Number(unit.discountedPrice) : 0;
  return round2(dp > 0 && dp < price ? dp : price);
}

/** Weighted-average landed cost of a unit (variant falls back to the product). null = unknown. */
function unitCost(unit, product) {
  const c = isNum(unit && unit.costPrice) ? Number(unit.costPrice) : isNum(product && product.costPrice) ? Number(product.costPrice) : null;
  return c === null || c < 0 ? null : round4(c);
}

// ---------------------------------------------------------------- rules

/** "Spend Rs 5,000 get 10% off" / "10% off every bill" (max cap shown when set). */
function ruleLabel(rule) {
  const off = rule.valueType === 'percentage' ? `${Number(rule.value)}% off` : `${rs(rule.value)} off`;
  const cap = rule.valueType === 'percentage' && Number(rule.maxDiscount) > 0 ? ` (max ${rs(rule.maxDiscount)})` : '';
  if (rule.kind === 'threshold') return `Spend ${rs(rule.minSubtotal)} get ${off}${cap}`;
  return `${off} on every bill${cap}`;
}

/** Discount a rule gives on this subtotal (0 when not eligible). */
function ruleAmount(rule, subtotal) {
  const base = Number(subtotal) || 0;
  if (base <= 0) return 0;
  if (rule.kind === 'threshold' && base < (Number(rule.minSubtotal) || 0)) return 0;
  const value = Math.max(0, Number(rule.value) || 0);
  let amount = rule.valueType === 'percentage' ? (base * Math.min(100, value)) / 100 : value;
  if (Number(rule.maxDiscount) > 0) amount = Math.min(amount, Number(rule.maxDiscount));
  return round2(Math.max(0, Math.min(amount, base)));
}

/**
 * Pick the rules for a subtotal: the best non-stackable rule (largest amount,
 * then higher priority) plus every stackable rule. Never more than the subtotal.
 * Pure — also used by the admin "test a bill amount" calculator.
 */
function applyRules(rules, subtotal) {
  const scored = (rules || [])
    .map((rule) => ({ rule, amount: ruleAmount(rule, subtotal) }))
    .filter((x) => x.amount > 0);
  const exclusive = scored
    .filter((x) => !x.rule.stackable)
    .sort((a, b) => b.amount - a.amount || (b.rule.priority || 0) - (a.rule.priority || 0));
  const chosen = [...exclusive.slice(0, 1), ...scored.filter((x) => x.rule.stackable)].sort(
    (a, b) => (b.rule.priority || 0) - (a.rule.priority || 0) || b.amount - a.amount
  );
  let left = round2(subtotal);
  const applied = [];
  for (const x of chosen) {
    const amount = round2(Math.min(x.amount, left));
    if (amount <= 0) continue;
    left = round2(left - amount);
    applied.push({
      rule: x.rule._id || null,
      name: x.rule.name,
      kind: x.rule.kind,
      valueType: x.rule.valueType,
      value: Number(x.rule.value) || 0,
      amount,
      label: ruleLabel(x.rule),
    });
  }
  return applied;
}

/** The nearest threshold rule not reached yet that would beat today's rule discount (cart hint). */
function nextThreshold(rules, subtotal, currentRuleDiscount = 0) {
  const sub = Number(subtotal) || 0;
  const best = (rules || [])
    .filter((r) => r.kind === 'threshold' && sub < (Number(r.minSubtotal) || 0))
    .map((r) => ({ r, missing: round2(Number(r.minSubtotal) - sub), reward: ruleAmount(r, Number(r.minSubtotal)) }))
    .filter((c) => c.reward > currentRuleDiscount)
    .sort((a, b) => a.missing - b.missing || b.reward - a.reward)[0];
  if (!best) return null;
  const off = best.r.valueType === 'percentage' ? `${Number(best.r.value)}% off` : `${rs(best.r.value)} off`;
  return {
    rule: best.r._id || null,
    name: best.r.name,
    label: ruleLabel(best.r),
    minSubtotal: Number(best.r.minSubtotal) || 0,
    missing: best.missing,
    valueType: best.r.valueType,
    value: Number(best.r.value) || 0,
    message: `Add ${rs(best.missing)} more to get ${off}`,
  };
}

/** Rules running now. */
async function loadActiveRules(at = new Date()) {
  return DiscountRule.find({
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: at } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: at } }] },
    ],
  })
    .sort({ priority: -1, createdAt: 1 })
    .lean();
}

// ---------------------------------------------------------------- manual discount

/** { type, value, reason } | null. Accepts the legacy body too (discount amount + discountReason). */
function normalizeManualDiscount(input) {
  if (!input || typeof input !== 'object') return null;
  const type = input.type === 'percentage' ? 'percentage' : 'fixed';
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (type === 'percentage' && value > 100) throw httpError(400, 'Discount cannot be more than 100%', 'INVALID_DISCOUNT');
  return { type, value: round2(value), reason: String(input.reason || '').trim().slice(0, 200) };
}

async function manualLimits(access) {
  const pct = Number(await config.get('pos.maxManualDiscountPct', DEFAULT_MAX_MANUAL_PCT));
  return {
    maxManualDiscountPct: Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_MAX_MANUAL_PCT,
    unlimitedManualDiscount: canDo(access, 'discounts', 'edit'),
  };
}

// ---------------------------------------------------------------- taxes

async function loadTaxes() {
  const s = await Settings.getSettings();
  return ((s && s.taxes) || []).filter((t) => t && t.taxId && t.isActive !== false);
}

/** Tax ids picked by the cashier: `taxIds: [...]` or the legacy `appliedTaxes: [{ taxId }]`. */
function pickTaxIds(taxIds, appliedTaxes) {
  const raw = Array.isArray(taxIds) ? taxIds : Array.isArray(appliedTaxes) ? appliedTaxes.map((t) => t && t.taxId) : [];
  return [...new Set(raw.filter(Boolean).map(String))];
}

// ---------------------------------------------------------------- lines

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc);

/**
 * Turn the cart lines from the browser into priced lines. Loads every product
 * in one query; scanned codes fill product / variant / batch.
 */
async function resolveLines(rawItems, { branchId, access } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw httpError(400, 'Order must have at least one item', 'EMPTY_CART');
  if (rawItems.length > MAX_LINES) throw httpError(400, `A bill can have at most ${MAX_LINES} lines`, 'TOO_MANY_LINES');

  const ids = [...new Set(rawItems.map((r) => r && idOf(r.product)).filter(isOid).map(String))];
  const products = ids.length ? await Product.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const mainBranchId = await getMainBranchId();

  const lines = [];
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index] || {};
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw httpError(400, 'Item quantity must be a whole number of at least 1', 'INVALID_QUANTITY');
    }
    // ----- stock line: product + unit
    const productRef = idOf(raw.product);
    let product = productRef ? byId.get(String(productRef)) : null;
    let match = null;
    if (raw.scannedCode) {
      if (product) match = resolveScan(product, raw.scannedCode);
      else if (!productRef) {
        const found = await findProductByCode(raw.scannedCode);
        if (found) {
          product = toPlain(found.product);
          match = found.match;
        }
      }
    }
    if (!product) {
      throw httpError(404, `Product not found: ${productRef || raw.scannedCode || 'unknown'}`, 'PRODUCT_NOT_FOUND');
    }

    let unit = product;
    let variantId;
    if (product.productType === 'variant') {
      const variants = product.variants || [];
      let wanted = raw.variantId || (match && match.variantId) || null;
      if (!wanted && variants.length === 1) wanted = variants[0].variantId;
      unit = variants.find((v) => String(v.variantId) === String(wanted));
      if (!unit) throw httpError(400, `Pick a variant of ${product.name}`, 'VARIANT_REQUIRED');
      variantId = String(unit.variantId);
    }
    const label = variantLabel(product.productType === 'variant' ? unit : null);
    const name = label ? `${product.name} (${label})` : product.name;

    // ----- price
    const listPrice = unitSalePrice(unit, product.price);
    let price = listPrice;
    let priceOverride = false;
    if (raw.priceOverride === true && !raw.isGift) {
      const typed = Number(raw.price);
      if (!Number.isFinite(typed) || typed < 0) throw httpError(400, `Enter a valid price for ${name}`, 'INVALID_PRICE');
      if (round2(typed) !== listPrice) {
        if (!canDo(access, 'pos', 'edit')) {
          throw httpError(403, `You may not change the price of ${name}. Ask a manager.`, 'PRICE_EDIT_NOT_ALLOWED');
        }
        if (typed < listPrice && !canDo(access, 'discounts', 'edit')) {
          throw httpError(403, `${name} cannot be sold below ${rs(listPrice)}. Use a discount instead.`, 'PRICE_BELOW_LIST');
        }
        price = round2(typed);
        priceOverride = true;
      }
    }

    // ----- gift
    const isGift = !!raw.isGift;
    let giftReason;
    if (isGift) {
      if (!canDo(access, 'pos_gifts', 'create')) {
        throw httpError(403, 'You may not give gifts. Ask a manager.', 'GIFT_NOT_ALLOWED');
      }
      giftReason = String(raw.giftReason || '').trim().slice(0, 200);
      if (!giftReason) throw httpError(400, `Write why ${name} is a gift`, 'GIFT_REASON_REQUIRED');
      price = 0;
    }

    const cost = unitCost(unit, product);
    const batchNo = raw.batchNo || (match && match.batchNo) || undefined;
    lines.push({
      index,
      product: String(product._id),
      variantId,
      name,
      variantLabel: label,
      sku: unit.sku || product.sku || '',
      category: product.category || '',
      size: product.productType === 'variant' ? unit.size || undefined : raw.size || undefined,
      color: product.productType === 'variant' ? unit.color || undefined : raw.color || undefined,
      quantity,
      price,
      listPrice,
      priceOverride,
      costPrice: cost === null ? undefined : cost,
      discount: 0,
      scannedCode: raw.scannedCode ? normalizeCode(raw.scannedCode) : undefined,
      batchNo: batchNo ? normalizeCode(batchNo) : undefined,
      isGift,
      giftReason,
      priceTier: product.priceTier ? String(product.priceTier) : null,
      available: Math.max(0, Number(unitBranchStock(unit, branchId || null, mainBranchId)) || 0),
      lineTotal: round2(price * quantity),
    });
  }
  return lines;
}

/** Fields stored on POSOrder.items (models/posOrder.js). */
function toOrderItem(line) {
  return {
    product: line.product,
    variantId: line.variantId,
    quantity: line.quantity,
    price: line.price,
    discount: 0,
    sku: line.sku || '',
    costPrice: line.costPrice,
    size: line.size,
    color: line.color,
    category: line.category,
    scannedCode: line.scannedCode,
    batchNo: line.batchNo,
    isGift: !!line.isGift,
    giftReason: line.isGift ? line.giftReason : undefined,
  };
}

// ---------------------------------------------------------------- the bill

/**
 * Price a whole bill. Throws err.status 400/403/404 with err.code on bad input
 * (PRICE_EDIT_NOT_ALLOWED, GIFT_NOT_ALLOWED, GIFT_REASON_REQUIRED, DISCOUNT_LIMIT, ...).
 */
async function computeBill({ items, branchId, access, manualDiscount = null, taxIds, appliedTaxes, at = new Date() } = {}) {
  const lines = await resolveLines(items, { branchId, access });
  const saleLines = lines.filter((l) => !l.isGift);
  const giftLines = lines.filter((l) => l.isGift);
  const subtotal = round2(saleLines.reduce((s, l) => s + l.price * l.quantity, 0));

  // Rule discounts (gifts never count towards a cut-off).
  const rules = await loadActiveRules(at);
  const ruleDiscounts = applyRules(rules, subtotal);
  const ruleDiscount = round2(ruleDiscounts.reduce((s, d) => s + d.amount, 0));

  // Manual cashier discount on what is left, within the limit.
  const limits = await manualLimits(access);
  const maxManualDiscount = round2((subtotal * limits.maxManualDiscountPct) / 100);
  const manual = normalizeManualDiscount(manualDiscount);
  let manualAmount = 0;
  if (manual) {
    const base = Math.max(0, round2(subtotal - ruleDiscount));
    manualAmount = round2(Math.min(base, manual.type === 'percentage' ? (base * manual.value) / 100 : manual.value));
    if (manualAmount > maxManualDiscount + 0.001 && !limits.unlimitedManualDiscount) {
      throw httpError(
        403,
        `Manual discount is limited to ${limits.maxManualDiscountPct}% of the bill (${rs(maxManualDiscount)}). Ask a manager.`,
        'DISCOUNT_LIMIT',
        { maxManualDiscount, maxManualDiscountPct: limits.maxManualDiscountPct }
      );
    }
  }
  const appliedDiscounts = [...ruleDiscounts];
  if (manualAmount > 0) {
    appliedDiscounts.push({
      rule: null,
      name: manual.reason ? `Discount: ${manual.reason}` : 'Discount',
      kind: 'manual',
      valueType: manual.type,
      value: manual.value,
      amount: manualAmount,
      label: manual.type === 'percentage' ? `${manual.value}% discount` : `${rs(manual.value)} discount`,
    });
  }
  const discount = round2(ruleDiscount + manualAmount);

  // Taxes the cashier picked (store settings), on the discounted amount.
  const wanted = pickTaxIds(taxIds, appliedTaxes);
  const taxable = Math.max(0, round2(subtotal - discount));
  let taxesOut = [];
  if (wanted.length) {
    const taxes = await loadTaxes();
    taxesOut = taxes
      .filter((t) => wanted.includes(String(t.taxId)))
      .map((t) => ({ taxId: String(t.taxId), name: t.name, rate: Number(t.rate) || 0, amount: round2((taxable * (Number(t.rate) || 0)) / 100) }));
  }
  const tax = round2(taxesOut.reduce((s, t) => s + t.amount, 0));
  const total = round2(Math.max(0, taxable + tax));

  const costOf = (l) => (isNum(l.costPrice) ? Number(l.costPrice) * l.quantity : 0);
  const cogs = round2(lines.reduce((s, l) => s + costOf(l), 0));
  const giftCost = round2(giftLines.reduce((s, l) => s + costOf(l), 0));

  return {
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    appliedDiscounts,
    ruleDiscount,
    manualDiscount: manualAmount,
    manual,
    discount,
    taxable,
    tax,
    appliedTaxes: taxesOut,
    total,
    cogs,
    giftCost,
    giftCount: giftLines.reduce((s, l) => s + l.quantity, 0),
    giftValue: round2(giftLines.reduce((s, l) => s + l.listPrice * l.quantity, 0)),
    missingCost: lines.filter((l) => !isNum(l.costPrice)).length,
    profit: round2(total - tax - cogs),
    nextDiscount: nextThreshold(rules, subtotal, ruleDiscount),
    limits: { ...limits, maxManualDiscount },
  };
}

/** The bill as the browser may see it: no costs / profit for users without dashboard view. */
function publicBill(bill, access) {
  const seeCost = canSeeCost(access);
  const out = { ...bill, canSeeCost: seeCost };
  out.lines = bill.lines.map((l) => {
    const { costPrice, ...rest } = l;
    return seeCost ? { ...rest, costPrice } : rest;
  });
  if (!seeCost) {
    delete out.cogs;
    delete out.giftCost;
    delete out.profit;
    delete out.missingCost;
  }
  return out;
}

module.exports = {
  round2,
  round4,
  httpError,
  canDo,
  canSeeCost,
  unitSalePrice,
  unitCost,
  ruleLabel,
  ruleAmount,
  applyRules,
  nextThreshold,
  loadActiveRules,
  normalizeManualDiscount,
  manualLimits,
  resolveLines,
  toOrderItem,
  computeBill,
  publicBill,
};
