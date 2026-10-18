// src/services/analytics/expensesService.js
// Daily / weekly (Mon–Sun) / monthly expense totals in Pakistan time, per
// category, with items taken from our own stock for the shop (Expense.source
// 'shop_use') shown separately — they are part of the totals.
const Expense = require('../../models/expense');
const T = require('./time');
const C = require('./common');

const GROUPS = ['day', 'week', 'month'];
const TOP_CATEGORIES = 6; // per-period breakdown keeps the biggest categories + "Other"

const periodExpr = (groupBy) => {
  if (groupBy === 'month') return { $dateToString: { format: '%Y-%m', date: '$date', timezone: T.TZ } };
  if (groupBy === 'week') {
    return {
      $dateToString: {
        format: '%Y-%m-%d',
        date: { $dateTrunc: { date: '$date', unit: 'week', timezone: T.TZ, startOfWeek: 'monday' } },
        timezone: T.TZ,
      },
    };
  }
  return { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: T.TZ } };
};

/** Every period key in the range, oldest first, with a label. */
function periodList(groupBy, from, to) {
  if (groupBy === 'month') {
    const out = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = T.addMonths(m, 1)) out.push({ key: m, label: T.monthLabel(m) });
    return out;
  }
  if (groupBy === 'week') {
    const out = [];
    for (let w = T.weekStartKey(from); w <= to; w = T.addDays(w, 7)) {
      const end = T.addDays(w, 6);
      out.push({ key: w, label: `${fmtDay(w)} – ${fmtDay(end)}`, end });
    }
    return out;
  }
  return T.listDays(from, to).map((d) => ({ key: d, label: fmtDay(d, true) }));
}

function fmtDay(key, withYear = false) {
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${T.MONTH_NAMES[m - 1]}${withYear ? ` ${y}` : ''}`;
}

async function baseMatch(req, query) {
  const scope = await C.reportScope(req);
  const range = T.parseRange(query, { defaultFrom: 'month', maxDays: 1100 });
  const match = { isDeleted: { $ne: true }, ...scope.salesMatch, date: { $gte: range.start, $lt: range.end } };
  if (query.category) match.category = String(query.category);
  if (query.source === 'shop_use') match.source = 'shop_use';
  else if (query.source === 'other') match.source = { $ne: 'shop_use' };
  if (query.search && String(query.search).trim()) {
    const rx = new RegExp(C.escapeRegex(String(query.search).trim()), 'i');
    match.$or = [{ title: rx }, { category: rx }, { reference: rx }, { notes: rx }];
  }
  return { scope, range, match };
}

const isShopUse = { $eq: ['$source', 'shop_use'] };

/** GET /api/analytics/expenses?groupBy=day|week|month&from&to&category&source&search&page&limit */
async function expensesReport(req, query = {}) {
  const groupBy = GROUPS.includes(query.groupBy) ? query.groupBy : 'day';
  const { scope, range, match } = await baseMatch(req, query);
  if (groupBy === 'day' && range.days > 370) throw C.httpError('Pick at most a year for a daily report, or group by week / month');
  const { page, limit, skip } = C.pageParams(query, { defaultLimit: 25, maxLimit: 200 });

  const [facet] = await Expense.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              shopUse: { $sum: { $cond: [isShopUse, '$amount', 0] } },
              shopUseCount: { $sum: { $cond: [isShopUse, 1, 0] } },
            },
          },
        ],
        periods: [
          {
            $group: {
              _id: { k: periodExpr(groupBy), c: { $ifNull: ['$category', 'Uncategorized'] } },
              total: { $sum: '$amount' },
              shopUse: { $sum: { $cond: [isShopUse, '$amount', 0] } },
              count: { $sum: 1 },
            },
          },
        ],
        byCategory: [
          {
            $group: {
              _id: { $ifNull: ['$category', 'Uncategorized'] },
              total: { $sum: '$amount' },
              shopUse: { $sum: { $cond: [isShopUse, '$amount', 0] } },
              count: { $sum: 1 },
            },
          },
          { $sort: { total: -1, _id: 1 } },
        ],
        bySource: [{ $group: { _id: { $ifNull: ['$source', 'manual'] }, total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }],
        shopUse: [
          { $match: { source: 'shop_use' } },
          { $sort: { date: -1, _id: -1 } },
          { $limit: 500 },
          { $project: { title: 1, amount: 1, category: 1, date: 1, notes: 1, reference: 1, sourceType: 1, sourceRef: 1, branch: 1 } },
        ],
        list: [
          { $sort: { date: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { title: 1, amount: 1, category: 1, date: 1, paymentMethod: 1, reference: 1, notes: 1, source: 1, sourceType: 1, branch: 1 } },
        ],
      },
    },
  ]);

  const totals = facet.totals[0] || { total: 0, count: 0, shopUse: 0, shopUseCount: 0 };
  const topCats = facet.byCategory.slice(0, TOP_CATEGORIES).map((c) => c._id);
  const periodRows = new Map();
  for (const r of facet.periods) {
    const p = periodRows.get(r._id.k) || { total: 0, shopUse: 0, count: 0, categories: {} };
    p.total += r.total;
    p.shopUse += r.shopUse;
    p.count += r.count;
    const cat = topCats.includes(r._id.c) ? r._id.c : 'Other';
    p.categories[cat] = C.round2((p.categories[cat] || 0) + r.total);
    periodRows.set(r._id.k, p);
  }
  const periods = periodList(groupBy, range.from, range.to).map((p) => {
    const r = periodRows.get(p.key) || { total: 0, shopUse: 0, count: 0, categories: {} };
    return {
      key: p.key,
      label: p.label,
      total: C.round2(r.total),
      shopUse: C.round2(r.shopUse),
      other: C.round2(r.total - r.shopUse),
      count: r.count,
      categories: r.categories,
    };
  });

  const branches = await C.branchNames([...facet.list, ...facet.shopUse].map((e) => (e.branch ? String(e.branch) : scope.mainBranchId)));
  const withBranch = (e) => {
    const b = branches.get(e.branch ? String(e.branch) : String(scope.mainBranchId));
    return { ...e, branchName: b ? b.name : '' };
  };
  const top = facet.byCategory[0];
  const active = periods.filter((p) => p.total > 0).length;

  return {
    data: {
      range: { from: range.from, to: range.to, days: range.days, groupBy },
      summary: {
        total: C.round2(totals.total),
        count: totals.count,
        shopUse: C.round2(totals.shopUse),
        shopUseCount: totals.shopUseCount,
        other: C.round2(totals.total - totals.shopUse),
        shopUsePct: C.pct(totals.shopUse, totals.total),
        periods: periods.length,
        activePeriods: active,
        avgPerPeriod: C.round2(periods.length ? totals.total / periods.length : 0),
        avgPerDay: C.round2(totals.total / range.days),
        topCategory: top ? { category: top._id, total: C.round2(top.total) } : null,
      },
      periods,
      categoriesInPeriods: [...topCats, ...(facet.byCategory.length > TOP_CATEGORIES ? ['Other'] : [])],
      byCategory: facet.byCategory.map((c) => ({
        category: c._id,
        total: C.round2(c.total),
        shopUse: C.round2(c.shopUse),
        count: c.count,
        pct: C.pct(c.total, totals.total),
      })),
      bySource: facet.bySource.map((s) => ({ source: s._id, total: C.round2(s.total), count: s.count })),
      shopUse: facet.shopUse.map(withBranch),
      expenses: facet.list.map(withBranch),
      branchId: scope.branchId,
    },
    meta: C.pageMeta(page, limit, totals.count),
  };
}

/** Every expense of the range (CSV export). */
async function expenseRows(req, query = {}) {
  const { match } = await baseMatch(req, query);
  return Expense.find(match).sort({ date: -1, _id: -1 }).limit(50000)
    .select('title amount category date paymentMethod reference notes source sourceType').lean();
}

module.exports = { expensesReport, expenseRows, periodList };
