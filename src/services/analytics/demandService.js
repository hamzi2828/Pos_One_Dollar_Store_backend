// src/services/analytics/demandService.js
// Demand list: items whose stock fell to the reorder level since they were
// last bought, with how fast it happened and how much to buy.
//
// Per unit (product / variant) and branch:
//   base       = product.parLevel || last receipt qty in the branch
//                || unit.lastReceivedQty (old data, main branch only)
//                || peak stock since the last receipt || current + sold since
//   threshold  = base × (product.reorderPct || config demand.thresholdPct = 25) / 100
//   listed     when current stock <= threshold
//   crossedAt  = first ledger movement after the last receipt with balanceAfter <= threshold
//   avgDaily   = pieces sold on bills in the last 30 days / days the unit was in the shop (max 30)
//   suggested  = ceil(daily rate × config demand.coverDays = 30) − stock (refill to base when it has no sales)
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const POSOrder = require('../../models/posOrder');
const Vendor = require('../../models/vendor');
const config = require('../configService');
const T = require('./time');
const C = require('./common');
const U = require('./stockUnits');

const DEFAULTS = { 'demand.thresholdPct': 25, 'demand.coverDays': 30 };
const URGENCY_RANK = { critical: 0, high: 1, medium: 2 };

async function getSettings() {
  const s = await config.getMany(DEFAULTS);
  return { thresholdPct: Number(s['demand.thresholdPct']) || 25, coverDays: Number(s['demand.coverDays']) || 30 };
}

/** Products a vendor supplied (receipts, last vendor or consignment owner). */
async function vendorProductIds(vendorId) {
  const vid = C.toId(vendorId);
  if (!vid) throw C.httpError('Invalid vendor');
  const [fromLedger, fromProducts] = await Promise.all([
    StockMovement.distinct('product', { vendor: vid }),
    Product.distinct('_id', { $or: [{ lastVendor: vid }, { 'variants.lastVendor': vid }, { consignmentVendor: vid }] }),
  ]);
  return [...new Set([...fromLedger, ...fromProducts].map(String))].map(C.toId);
}

const urgencyOf = (r) => {
  if (r.stock <= 0 || (r.daysOfCover !== null && r.daysOfCover <= 3)) return 'critical';
  if ((r.daysOfCover !== null && r.daysOfCover <= 7) || (r.pctLeft !== null && r.pctLeft <= 10)) return 'high';
  return 'medium';
};

const bySortKey = {
  urgency: (a, b) =>
    URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
    (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
    (a.pctLeft ?? 0) - (b.pctLeft ?? 0) ||
    b.avgDailySales - a.avgDailySales,
  pctLeft: (a, b) => (a.pctLeft ?? 0) - (b.pctLeft ?? 0),
  daysToCross: (a, b) => (a.daysToCross ?? Infinity) - (b.daysToCross ?? Infinity),
  suggestedQty: (a, b) => b.suggestedQty - a.suggestedQty,
  name: (a, b) => a.name.localeCompare(b.name),
};

/**
 * Full demand list for the request scope (no pagination). Query: category,
 * search, vendorId, urgency.
 */
async function buildDemand(req, query = {}) {
  const scope = await C.reportScope(req);
  const settings = await getSettings();
  const now = new Date();

  let productIds;
  if (query.vendorId) productIds = await vendorProductIds(query.vendorId);
  const filter = U.productFilter({ category: query.category, search: query.search, productIds });
  const filtered = !!(query.category || query.search || productIds);

  const { rows, ensureRow, aliasVariant, productIds: ids } = await U.loadUnits(scope, filter);
  const idFilter = filtered ? ids : undefined;
  const sales30From = new Date(now.getTime() - 30 * T.DAY_MS);
  const [receipts, cheapest, sales30] = await Promise.all([
    U.lastReceipts(scope, idFilter),
    U.cheapestVendors(idFilter),
    U.recentSales(scope, sales30From, { productIds: idFilter, aliasVariant }),
  ]);
  // Branches known only from the ledger (sold out, row never created).
  for (const key of receipts.keys()) {
    const [p, v, b] = key.split('|');
    ensureRow(`${p}|${v}`, b);
  }

  // 1) base + threshold where the receipt (or par level) tells us.
  const needFallback = [];
  const evaluated = [];
  for (const row of rows.values()) {
    const rc = receipts.get(row.key);
    const legacyMain = !rc && String(row.branchId) === String(scope.mainBranchId);
    row.since = rc ? rc.at : legacyMain ? row.lastReceivedAt : null;
    row.receiptQty = rc ? rc.qty : legacyMain ? row.lastReceivedQty : null;
    row.receipt = rc || null;
    row.thresholdPct = row.reorderPct ?? settings.thresholdPct;
    if (row.parLevel > 0) Object.assign(row, { base: row.parLevel, baseSource: 'par_level' });
    else if (row.receiptQty > 0) Object.assign(row, { base: row.receiptQty, baseSource: 'last_receipt' });
    else if (row.since) {
      needFallback.push(row);
      continue;
    } else continue; // never received and no par level: nothing to compare with
    evaluated.push(row);
  }

  // 2) old data without a receipt quantity: peak since the receipt, else current + sold.
  if (needFallback.length) {
    const stats = await U.ledgerSince(needFallback);
    for (const row of needFallback) {
      const st = stats.get(row.key);
      if (st && st.peak > 0) Object.assign(row, { base: st.peak, baseSource: 'peak_since_receipt' });
      else Object.assign(row, { base: row.stock + (st ? st.sold : 0), baseSource: 'current_plus_sold' });
      if (row.base > 0) evaluated.push(row);
    }
  }

  const candidates = [];
  for (const row of evaluated) {
    row.threshold = (row.base * row.thresholdPct) / 100;
    if (row.stock <= row.threshold) candidates.push(row);
  }

  // 3) timing facts (sold since receipt, when it fell below the threshold) for the listed rows only.
  const since = await U.ledgerSince(candidates);

  const out = [];
  for (const row of candidates) {
    const st = since.get(row.key) || { sold: 0, lastSaleAt: null, crossedAt: null };
    const s30 = sales30.get(row.key) || { qty: 0, lastAt: null };
    const crossedAt = st.crossedAt || null;
    const firstSeen = (row.receipt && row.receipt.firstAt) || row.firstReceivedAt || row.createdAt;
    const windowDays = Math.min(30, Math.max(1, T.daysSince(firstSeen, now) ?? 30));
    const avgDaily = s30.qty / windowDays;
    const daysSinceReceipt = row.since ? T.daysSince(row.since, now) : null;
    const rateSince = daysSinceReceipt !== null ? st.sold / Math.max(1, daysSinceReceipt) : 0;
    const rate = avgDaily > 0 ? avgDaily : rateSince;
    const target = rate > 0 ? C.ceilQty(rate * settings.coverDays) : C.ceilQty(row.base);
    const suggestedQty = Math.max(0, target - row.stock);
    const landedCost = row.lastLandedCost ?? row.costPrice ?? 0;
    const cheap = cheapest.get(row.unitKey) || null;
    const vendorId = (row.receipt && row.receipt.vendor) || row.lastVendor || (row.isConsignment ? row.consignmentVendor : null);

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
      stock: row.stock,
      base: C.round2(row.base),
      baseSource: row.baseSource,
      parLevel: row.parLevel,
      reorderPct: row.reorderPct,
      thresholdPct: row.thresholdPct,
      threshold: C.round2(row.threshold),
      pctLeft: C.pct(row.stock, row.base),
      lastReceivedAt: row.since || null,
      lastReceivedQty: row.receiptQty ?? null,
      receiptType: row.receipt ? row.receipt.type : null,
      crossedAt,
      daysToCross: crossedAt && row.since ? C.round1((new Date(crossedAt) - new Date(row.since)) / T.DAY_MS) : null,
      daysSinceReceipt,
      soldSinceReceipt: st.sold,
      sold30: s30.qty,
      lastSoldAt: s30.lastAt || st.lastSaleAt || null,
      avgDailySales: C.round2(avgDaily),
      daysOfCover: rate > 0 ? C.round1(row.stock / rate) : null,
      suggestedQty,
      piecesPerBox: row.piecesPerBox,
      suggestedBoxes: row.piecesPerBox > 1 ? Math.ceil(suggestedQty / row.piecesPerBox) : null,
      vendorId,
      vendorName: null,
      cheapestVendorId: cheap ? cheap.vendor : null,
      cheapestVendorName: null,
      cheapestPrice: cheap ? cheap.price : null,
      cheapestAt: cheap ? cheap.at : null,
      lastPurchasePrice: row.lastPurchasePrice,
      landedCost: C.round2(landedCost),
      salePrice: row.salePrice,
      margin: C.round2(row.salePrice - landedCost),
      marginPct: C.pct(row.salePrice - landedCost, row.salePrice),
      reorderCost: C.round2(suggestedQty * landedCost),
    };
    r.urgency = urgencyOf(r);
    out.push(r);
  }

  // Names (one query each).
  const [vendors, branches] = await Promise.all([
    C.namesById(Vendor, out.flatMap((r) => [r.vendorId, r.cheapestVendorId])),
    C.branchNames(out.map((r) => r.branchId)),
  ]);
  for (const r of out) {
    r.vendorName = (r.vendorId && vendors.get(r.vendorId)) || null;
    r.cheapestVendorName = (r.cheapestVendorId && vendors.get(r.cheapestVendorId)) || null;
    const b = branches.get(r.branchId);
    r.branchName = b ? b.name : '';
    r.branchCode = b ? b.code : '';
  }

  const list = query.urgency ? out.filter((r) => r.urgency === query.urgency) : out;
  list.sort(bySortKey[query.sort] || bySortKey.urgency);
  return { rows: list, all: out, settings, scope };
}

/** Last 6 months of pieces sold per product (bill lines), for the trend column. */
async function trendFor(scope, productIds) {
  if (!productIds.length) return new Map();
  const months = T.listMonths(T.monthKey(), 6);
  const rows = await POSOrder.aggregate([
    { $match: { ...C.SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: T.monthStart(months[0]) }, 'items.product': { $in: productIds } } },
    { $unwind: '$items' },
    { $match: { 'items.product': { $in: productIds } } },
    {
      $group: {
        _id: { p: '$items.product', m: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: T.TZ } } },
        qty: { $sum: '$items.quantity' },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) {
    const k = String(r._id.p);
    if (!map.has(k)) map.set(k, new Map());
    map.get(k).set(r._id.m, r.qty);
  }
  const out = new Map();
  for (const id of productIds.map(String)) {
    const m = map.get(id) || new Map();
    const series = months.map((month) => ({ month, qty: m.get(month) || 0 }));
    const recent = series.slice(3).reduce((s, x) => s + x.qty, 0);
    const before = series.slice(0, 3).reduce((s, x) => s + x.qty, 0);
    const direction = recent > before * 1.15 ? 'up' : recent < before * 0.85 ? 'down' : 'flat';
    out.set(id, { series, direction });
  }
  return out;
}

function summarize(rows) {
  const s = { items: rows.length, critical: 0, high: 0, medium: 0, outOfStock: 0, suggestedQty: 0, reorderCost: 0 };
  for (const r of rows) {
    s[r.urgency] += 1;
    if (r.stock <= 0) s.outOfStock += 1;
    s.suggestedQty += r.suggestedQty;
    s.reorderCost += r.reorderCost;
  }
  s.reorderCost = C.round2(s.reorderCost);
  return s;
}

/** GET /api/analytics/demand */
async function demandReport(req, query = {}) {
  const { rows, settings, scope } = await buildDemand(req, query);
  const { page, limit, skip } = C.pageParams(query, { defaultLimit: 50 });
  const pageRows = rows.slice(skip, skip + limit);
  const trends = await trendFor(scope, [...new Set(pageRows.map((r) => r.productId))].map(C.toId));
  for (const r of pageRows) r.trend = trends.get(r.productId) || null;
  return {
    data: { rows: pageRows, summary: summarize(rows), settings, branchId: scope.branchId },
    meta: C.pageMeta(page, limit, rows.length),
  };
}

/**
 * PUT /api/analytics/demand/settings
 * body: { thresholdPct?, coverDays?, products?: [{ productId, parLevel, reorderPct }] }
 * (null / '' clears a product's own value). canGlobal / canProducts come from the controller.
 */
async function saveSettings(body = {}, { userId, canGlobal, canProducts }) {
  const changes = {};
  const wantsGlobal = body.thresholdPct !== undefined || body.coverDays !== undefined;
  if (wantsGlobal) {
    if (!canGlobal) throw C.httpError('Only the super admin can change the store-wide demand settings', 403);
    if (body.thresholdPct !== undefined) changes['demand.thresholdPct'] = C.numParam(body.thresholdPct, 25, { min: 1, max: 100 });
    if (body.coverDays !== undefined) changes['demand.coverDays'] = Math.round(C.numParam(body.coverDays, 30, { min: 1, max: 365 }));
  }

  const items = Array.isArray(body.products) ? body.products : [];
  if (items.length && !canProducts) throw C.httpError('You cannot change product reorder levels', 403);
  if (items.length > 500) throw C.httpError('Send at most 500 products at once');
  const ops = items.map((it) => {
    const id = C.toId(it && it.productId);
    if (!id) throw C.httpError('Invalid productId');
    const set = {};
    const unset = {};
    for (const [field, max] of [['parLevel', 1e7], ['reorderPct', 100]]) {
      if (!(field in it)) continue;
      const v = it[field];
      if (v === null || v === '') unset[field] = 1;
      else set[field] = C.numParam(v, null, { min: field === 'reorderPct' ? 1 : 0, max });
    }
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    return { id, update };
  });

  for (const [k, v] of Object.entries(changes)) await config.set(k, v, userId);
  let updated = 0;
  for (const op of ops) {
    if (!op.update.$set && !op.update.$unset) continue;
    const r = await Product.updateOne({ _id: op.id }, op.update);
    updated += r.matchedCount || 0;
  }
  return { settings: await getSettings(), productsUpdated: updated };
}

module.exports = { getSettings, buildDemand, demandReport, saveSettings, DEFAULTS };
