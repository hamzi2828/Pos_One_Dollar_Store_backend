// src/services/analytics/slowMovingService.js
// Slow-moving stock: items in the shop for at least N days (config
// slowMoving.days = 30) that sold less than X% (config slowMoving.soldPct = 10)
// of what was received — reduce the next order, replace the item, give it back
// to the vendor (smaller vendor bill) or, for consignment, ask for a swap.
//
// Per unit and branch with stock > 0:
//   since     = last receipt in the branch (ledger), else unit.lastReceivedAt
//               (old data, main branch), else when it was first put on a shelf
//   received  = that receipt's qty (else unit.lastReceivedQty, else stock + sold since)
//   sold      = sale + gift pieces − sale returns since then (ledger)
const Vendor = require('../../models/vendor');
const config = require('../configService');
const T = require('./time');
const C = require('./common');
const U = require('./stockUnits');

const DEFAULTS = { 'slowMoving.days': 30, 'slowMoving.soldPct': 10, 'demand.coverDays': 30 };

async function getSettings() {
  const s = await config.getMany(DEFAULTS);
  return {
    days: Number(s['slowMoving.days']) || 30,
    soldPct: Number(s['slowMoving.soldPct']) || 10,
    coverDays: Number(s['demand.coverDays']) || 30,
  };
}

/**
 * Suggested action:
 *   swap     consignment stock: ask the vendor to take it back / swap it
 *   return   nothing sold: return it all to the vendor (or replace when no vendor is known)
 *   replace  sold under half the limit: stop re-ordering, replace it, return what you can
 *   reduce   some sales: keep enough for the cover period, return the extra, order less next time
 */
function suggest(r, { soldPct, coverDays }) {
  const rate = r.days > 0 ? r.soldQty / r.days : 0;
  const keep = C.ceilQty(rate * coverDays);
  if (r.isConsignment) return { action: 'swap', actionQty: r.stock, nextOrderQty: 0, reason: 'Consignment stock: ask the vendor to swap it for a faster seller' };
  if (r.soldQty <= 0) {
    return r.vendorId
      ? { action: 'return', actionQty: r.stock, nextOrderQty: 0, reason: `Nothing sold in ${r.days} days: return it to the vendor` }
      : { action: 'replace', actionQty: r.stock, nextOrderQty: 0, reason: `Nothing sold in ${r.days} days: replace it with another item` };
  }
  if (r.soldPct < soldPct / 2) {
    return { action: 'replace', actionQty: Math.max(0, r.stock - keep), nextOrderQty: 0, reason: `Only ${r.soldPct}% sold: replace it and return the extra` };
  }
  return {
    action: 'reduce',
    actionQty: Math.max(0, r.stock - keep),
    nextOrderQty: Math.max(1, keep),
    reason: `${r.soldPct}% sold in ${r.days} days: order about ${Math.max(1, keep)} next time`,
  };
}

const SORTS = {
  value: (a, b) => b.stockValue - a.stockValue,
  days: (a, b) => b.days - a.days,
  soldPct: (a, b) => a.soldPct - b.soldPct || b.stockValue - a.stockValue,
  stock: (a, b) => b.stock - a.stock,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Full list for the request scope. Query: days, soldPct, category, search, vendorId, action, sort. */
async function buildSlowMoving(req, query = {}) {
  const scope = await C.reportScope(req);
  const saved = await getSettings();
  const settings = {
    days: Math.round(C.numParam(query.days, saved.days, { min: 1, max: 730 })),
    soldPct: C.numParam(query.soldPct, saved.soldPct, { min: 0.1, max: 100 }),
    coverDays: saved.coverDays,
  };
  const now = new Date();
  const cutoff = new Date(now.getTime() - settings.days * T.DAY_MS);

  const filter = U.productFilter({ category: query.category, search: query.search });
  const filtered = !!(query.category || query.search);
  const { rows, productIds } = await U.loadUnits(scope, filter);
  const ids = filtered ? productIds : undefined;
  const [receipts, shelves] = await Promise.all([U.lastReceipts(scope, ids), U.shelvesByRow(scope, ids)]);

  const candidates = [];
  for (const row of rows.values()) {
    if (row.stock <= 0) continue;
    const rc = receipts.get(row.key);
    const sh = shelves.get(row.key);
    const legacyMain = !rc && String(row.branchId) === String(scope.mainBranchId);
    let since = null;
    let basis = null;
    if (rc) [since, basis] = [rc.at, 'receipt'];
    else if (legacyMain && row.lastReceivedAt) [since, basis] = [row.lastReceivedAt, 'receipt'];
    else if (sh && sh.firstPlacedAt) [since, basis] = [sh.firstPlacedAt, 'shelf'];
    if (!since || new Date(since) > cutoff) continue;
    Object.assign(row, { since, basis, receipt: rc || null, shelf: sh || null });
    row.receivedQty = rc ? rc.qty : legacyMain ? row.lastReceivedQty : null;
    candidates.push(row);
  }

  const stats = await U.ledgerSince(candidates);
  let out = [];
  for (const row of candidates) {
    const st = stats.get(row.key) || { sold: 0, lastSaleAt: null };
    const received = row.receivedQty > 0 ? row.receivedQty : row.stock + st.sold;
    const soldPct = C.pct(st.sold, received) ?? 0;
    if (soldPct >= settings.soldPct) continue;
    const vendorId = row.isConsignment
      ? row.consignmentVendor || (row.receipt && row.receipt.vendor) || row.lastVendor
      : (row.receipt && row.receipt.vendor) || row.lastVendor;
    const r = {
      key: row.key,
      productId: row.productId,
      variantId: row.variantId,
      name: row.name,
      variantLabel: row.variantLabel,
      code: row.code,
      category: row.category,
      branchId: row.branchId,
      isConsignment: row.isConsignment,
      vendorId: vendorId || null,
      vendorName: null,
      receivedQty: received,
      receivedAt: row.since,
      basis: row.basis,
      receiptType: row.receipt ? row.receipt.type : null,
      days: T.daysSince(row.since, now),
      soldQty: st.sold,
      soldPct,
      lastSoldAt: st.lastSaleAt,
      stock: row.stock,
      costPrice: C.round2(row.costPrice),
      stockValue: C.round2(row.stock * (row.costPrice || 0)),
      salePrice: row.salePrice,
      saleValue: C.round2(row.stock * (row.salePrice || 0)),
      shelves: row.shelf ? row.shelf.shelves : [],
      onShelfSince: row.shelf ? row.shelf.firstPlacedAt : null,
      warehouseQty: Math.max(0, row.stock - (row.shelf ? row.shelf.shelves.reduce((s, x) => s + x.qty, 0) : 0)),
    };
    Object.assign(r, suggest(r, settings));
    out.push(r);
  }

  const [vendors, branches] = await Promise.all([
    C.namesById(Vendor, out.map((r) => r.vendorId)),
    C.branchNames(out.map((r) => r.branchId)),
  ]);
  for (const r of out) {
    r.vendorName = (r.vendorId && vendors.get(r.vendorId)) || null;
    const b = branches.get(r.branchId);
    r.branchName = b ? b.name : '';
    r.branchCode = b ? b.code : '';
  }

  if (query.vendorId) out = out.filter((r) => r.vendorId === String(query.vendorId));
  const all = out;
  if (query.action) out = out.filter((r) => r.action === query.action);
  out.sort(SORTS[query.sort] || SORTS.value);
  return { rows: out, all, settings, scope };
}

function summarize(rows) {
  const s = { items: rows.length, pieces: 0, stockValue: 0, saleValue: 0, byAction: { reduce: 0, replace: 0, return: 0, swap: 0 }, valueByAction: { reduce: 0, replace: 0, return: 0, swap: 0 } };
  for (const r of rows) {
    s.pieces += r.stock;
    s.stockValue += r.stockValue;
    s.saleValue += r.saleValue;
    s.byAction[r.action] += 1;
    s.valueByAction[r.action] = C.round2(s.valueByAction[r.action] + r.stockValue);
  }
  s.stockValue = C.round2(s.stockValue);
  s.saleValue = C.round2(s.saleValue);
  return s;
}

/** GET /api/analytics/slow-moving */
async function slowMovingReport(req, query = {}) {
  const { rows, all, settings, scope } = await buildSlowMoving(req, query);
  const { page, limit, skip } = C.pageParams(query, { defaultLimit: 50 });
  return {
    data: { rows: rows.slice(skip, skip + limit), summary: summarize(all), settings, branchId: scope.branchId },
    meta: C.pageMeta(page, limit, rows.length),
  };
}

/** PUT /api/analytics/slow-moving/settings { days?, soldPct? } */
async function saveSettings(body = {}, userId) {
  if (body.days !== undefined) await config.set('slowMoving.days', Math.round(C.numParam(body.days, 30, { min: 1, max: 730 })), userId);
  if (body.soldPct !== undefined) await config.set('slowMoving.soldPct', C.numParam(body.soldPct, 10, { min: 0.1, max: 100 }), userId);
  return getSettings();
}

module.exports = { getSettings, buildSlowMoving, slowMovingReport, saveSettings, suggest };
