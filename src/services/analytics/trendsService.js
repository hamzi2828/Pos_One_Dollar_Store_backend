// src/services/analytics/trendsService.js
// Sales trends & seasonality: monthly pieces / net sales / profit for the last
// 3–36 months (PKT months) overall, per category and per product; which
// products sell most in each calendar month; one product's series with the
// same month of the year before (YoY). Line maths: services/analytics/sales.js.
const POSOrder = require('../../models/posOrder');
const T = require('./time');
const C = require('./common');
const { salesLines, addTo, zero, monthExpr } = require('./sales');

const SORTS = { revenue: 'revenue', qty: 'qty', profit: 'profit' };

// Months of history change slowly and the query reads every bill of the
// window, so results are kept for a few minutes per process (?fresh=1 skips).
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map(); // key -> { at, value }

const money = (o = {}) => ({
  qty: o.qty || 0,
  giftQty: o.giftQty || 0,
  revenue: C.round2(o.revenue),
  cost: C.round2(o.cost),
  profit: C.round2((o.revenue || 0) - (o.cost || 0)),
});

/** Month list filled from a Map(month -> totals); missing months = 0. */
const series = (months, byMonth) => months.map((month) => ({ month, ...money(byMonth.get(month)) }));

const bump = (map, key) => {
  if (!map.has(key)) map.set(key, zero());
  return map.get(key);
};

function parseWindow(query) {
  const months = Math.round(C.numParam(query.months, 12, { min: 3, max: 36 }));
  const list = T.listMonths(T.monthKey(), months);
  return { months: list, start: T.monthStart(list[0]) };
}

/** Product detail: monthly series + the same month a year earlier. */
async function productDetail(scope, productId, months) {
  const pid = C.toId(productId);
  if (!pid) throw C.httpError('Invalid productId');
  const first = T.addMonths(months[0], -12);
  const lines = await salesLines({
    orderMatch: { ...C.SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: T.monthStart(first) }, 'items.product': pid },
    lineMatch: { 'items.product': pid },
    groupBy: { m: monthExpr },
  });
  const byMonth = new Map();
  for (const l of lines) addTo(bump(byMonth, l.key.m), l);
  const list = months.map((month) => {
    const cur = money(byMonth.get(month));
    const prev = money(byMonth.get(T.addMonths(month, -12)));
    return { month, ...cur, prevYear: prev, yoyPct: prev.revenue > 0 ? C.pct(cur.revenue - prev.revenue, prev.revenue) : null };
  });
  const bestMonths = [...list].filter((m) => m.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 3).map((m) => m.month);
  return {
    productId: String(pid),
    name: lines[0] ? lines[0].name : null,
    category: lines[0] ? lines[0].category : null,
    months: list,
    bestMonths,
  };
}

/** GET /api/analytics/trends?months=12&category=&search=&productId=&sort=revenue&top=25&fresh=1 */
async function trendsReport(req, query = {}) {
  const scope = await C.reportScope(req);
  const key = JSON.stringify([scope.branchId || 'all', ...['months', 'category', 'search', 'productId', 'sort', 'top'].map((k) => query[k] || '')]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && !query.fresh) return hit.value;
  const value = await buildTrends(scope, query);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

async function buildTrends(scope, query) {
  const { months, start } = parseWindow(query);
  const sortField = SORTS[query.sort] || 'revenue';
  const top = Math.round(C.numParam(query.top, 25, { min: 1, max: 500 }));
  const orderMatch = { ...C.SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: start } };
  const search = query.search && String(query.search).trim() ? new RegExp(C.escapeRegex(String(query.search).trim()), 'i') : null;

  const [allLines, bills, product] = await Promise.all([
    salesLines({ orderMatch, groupBy: { m: monthExpr } }),
    // Whole bills per month (before any category filter).
    POSOrder.aggregate([{ $match: orderMatch }, { $group: { _id: monthExpr, bills: { $sum: 1 }, total: { $sum: '$total' } } }]),
    query.productId ? productDetail(scope, query.productId, months) : Promise.resolve(null),
  ]);
  const lines = query.category ? allLines.filter((l) => l.category === String(query.category)) : allLines;

  const monthTotals = new Map();
  const cats = new Map(); // category -> Map(month -> totals)
  const prods = new Map(); // productId -> { name, category, months: Map }
  const season = new Map(); // 'MM' -> Map(productId -> { name, qty, revenue })
  for (const l of lines) {
    const m = l.key.m;
    addTo(bump(monthTotals, m), l);
    if (!cats.has(l.category)) cats.set(l.category, new Map());
    addTo(bump(cats.get(l.category), m), l);
    if (!search || search.test(l.name)) {
      if (!prods.has(l.productId)) prods.set(l.productId, { name: l.name, category: l.category, months: new Map() });
      addTo(bump(prods.get(l.productId).months, m), l);
    }
    const cm = m.slice(5, 7);
    if (!season.has(cm)) season.set(cm, new Map());
    const s = season.get(cm).get(l.productId) || { productId: l.productId, name: l.name, qty: 0, revenue: 0 };
    s.qty += l.qty;
    s.revenue += l.revenue;
    season.get(cm).set(l.productId, s);
  }

  const billsByMonth = new Map(bills.map((b) => [b._id, b]));
  const monthly = series(months, monthTotals).map((m) => {
    const b = billsByMonth.get(m.month);
    return { ...m, bills: b ? b.bills : 0, billTotal: b ? C.round2(b.total) : 0, marginPct: C.pct(m.profit, m.revenue) };
  });

  const sumOf = (byMonth) => [...byMonth.values()].reduce((t, x) => addTo(t, x), zero());
  const categories = [...cats].map(([category, byMonth]) => {
    const s = series(months, byMonth);
    const peak = s.reduce((best, x) => (x.revenue > best.revenue ? x : best), s[0]);
    return { category, total: money(sumOf(byMonth)), months: s, peakMonth: peak && peak.revenue > 0 ? peak.month : null };
  });
  categories.sort((a, b) => b.total[sortField] - a.total[sortField] || a.category.localeCompare(b.category));

  const products = [...prods]
    .map(([productId, p]) => ({ productId, name: p.name, category: p.category, total: money(sumOf(p.months)), byMonth: p.months }))
    .sort((a, b) => b.total[sortField] - a.total[sortField] || a.name.localeCompare(b.name))
    .slice(0, top)
    .map(({ byMonth, ...p }) => ({ ...p, months: series(months, byMonth) }));

  const seasonality = Array.from({ length: 12 }, (_, i) => {
    const rows = [...(season.get(String(i + 1).padStart(2, '0')) || new Map()).values()];
    rows.sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);
    return {
      month: i + 1,
      label: T.MONTH_NAMES[i],
      qty: rows.reduce((s, r) => s + r.qty, 0),
      revenue: C.round2(rows.reduce((s, r) => s + r.revenue, 0)),
      top: rows.slice(0, 5).map((r) => ({ ...r, revenue: C.round2(r.revenue) })),
    };
  });

  const totals = monthly.reduce(
    (t, m) => ({ qty: t.qty + m.qty, giftQty: t.giftQty + m.giftQty, revenue: t.revenue + m.revenue, cost: t.cost + m.cost, bills: t.bills + m.bills }),
    { qty: 0, giftQty: 0, revenue: 0, cost: 0, bills: 0 }
  );
  const withSales = monthly.filter((m) => m.revenue > 0);
  const best = withSales.reduce((b, m) => (!b || m.revenue > b.revenue ? m : b), null);
  const worst = withSales.reduce((b, m) => (!b || m.revenue < b.revenue ? m : b), null);

  return {
    months,
    monthly,
    categories,
    products,
    seasonality,
    summary: {
      ...money(totals),
      bills: totals.bills,
      marginPct: C.pct(totals.revenue - totals.cost, totals.revenue),
      avgMonthlyRevenue: C.round2(totals.revenue / months.length),
      bestMonth: best ? best.month : null,
      worstMonth: worst ? worst.month : null,
      productsSold: prods.size,
      categories: categories.length,
    },
    product,
    branchId: scope.branchId,
    generatedAt: new Date(),
  };
}

/** GET /api/analytics/trends/product?productId=&months= — one product, this period vs the year before. */
async function productTrend(req, query = {}) {
  const scope = await C.reportScope(req);
  if (!query.productId) throw C.httpError('Pick a product');
  return productDetail(scope, query.productId, parseWindow(query).months);
}

module.exports = { trendsReport, productTrend };
