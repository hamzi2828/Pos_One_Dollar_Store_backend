// src/services/purchasing/recostService.js
// Re-cost the goods of one trip (GRN) when its charge rate changes.
//
// Rate of a trip = trip charges ÷ goods of ALL bills on the PO (costing.tripRateOf).
// Every entered piece costs landedFrom(costPrice, rate). When the rate changes
// after pieces went in (a bill / charge added later, or a wrong frozen rate),
// this fixes, per entry:
//   - the entry's landedUnitCost (+ its stock-code row, its receipt movement)
//   - the product / variant average cost (product.costPrice / variant.costPrice)
//   - POS sales made since, whose snapshot cost was too high (never raised)
//
// Average cost fix (exact, from the stock ledger):
//   avg after a costed receipt = (stockBefore × avg + qty × cost) / stockAfter.
//   So a receipt whose cost was off by e (old − new) puts an error of
//   e × qty / stockAfter into the average. Every later costed receipt scales the
//   error that is there by stockBefore / stockAfter (0 when stock was empty).
//   Sales and other outs do not change the average, so they keep the error.
//   err(t) = error in the average at time t;  new cost = current − err(now).
//   A sale at time t snapshotted avg(t), so its fixed cost = saved − err(t).
//   (Simple "current − Σ e×qty ÷ stock" would be wrong once pieces were sold
//   and their sales fixed too, so it is only used when a receipt has no
//   stock balance on its ledger row.)
//   Assumes no hand-typed cost change on the product after the first entry.
const GoodsReceipt = require('../../models/goodsReceipt');
const PurchaseOrder = require('../../models/purchaseOrder');
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const POSOrder = require('../../models/posOrder');
const costing = require('./costing');
const h = require('./helpers');

const { round2, round4 } = costing;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const isNum = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const COSTED_IN = ['purchase_receipt', 'consignment_in'];
const OPEN = ['pending', 'in_progress'];
const EPS = 0.00005;
const entryTagRx = (entry) => new RegExp(`^${h.escapeRegex(`GRN entry ${entry.entryNo} ·`)}`);

/** Unit of a product: { unit, index, key } (index -1 = single product). */
function unitOf(product, variantId) {
  if (product.productType === 'variant') {
    const vs = product.variants || [];
    let index = variantId ? vs.findIndex((v) => String(v.variantId) === String(variantId) || String(v._id) === String(variantId)) : vs.length === 1 ? 0 : -1;
    if (index === -1) return null;
    return { unit: vs[index], index, key: String(vs[index].variantId), ids: [String(vs[index].variantId), String(vs[index]._id)] };
  }
  return { unit: product, index: -1, key: null, ids: [''] };
}
const pathOf = (index, field) => (index === -1 ? field : `variants.${index}.${field}`);
const unitStock = (unit) => {
  if (unit.batches && unit.batches.length) return unit.batches.reduce((s, b) => s + num(b.quantity), 0);
  return num(unit.stock);
};

/** Trip rate from the PO (all bills). */
async function tripRate(poId) {
  const po = await PurchaseOrder.findById(poId).lean();
  if (!po) return null;
  costing.recalcPO(po);
  return { rate: costing.tripRateOf(po), goods: po.totals.goods, charges: po.totals.charges };
}

/**
 * What re-costing `grnId` at `rate` (default: the trip rate) would change.
 * Read only. -> plan (see fields below); plan.changed = false when nothing to do.
 */
async function plan(grnId, { rate } = {}) {
  const grn = await GoodsReceipt.findById(grnId).lean();
  if (!grn) throw h.httpError('Goods receipt not found', 404);
  if (grn.status === 'cancelled') throw h.httpError(`${grn.grnNumber} is cancelled`, 409);
  const trip = await tripRate(grn.purchaseOrder);
  const newRate = isNum(rate) ? round4(rate) : trip ? trip.rate : grn.chargeRate;
  const out = {
    grnId: grn._id,
    grnNumber: grn.grnNumber,
    poNumber: grn.poNumber,
    status: grn.status,
    oldRate: grn.chargeRate,
    rate: newRate,
    goodsTotal: trip ? trip.goods : grn.goodsTotal,
    chargesTotal: trip ? trip.charges : grn.chargesTotal,
    entries: [], // live entries whose landed cost changes
    units: [], // per product/variant: cost fix + sales + movements
    warnings: [],
  };

  // 1. Entries (live: entry + movement; undone: only the receipt row, it still moved the average).
  const byUnit = new Map();
  for (const e of grn.entries || []) {
    const newLanded = costing.landedFrom(e.costPrice, newRate);
    let move = null;
    if (e.posted && e.stockQty > 0) {
      move = e.movement ? await StockMovement.findById(e.movement).lean() : null;
      if (!move) move = await StockMovement.findOne({ refType: 'GoodsReceipt', refId: grn._id, type: 'purchase_receipt', note: entryTagRx(e) }).lean();
    }
    const entryChanged = !e.undone && Math.abs(num(e.landedUnitCost) - newLanded) >= 0.005;
    const moveChanged = move && Math.abs(num(move.unitCost) - newLanded) >= 0.005;
    if (!e.undone && entryChanged) {
      out.entries.push({ entryId: e._id, entryNo: e.entryNo, productName: e.productName, stockQty: e.stockQty, old: num(e.landedUnitCost), new: newLanded });
    }
    if (!moveChanged && !(entryChanged && e.posted && e.stockQty > 0 && !move)) continue;
    const k = `${e.product}|${e.variantId || ''}`;
    if (!byUnit.has(k)) byUnit.set(k, { product: e.product, variantId: e.variantId || null, name: e.productName, receipts: [] });
    byUnit.get(k).receipts.push({
      entryId: e._id,
      entryNo: e.entryNo,
      undone: !!e.undone,
      movementId: move ? move._id : null,
      at: move ? new Date(move.occurredAt) : new Date(e.postedAt || e.createdAt),
      qty: move ? num(move.quantity) : num(e.stockQty),
      balanceAfter: move && isNum(move.balanceAfter) ? Number(move.balanceAfter) : null,
      batchNos: move ? (move.batchAllocations || []).map((b) => b.batchNo).filter(Boolean) : [],
      old: move ? num(move.unitCost) : num(e.landedUnitCost),
      new: newLanded,
    });
  }

  // 2. Per unit: error timeline, new cost, sales to fix.
  for (const u of byUnit.values()) {
    const product = await Product.findById(u.product).setOptions({ withDeleted: true }).lean();
    const found = product && unitOf(product, u.variantId);
    if (!found) {
      out.warnings.push(`${u.name}: product/variant not found, cost not fixed`);
      continue;
    }
    const { unit, index, key, ids } = found;
    u.receipts.sort((a, b) => a.at - b.at);
    const firstAt = u.receipts[0].at;
    const affected = new Map(u.receipts.filter((r) => r.movementId).map((r) => [String(r.movementId), r]));
    const moves = await StockMovement.find({ product: product._id, variantId: key, type: { $in: COSTED_IN }, occurredAt: { $gte: firstAt } })
      .sort({ occurredAt: 1, _id: 1 })
      .lean();
    for (const r of affected.values()) if (!moves.some((m) => String(m._id) === String(r.movementId))) moves.push({ _id: r.movementId, occurredAt: r.at, quantity: r.qty, balanceAfter: r.balanceAfter });
    moves.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    const exact = u.receipts.every((r) => r.movementId && r.balanceAfter !== null) && moves.every((m) => isNum(m.balanceAfter));
    const oldCost = isNum(unit.costPrice) ? Number(unit.costPrice) : isNum(product.costPrice) ? Number(product.costPrice) : null;
    const stock = unitStock(unit);
    const timeline = []; // [{ at, err }]
    let err = 0;
    let method = 'ledger';
    if (exact) {
      for (const m of moves) {
        const after = Math.max(0, num(m.balanceAfter));
        const before = Math.max(0, after - num(m.quantity));
        const r = affected.get(String(m._id));
        const e = r ? r.old - r.new : 0;
        err = after > 0 ? (err * before + e * num(m.quantity)) / after : e;
        timeline.push({ at: new Date(m.occurredAt), err });
      }
    } else {
      // No ledger balance: simple form (current − Σ e × qty ÷ stock).
      method = 'simple';
      const delta = u.receipts.reduce((s, r) => s + (r.old - r.new) * r.qty, 0);
      err = stock > 0 ? delta / stock : oldCost !== null ? oldCost - u.receipts[u.receipts.length - 1].new : 0;
      timeline.push({ at: firstAt, err });
      out.warnings.push(`${u.name}: stock ledger incomplete, used the simple formula`);
    }
    const errAt = (t) => {
      let v = 0;
      for (const p of timeline) if (p.at <= t) v = p.err;
      return v;
    };
    const newCost = oldCost === null ? null : Math.max(0, round4(oldCost - err));

    // Batches made by these receipts carry the receipt cost.
    const batches = [];
    for (const r of u.receipts) {
      for (const no of r.batchNos) {
        const i = (unit.batches || []).findIndex((b) => b.batchNo === no && Math.abs(num(b.costPrice) - r.old) < 0.005);
        if (i !== -1) batches.push({ index: i, batchNo: no, old: num(unit.batches[i].costPrice), new: r.new });
      }
    }
    const last = moves[moves.length - 1];
    const lastAffected = last && affected.get(String(last._id));
    const lastLanded = lastAffected && Math.abs(num(unit.lastLandedCost) - lastAffected.old) < 0.005 ? lastAffected.new : null;

    // Sales since the first entry (snapshot too high -> lower it; never raise).
    const orders = [];
    const rows = await POSOrder.find({ isDeleted: { $ne: true }, createdAt: { $gte: firstAt }, 'items.product': product._id })
      .select('orderNumber createdAt items cogs giftCost total tax')
      .lean();
    for (const o of rows) {
      const fix = errAt(new Date(o.createdAt));
      if (!(fix > EPS)) continue;
      const items = [];
      (o.items || []).forEach((it, i) => {
        if (String(it.product) !== String(product._id)) return;
        if (!ids.includes(String(it.variantId || '')) && !(index === -1 && !it.variantId)) return;
        if (!isNum(it.costPrice)) return;
        const nc = Math.max(0, round4(Number(it.costPrice) - fix));
        if (nc < Number(it.costPrice)) items.push({ index: i, old: Number(it.costPrice), new: nc, qty: num(it.quantity), isGift: !!it.isGift });
      });
      if (!items.length) continue;
      const d = items.reduce((s, it) => s + (it.old - it.new) * it.qty, 0);
      const dg = items.filter((it) => it.isGift).reduce((s, it) => s + (it.old - it.new) * it.qty, 0);
      orders.push({
        orderId: o._id,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        items,
        cogsOld: num(o.cogs),
        cogsNew: round2(Math.max(0, num(o.cogs) - d)),
        giftOld: num(o.giftCost),
        giftNew: round2(Math.max(0, num(o.giftCost) - dg)),
        revenue: round2(num(o.total) - num(o.tax)),
      });
    }

    out.units.push({
      product: product._id,
      variantId: key,
      name: product.name + (index === -1 ? '' : ` (${[unit.color, unit.size].filter(Boolean).join(' ') || key})`),
      index,
      updatedAt: product.updatedAt || null,
      stock,
      oldCost,
      newCost,
      method,
      batches,
      lastLanded,
      receipts: u.receipts,
      orders,
    });
  }

  out.changed =
    out.entries.length > 0 ||
    out.units.some((u) => u.receipts.length || u.orders.length) ||
    (isNum(out.rate) && out.oldRate !== out.rate) ||
    num(grn.goodsTotal) !== num(out.goodsTotal) ||
    num(grn.chargesTotal) !== num(out.chargesTotal);
  return out;
}

/**
 * Write a plan. Order per unit: product cost → its sales → its receipt rows
 * (a re-run after that sees the rows already fixed). Entries + GRN last.
 * `by` = { userId, userName } for the GRN history.
 */
async function apply(p, { by = {}, note = '' } = {}) {
  const now = new Date();
  for (const u of p.units) {
    // Product / variant cost (+ batches, last landed), guarded like stockService (updatedAt).
    const set = {};
    if (u.newCost !== null && u.newCost !== u.oldCost) set[pathOf(u.index, 'costPrice')] = u.newCost;
    for (const b of u.batches) set[`${pathOf(u.index, 'batches')}.${b.index}.costPrice`] = b.new;
    if (u.lastLanded !== null) set[pathOf(u.index, 'lastLandedCost')] = u.lastLanded;
    if (Object.keys(set).length) {
      const nextAt = new Date(Math.max(Date.now(), u.updatedAt ? new Date(u.updatedAt).getTime() + 1 : 0));
      const res = await Product.updateOne({ _id: u.product, updatedAt: u.updatedAt }, { $set: { ...set, updatedAt: nextAt } }, { timestamps: false, withDeleted: true });
      if (!res.matchedCount) throw h.httpError(`${u.name} changed while re-costing. Run again.`, 409, 'RECOST_CONFLICT');
    }

    // Sales: item cost, cogs / giftCost (read fresh: one bill can hold several units), the sale's stock row.
    for (const o of u.orders) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const cur = await POSOrder.collection.findOne({ _id: o.orderId }, { projection: { items: 1, cogs: 1, giftCost: 1 } });
        if (!cur) break;
        const items = o.items.filter((it) => cur.items[it.index] && Number(cur.items[it.index].costPrice) === it.old);
        if (!items.length) break;
        const d = items.reduce((s, it) => s + (it.old - it.new) * it.qty, 0);
        const dg = items.filter((it) => it.isGift).reduce((s, it) => s + (it.old - it.new) * it.qty, 0);
        const oset = { cogs: round2(Math.max(0, num(cur.cogs) - d)), giftCost: round2(Math.max(0, num(cur.giftCost) - dg)) };
        const filter = { _id: o.orderId, cogs: cur.cogs };
        for (const it of items) {
          filter[`items.${it.index}.costPrice`] = it.old;
          oset[`items.${it.index}.costPrice`] = it.new;
        }
        const res = await POSOrder.collection.updateOne(filter, { $set: oset });
        if (!res.matchedCount) continue;
        for (const it of items) {
          const moves = await StockMovement.find({ refType: 'POSOrder', refId: o.orderId, product: u.product, variantId: u.variantId, type: it.isGift ? 'gift' : 'sale', unitCost: it.old })
            .select('quantity')
            .lean();
          for (const m of moves) {
            await StockMovement.collection.updateOne({ _id: m._id }, { $set: { unitCost: it.new, totalCost: round2(it.new * num(m.quantity)) } });
          }
        }
        break;
      }
    }

    // Receipt rows of the entries (also undone ones: they moved the average too).
    for (const r of u.receipts) {
      if (!r.movementId) continue;
      await StockMovement.collection.updateOne({ _id: r.movementId }, { $set: { unitCost: r.new, totalCost: round2(r.new * r.qty) } });
    }
  }

  // Stock-code rows of the entries.
  for (const e of p.entries) {
    const prod = await Product.collection.findOne({ 'stockCodes.entries': e.entryId }, { projection: { _id: 1 } });
    if (prod) {
      await Product.collection.updateOne(
        { _id: prod._id },
        { $set: { 'stockCodes.$[sc].landedUnitCost': e.new } },
        { arrayFilters: [{ 'sc.entries': e.entryId, 'sc.landedUnitCost': e.old }] }
      );
    }
  }

  // Entries + GRN fields.
  for (const e of p.entries) {
    await GoodsReceipt.updateOne({ _id: p.grnId, 'entries._id': e.entryId }, { $set: { 'entries.$.landedUnitCost': e.new } });
  }
  const set = { chargeRate: p.rate, goodsTotal: p.goodsTotal, chargesTotal: p.chargesTotal };
  const grn = await GoodsReceipt.findById(p.grnId).select('status totals entries').lean();
  if (grn.status === 'completed' && grn.totals) {
    set['totals.stockValue'] = round2((grn.entries || []).filter((e) => !e.undone).reduce((s, e) => s + e.stockQty * e.landedUnitCost, 0));
  }
  const update = { $set: set };
  if (p.entries.length || p.units.length) {
    const fixed = p.units.filter((u) => u.newCost !== u.oldCost).length;
    const sales = p.units.reduce((s, u) => s + u.orders.length, 0);
    update.$push = {
      history: {
        at: now,
        by: by.userId || null,
        byName: by.userName || 'System',
        action: 'recosted',
        note: `Cost share ${pct(p.oldRate)} -> ${pct(p.rate)}: ${p.entries.length} entries, ${fixed} product costs, ${sales} sales fixed${note ? ` (${note})` : ''}`,
      },
    };
  }
  await GoodsReceipt.updateOne({ _id: p.grnId }, update);
  return p;
}

const pct = (r) => (isNum(r) ? `${round2(Number(r) * 100)}%` : '—');

/**
 * Plan + apply, holding the GRN lock (no entries added meanwhile).
 * `lockHeld` = the caller already holds it (complete()). Retries a conflict.
 */
async function recostGRN(grnId, { rate, by, note, lockHeld = false } = {}) {
  let locked = lockHeld;
  if (!locked) {
    for (let i = 0; i < 15 && !locked; i++) {
      locked = !!(await h.acquireLock(GoodsReceipt, grnId, {}));
      if (!locked) await new Promise((r) => setTimeout(r, 200));
    }
    if (!locked) throw h.httpError('This goods receipt is busy. Costs will be fixed on the next entry or at finish.', 409, 'GRN_BUSY');
  }
  try {
    for (let attempt = 1; ; attempt++) {
      const p = await plan(grnId, { rate });
      if (!p.changed) return p;
      try {
        return await apply(p, { by, note });
      } catch (err) {
        if (err.code === 'RECOST_CONFLICT' && attempt < 3) continue;
        throw err;
      }
    }
  } finally {
    if (!lockHeld) await h.releaseLock(GoodsReceipt, grnId);
  }
}

/**
 * The ONE place the trip's cost share follows bills / charges while receiving:
 * GRN chargesTotal / goodsTotal / chargeRate = the whole trip, and goods already
 * entered are re-costed. Completed / cancelled receipts are never touched.
 * Never throws (the PO change is already saved); a busy GRN is fixed later
 * (next entry or finish).
 */
async function followTrip(po, { by, note } = {}) {
  const grnId = po && po.goodsReceipt;
  if (!grnId) return null;
  const rate = costing.tripRateOf(po);
  const set = { chargesTotal: round2(po.totals.charges), goodsTotal: round2(po.totals.goods), chargeRate: rate };
  const res = await GoodsReceipt.updateOne({ _id: grnId, status: { $in: OPEN } }, { $set: set });
  if (!res.matchedCount) return null;
  try {
    return await recostGRN(grnId, { rate, by, note });
  } catch (err) {
    console.error('[recost] could not re-cost', String(grnId), err.message);
    return null;
  }
}

/** Live entries priced at another rate than `rate` (re-cost needed). */
const staleEntries = (grn, rate) =>
  (grn.entries || []).filter((e) => !e.undone && Math.abs(num(e.landedUnitCost) - costing.landedFrom(e.costPrice, rate)) >= 0.005);

/** "Today" (Pakistan time) margin from POS orders, with the plan's changes applied. */
async function todayMargin(plans = [], now = new Date()) {
  const PKT = 5 * 3600 * 1000;
  const start = new Date(Math.floor((now.getTime() + PKT) / 86400000) * 86400000 - PKT);
  const rows = await POSOrder.find({ isDeleted: { $ne: true }, createdAt: { $gte: start } }).select('total tax cogs').lean();
  const revenue = round2(rows.reduce((s, o) => s + num(o.total) - num(o.tax), 0));
  const cogs = round2(rows.reduce((s, o) => s + num(o.cogs), 0));
  let less = 0;
  for (const p of plans) for (const u of p.units) for (const o of u.orders) if (new Date(o.createdAt) >= start) less += o.cogsOld - o.cogsNew;
  const m = (c) => (revenue > 0 ? round2(((revenue - c) / revenue) * 100) : 0);
  return { from: start, orders: rows.length, revenue, cogsBefore: cogs, cogsAfter: round2(cogs - less), marginBefore: m(cogs), marginAfter: m(cogs - less) };
}

module.exports = { plan, apply, recostGRN, followTrip, staleEntries, tripRate, todayMargin, OPEN };
