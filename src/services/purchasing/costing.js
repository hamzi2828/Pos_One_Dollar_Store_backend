// src/services/purchasing/costing.js
// Money math for purchase orders and goods receipts (pure — no database).
//
//   line total   = qty × unit price − line discount
//   bill total   = bill amount (paper bill) when typed,
//                  else Σ line totals − bill discount      (what we owe the vendor)
//   charge rate  = trip charges / Σ bill totals            (frozen on the GRN at send)
//   entry landed = cost price × (1 + charge rate)          (simple flow, per entry)
//   net price    = (line total − its share of the bill discount) / qty
//   landed cost  = net price + share of the PO charges     (car rent, builty, landing…)
//
// Charges are spread with costingService.allocateLandedCost by line value
// (default), pieces or cartons. Bill cartons are spread over the bill's lines
// by value so the carton method works without typing cartons per line.
const { allocateLandedCost, margin, round2, round4 } = require('../inventory/costingService');

const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** Spread `total` over weights; shares sum exactly to `total` (remainder on the largest weight). */
function spread(total, weights) {
  const t = round2(total);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? t : 0));
  let used = 0;
  let largest = 0;
  const out = weights.map((w, i) => {
    const share = round2((t * w) / sum);
    used += share;
    if (w > weights[largest]) largest = i;
    return share;
  });
  out[largest] = round2(out[largest] + (t - used));
  return out;
}

/** Recompute item line totals and the bill subtotal / total (mutates). */
function recalcBill(bill) {
  let subtotal = 0;
  for (const item of bill.items || []) {
    const gross = round2(num(item.qty) * num(item.unitPrice));
    item.discount = Math.min(round2(item.discount), gross);
    item.lineTotal = round2(gross - item.discount);
    subtotal += item.lineTotal;
  }
  bill.subtotal = round2(subtotal);
  bill.discount = Math.min(round2(bill.discount), bill.subtotal);
  bill.billTotal = billTotalOf(bill);
  return bill;
}

/** What we owe on a bill: the paper bill amount when typed, else the typed items (subtotal − discount). */
function billTotalOf(bill) {
  const amount = round2(num(bill.billAmount));
  return amount > 0 ? amount : round2(num(bill.subtotal) - num(bill.discount));
}

/** Trip charges as a share of the goods (frozen on the GRN at send): 2500 / 26920 = 0.0929. */
function chargeRateOf(chargesTotal, goodsTotal) {
  const goods = num(goodsTotal);
  return goods > 0 ? round4(num(chargesTotal) / goods) : 0;
}

/** Landed cost per piece of a goods entry: vendor price + its share of the trip charges. */
const landedFrom = (costPrice, chargeRate) => round2(num(costPrice) * (1 + num(chargeRate)));

/** Recompute every bill and the PO totals (mutates). */
function recalcPO(po) {
  const t = { goods: 0, charges: 0, grand: 0, cartons: 0, pieces: 0, bills: 0, lines: 0 };
  for (const bill of po.bills || []) {
    recalcBill(bill);
    t.goods += bill.billTotal;
    t.cartons += num(bill.cartons);
    t.bills += 1;
    for (const item of bill.items || []) {
      t.pieces += num(item.qty);
      t.lines += 1;
    }
  }
  t.charges = (po.charges || []).reduce((s, c) => s + num(c.amount), 0);
  t.goods = round2(t.goods);
  t.charges = round2(t.charges);
  t.grand = round2(t.goods + t.charges);
  po.totals = t;
  return po;
}

/**
 * Every PO line with its net value after the bill discount and its carton share.
 * -> [{ bill, item, qty, netTotal, netUnitPrice, cartonShare }]
 */
function netLines(po) {
  const out = [];
  for (const bill of po.bills || []) {
    recalcBill(bill);
    const items = bill.items || [];
    const discounts = spread(bill.discount, items.map((i) => num(i.lineTotal)));
    const byValue = items.some((i) => num(i.lineTotal) > 0);
    const cartons = items.length ? spreadRaw(num(bill.cartons), items.map((i) => (byValue ? num(i.lineTotal) : num(i.qty)))) : [];
    items.forEach((item, i) => {
      const netTotal = round2(num(item.lineTotal) - discounts[i]);
      const qty = num(item.qty);
      out.push({
        bill,
        item,
        qty,
        netTotal,
        netUnitPrice: qty > 0 ? netTotal / qty : 0, // unrounded on purpose (exact line value)
        cartonShare: cartons[i] || 0,
      });
    });
  }
  return out;
}

// Proportional split without rounding to paisa (cartons may be fractional).
function spreadRaw(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => total / Math.max(1, weights.length));
  return weights.map((w) => round4((total * w) / sum));
}

/**
 * Landed-cost preview for an open (or closed) PO.
 * `units` = Map key "<productId>|<variantId>" -> unit info from productLookup.unitInfo().
 * Warning per line: 'loss' when landed ≥ sale price, 'low_margin' below minMarginPct.
 */
function previewCosting(po, units, { minMarginPct = 15 } = {}) {
  recalcPO(po);
  const lines = netLines(po);
  const alloc = allocateLandedCost(
    lines.map((l, i) => ({ key: i, qty: l.qty, unitPrice: l.netUnitPrice, cartons: l.cartonShare })),
    po.totals.charges,
    po.allocationMethod
  );

  let warnings = 0;
  const rows = lines.map((l, i) => {
    const a = alloc[i];
    const unit = units.get(unitKey(l.item.product, l.item.variantId)) || null;
    const salePrice = unit ? unit.salePrice : num(l.item.salePrice);
    const m = margin(salePrice, a.landedUnitCost);
    let warning = null;
    if (salePrice > 0 && a.landedUnitCost >= salePrice) warning = 'loss';
    else if (salePrice > 0 && m.marginPct < minMarginPct) warning = 'low_margin';
    else if (!(salePrice > 0)) warning = 'no_price';
    if (warning) warnings += 1;
    return {
      billId: l.bill._id,
      itemId: l.item._id,
      vendorName: l.bill.vendorName,
      billNo: l.bill.billNo,
      product: l.item.product,
      variantId: l.item.variantId || null,
      productName: l.item.productName,
      code: l.item.code,
      qty: l.qty,
      vendorPrice: round4(l.item.unitPrice),
      netUnitPrice: round4(l.netUnitPrice),
      lineValue: l.netTotal,
      allocatedCharges: a.allocatedCharges,
      chargePerPiece: l.qty > 0 ? round4(a.allocatedCharges / l.qty) : 0,
      landedUnitCost: a.landedUnitCost,
      landedTotal: a.landedTotal,
      salePrice,
      profitPerPiece: m.profit,
      marginPct: m.marginPct,
      currentCost: unit ? unit.costPrice : null,
      lastPurchasePrice: unit ? unit.lastPurchasePrice : null,
      // costPrice after receiving this line (moving weighted average over all stock)
      newAverageCost: unit ? weightedAfter(unit, l.qty, a.landedUnitCost) : a.landedUnitCost,
      warning,
    };
  });

  const goods = round2(rows.reduce((s, r) => s + r.lineValue, 0));
  const landed = round2(rows.reduce((s, r) => s + r.landedTotal, 0));
  const saleValue = round2(rows.reduce((s, r) => s + r.salePrice * r.qty, 0));
  return {
    method: po.allocationMethod,
    minMarginPct,
    lines: rows,
    totals: {
      goods,
      charges: po.totals.charges,
      landed,
      chargesPct: goods > 0 ? round2((po.totals.charges / goods) * 100) : 0,
      saleValue,
      expectedProfit: round2(saleValue - landed),
      marginPct: saleValue > 0 ? round2(((saleValue - landed) / saleValue) * 100) : 0,
      pieces: rows.reduce((s, r) => s + r.qty, 0),
      warnings,
      // simple flow: every entered piece costs costPrice × (1 + chargeRate)
      billsTotal: po.totals.goods,
      chargeRate: chargeRateOf(po.totals.charges, po.totals.goods),
    },
  };
}

function weightedAfter(unit, qty, cost) {
  const { weightedAverage } = require('../inventory/costingService');
  return weightedAverage(unit.stockTotal, unit.costPrice, qty, cost);
}

const unitKey = (productId, variantId) => `${String(productId && productId._id ? productId._id : productId)}|${variantId || ''}`;

/**
 * Landed cost of a goods receipt over the ACCEPTED pieces (all charges are
 * capitalized into the goods that arrived). Pure; does not mutate.
 *
 * claimFromVendor = true : short + damaged pieces are claimed back from the
 *                          vendor at net price (debit note); stock value =
 *                          accepted × net price + charges.
 * claimFromVendor = false: we keep paying for them, so the whole line value
 *                          is carried by the accepted pieces.
 *
 * -> { lines: [{ lineId, accepted, short, damaged, claimQty, claimAmount,
 *                allocatedCharges, landedUnitCost, stockValue }], claims: [...], totals }
 */
function receiptCosting(grn) {
  const claim = grn.claimFromVendor !== false;
  const base = (grn.lines || []).map((l) => {
    const expected = num(l.expectedQty);
    const received = Math.min(num(l.receivedQty), expected);
    const damaged = Math.min(num(l.damagedQty), received);
    const accepted = received - damaged;
    const short = expected - received;
    const lineValue = has(l.lineValue) ? round2(l.lineValue) : round2(expected * num(l.unitPrice));
    const acceptedValue = accepted === expected ? lineValue : round2(accepted * num(l.unitPrice));
    const claimAmount = claim ? round2(Math.max(0, lineValue - acceptedValue)) : 0;
    const costValue = claim ? acceptedValue : accepted > 0 ? lineValue : 0;
    return { l, expected, received, damaged, accepted, short, claimAmount, costValue };
  });

  const alloc = allocateLandedCost(
    base.map((b, i) => ({
      key: i,
      qty: b.accepted,
      unitPrice: b.accepted > 0 ? b.costValue / b.accepted : 0,
      cartons: b.expected > 0 ? (num(b.l.cartonShare) * b.accepted) / b.expected : 0,
    })),
    num(grn.chargesTotal),
    grn.allocationMethod
  );

  const lines = base.map((b, i) => ({
    lineId: b.l._id,
    lineNo: b.l.lineNo,
    bill: b.l.bill,
    vendor: b.l.vendor,
    vendorName: b.l.vendorName,
    billNo: b.l.billNo,
    productName: b.l.productName,
    expected: b.expected,
    received: b.received,
    damaged: b.damaged,
    short: b.short,
    accepted: b.accepted,
    unitPrice: round4(b.l.unitPrice),
    claimQty: claim ? b.short + b.damaged : 0,
    claimAmount: b.claimAmount,
    allocatedCharges: b.accepted > 0 ? alloc[i].allocatedCharges : 0,
    landedUnitCost: b.accepted > 0 ? alloc[i].landedUnitCost : 0,
    stockValue: b.accepted > 0 ? alloc[i].landedTotal : 0,
  }));

  // One claim (debit note) per vendor bill.
  const byBill = new Map();
  for (const l of lines) {
    if (!(l.claimAmount > 0)) continue;
    const key = String(l.bill);
    const c = byBill.get(key) || { bill: l.bill, vendor: l.vendor, vendorName: l.vendorName, billNo: l.billNo, shortQty: 0, damagedQty: 0, amount: 0 };
    c.shortQty += l.short;
    c.damagedQty += l.damaged;
    c.amount = round2(c.amount + l.claimAmount);
    byBill.set(key, c);
  }
  const claims = [...byBill.values()];

  const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
  const stockValue = round2(sum('stockValue'));
  const allocated = round2(sum('allocatedCharges'));
  return {
    claimFromVendor: claim,
    lines,
    claims,
    totals: {
      expected: sum('expected'),
      received: sum('received'),
      damaged: sum('damaged'),
      short: sum('short'),
      accepted: sum('accepted'),
      stockValue,
      claimed: round2(claims.reduce((s, c) => s + c.amount, 0)),
      charges: round2(num(grn.chargesTotal)),
      // charges that found no accepted piece to sit on (nothing arrived)
      unallocatedCharges: round2(Math.max(0, num(grn.chargesTotal) - allocated)),
    },
  };
}

function has(v) {
  return v !== undefined && v !== null && v !== '';
}

module.exports = {
  spread,
  recalcBill,
  recalcPO,
  billTotalOf,
  chargeRateOf,
  landedFrom,
  netLines,
  previewCosting,
  receiptCosting,
  unitKey,
  round2,
  round4,
};
