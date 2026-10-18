// src/services/inventory/costingService.js
// Pure cost math (no database). Used by purchase orders / goods receiving.
//
// Landed cost of a piece = vendor price + its share of the extra charges of
// the shipment (car rent / transport, builty freight, loading-unloading
// "landing", any misc charges). Inventory is valued at the moving weighted
// average of landed costs (product.costPrice / variant.costPrice), which is
// what the POS snapshots as cost of goods sold.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

const ALLOCATION_METHODS = ['value', 'quantity', 'carton'];

/**
 * Spread `charges` over shipment lines.
 *
 * @param {Array<{key:any, qty:number, unitPrice:number, cartons?:number}>} lines
 *        qty = pieces, unitPrice = vendor price per piece (after line discount)
 * @param {number} charges  total extra charges for these lines
 * @param {'value'|'quantity'|'carton'} method
 *        value    = by line value (qty * unitPrice)  — default, fair for mixed prices
 *        quantity = by pieces
 *        carton   = by cartons (lines without cartons get 0 weight)
 *        Falls back to 'quantity' when every weight is 0.
 * @returns {Array<{key, qty, unitPrice, lineValue, allocatedCharges, landedUnitCost, landedTotal}>}
 *          allocatedCharges sum exactly to `charges` (rounding remainder on the largest line).
 */
function allocateLandedCost(lines = [], charges = 0, method = 'value') {
  const total = round2(Math.max(0, num(charges)));
  const rows = (lines || []).map((l) => {
    const qty = Math.max(0, num(l.qty));
    const unitPrice = Math.max(0, num(l.unitPrice));
    return { key: l.key, qty, unitPrice, cartons: Math.max(0, num(l.cartons)), lineValue: round2(qty * unitPrice) };
  });
  const weightOf = (r, m) => (m === 'quantity' ? r.qty : m === 'carton' ? r.cartons : r.lineValue);
  let m = ALLOCATION_METHODS.includes(method) ? method : 'value';
  let weights = rows.map((r) => weightOf(r, m));
  let sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    m = 'quantity';
    weights = rows.map((r) => weightOf(r, m));
    sum = weights.reduce((s, w) => s + w, 0);
  }

  let allocated = 0;
  let largest = -1;
  const out = rows.map((r, i) => {
    const share = sum > 0 ? round2((total * weights[i]) / sum) : 0;
    allocated += share;
    if (largest === -1 || weights[i] > weights[largest]) largest = i;
    return { ...r, allocatedCharges: share };
  });
  const diff = round2(total - allocated);
  if (diff !== 0 && largest >= 0 && sum > 0) out[largest].allocatedCharges = round2(out[largest].allocatedCharges + diff);

  return out.map((r) => {
    const landedTotal = round2(r.lineValue + r.allocatedCharges);
    const landedUnitCost = r.qty > 0 ? round4(landedTotal / r.qty) : round4(r.unitPrice);
    return {
      key: r.key,
      qty: r.qty,
      unitPrice: r.unitPrice,
      lineValue: r.lineValue,
      allocatedCharges: r.allocatedCharges,
      landedUnitCost,
      landedTotal,
    };
  });
}

/**
 * Moving weighted average cost after receiving `inQty` pieces at `inCost`.
 * Unknown old cost or no old stock -> the new cost.
 */
function weightedAverage(oldQty, oldCost, inQty, inCost) {
  const q0 = Math.max(0, num(oldQty));
  const q1 = Math.max(0, num(inQty));
  const c1 = Math.max(0, num(inCost));
  const hasOld = oldCost !== undefined && oldCost !== null && Number.isFinite(Number(oldCost));
  if (!q1) return hasOld ? round4(oldCost) : round4(c1);
  if (!q0 || !hasOld) return round4(c1);
  return round4((q0 * Number(oldCost) + q1 * c1) / (q0 + q1));
}

/** Margin helpers for price checks (sale price vs landed cost). */
function margin(salePrice, cost) {
  const p = num(salePrice);
  const c = num(cost);
  const profit = round2(p - c);
  return { profit, marginPct: p > 0 ? round2((profit / p) * 100) : 0, markupPct: c > 0 ? round2((profit / c) * 100) : 0 };
}

module.exports = { ALLOCATION_METHODS, allocateLandedCost, weightedAverage, margin, round2, round4 };
