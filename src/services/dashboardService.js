// src/services/dashboardService.js
// The owner's dashboard: GET /dashboard?range=today|yesterday|7d|30d|month|year
//
// Everything is in shop time (Asia/Karachi — the server runs in UTC).
// Sales = POS bills that count as sales (not deleted / refunded / cancelled);
// "Sales" is net of discounts and tax; profit = sales − cost of goods (landed
// cost snapshot on each line, gifts included).
// Each period is compared with the one before it, cut at the same time of day
// (today 2 pm vs yesterday 2 pm) so the comparison is fair.
// Blocks the user may not open (stock value, payables, tills...) are left out.
const T = require('./analytics/time');
const C = require('./analytics/common');
const { salesLines } = require('./analytics/sales');
const POSOrder = require('../models/posOrder');
const Product = require('../models/product');
const LocationStock = require('../models/locationStock');
const Shelf = require('../models/shelf');
const GoodsReceipt = require('../models/goodsReceipt');
const PurchaseOrder = require('../models/purchaseOrder');
const DamageRecord = require('../models/damageRecord');
const CashSession = require('../models/cashSession');
const VendorLedgerEntry = require('../models/vendorLedgerEntry');
const { getMainBranchId } = require('../helper/productCodes');

const { DAY_MS, TZ } = T;

const RANGES = {
  today: { label: 'Today', compare: 'yesterday, same time', bucket: 'hour' },
  yesterday: { label: 'Yesterday', compare: 'the day before', bucket: 'hour' },
  '7d': { label: 'Last 7 days', compare: 'the 7 days before', bucket: 'day', days: 7 },
  '30d': { label: 'Last 30 days', compare: 'the 30 days before', bucket: 'day', days: 30 },
  month: { label: 'This month', compare: 'last month, same days', bucket: 'day' },
  year: { label: 'This year', compare: 'last year, same days', bucket: 'month' },
};
// Old ?timeRange values.
const LEGACY = { week: '7d' };

const PAYMENT_LABELS = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', split: 'Split (cash + card)' };

const HOUR_LABEL = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

/** Current + previous window for a range key. */
function resolveRange(rawKey, now = new Date()) {
  const key = RANGES[rawKey] ? rawKey : LEGACY[rawKey] || 'today';
  const def = RANGES[key];
  const today = T.dayKey(now);
  let from;
  let to = now;
  let prevFrom;
  let prevTo;
  if (key === 'today') {
    from = T.dayStart(today);
    prevFrom = new Date(from - DAY_MS);
    prevTo = new Date(to - DAY_MS);
  } else if (key === 'yesterday') {
    from = T.dayStart(T.addDays(today, -1));
    to = T.dayStart(today);
    prevFrom = new Date(from - DAY_MS);
    prevTo = from;
  } else if (def.days) {
    from = T.dayStart(T.addDays(today, -(def.days - 1)));
    prevFrom = new Date(from - def.days * DAY_MS);
    prevTo = new Date(to - def.days * DAY_MS);
  } else if (key === 'month') {
    const mk = T.monthKey(now);
    from = T.monthStart(mk);
    prevFrom = T.monthStart(T.addMonths(mk, -1));
    prevTo = new Date(Math.min(prevFrom.getTime() + (to - from), from.getTime()));
  } else {
    const y = Number(today.slice(0, 4));
    from = T.dayStart(`${y}-01-01`);
    prevFrom = T.dayStart(`${y - 1}-01-01`);
    prevTo = new Date(Math.min(prevFrom.getTime() + (to - from), from.getTime()));
  }
  return { key, label: def.label, compareLabel: def.compare, bucket: def.bucket, from, to, prevFrom, prevTo, timezone: TZ };
}

const saleMatch = (from, to) => ({ ...C.SALE_MATCH, createdAt: { $gte: from, $lt: to } });

/** Headline numbers for one window. */
async function totals(from, to) {
  const [row] = await POSOrder.aggregate([
    { $match: saleMatch(from, to) },
    {
      $group: {
        _id: null,
        bills: { $sum: 1 },
        gross: { $sum: { $ifNull: ['$total', 0] } },
        tax: { $sum: { $ifNull: ['$tax', 0] } },
        discount: { $sum: { $ifNull: ['$discount', 0] } },
        cogs: { $sum: { $ifNull: ['$cogs', 0] } },
        giftCost: { $sum: { $ifNull: ['$giftCost', 0] } },
        items: { $sum: { $sum: '$items.quantity' } },
        customers: { $addToSet: '$customer' },
      },
    },
  ]);
  const r = row || { bills: 0, gross: 0, tax: 0, discount: 0, cogs: 0, giftCost: 0, items: 0, customers: [] };
  const sales = C.round2(r.gross - r.tax);
  const profit = C.round2(sales - r.cogs);
  return {
    sales,
    profit,
    marginPct: C.pct(profit, sales),
    bills: r.bills,
    avgBill: r.bills ? C.round2(r.gross / r.bills) : 0,
    items: r.items,
    itemsPerBill: r.bills ? C.round1(r.items / r.bills) : 0,
    discounts: C.round2(r.discount),
    giftCost: C.round2(r.giftCost),
    regularCustomers: (r.customers || []).filter(Boolean).length,
  };
}

async function refunds(from, to) {
  const [row] = await POSOrder.aggregate([
    { $match: { isDeleted: { $ne: true }, orderStatus: 'refunded', refundedAt: { $gte: from, $lt: to } } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$total', 0] } } } },
  ]);
  return { count: row ? row.count : 0, amount: C.round2(row ? row.amount : 0) };
}

/** Sales per hour (today / yesterday), per day or per month — gaps filled with 0. */
async function trend(range) {
  const format = range.bucket === 'hour' ? '%H' : range.bucket === 'day' ? '%Y-%m-%d' : '%Y-%m';
  const rows = await POSOrder.aggregate([
    { $match: saleMatch(range.from, range.to) },
    {
      $group: {
        _id: { $dateToString: { format, date: '$createdAt', timezone: TZ } },
        gross: { $sum: { $ifNull: ['$total', 0] } },
        tax: { $sum: { $ifNull: ['$tax', 0] } },
        cogs: { $sum: { $ifNull: ['$cogs', 0] } },
        bills: { $sum: 1 },
      },
    },
  ]);
  const byKey = new Map(rows.map((r) => [r._id, r]));
  let keys;
  let label;
  if (range.bucket === 'hour') {
    keys = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    label = (k) => HOUR_LABEL(Number(k));
  } else if (range.bucket === 'day') {
    keys = T.listDays(T.dayKey(range.from), T.dayKey(new Date(range.to - 1)));
    label = (k) => {
      const [, m, d] = k.split('-').map(Number);
      return `${d} ${T.MONTH_NAMES[m - 1]}`;
    };
  } else {
    const first = T.monthKey(range.from);
    const last = T.monthKey(new Date(range.to - 1));
    keys = [];
    for (let k = first; k <= last; k = T.addMonths(k, 1)) keys.push(k);
    label = (k) => T.MONTH_NAMES[Number(k.slice(5, 7)) - 1];
  }
  return keys.map((k) => {
    const r = byKey.get(k);
    const sales = r ? C.round2(r.gross - r.tax) : 0;
    return { key: k, label: label(k), sales, profit: r ? C.round2(sales - r.cogs) : 0, bills: r ? r.bills : 0 };
  });
}

/** Busy hours over the whole window (sum per hour of day). */
async function busyHours(range) {
  const rows = await POSOrder.aggregate([
    { $match: saleMatch(range.from, range.to) },
    {
      $group: {
        _id: { $dateToString: { format: '%H', date: '$createdAt', timezone: TZ } },
        gross: { $sum: { $ifNull: ['$total', 0] } },
        tax: { $sum: { $ifNull: ['$tax', 0] } },
        bills: { $sum: 1 },
      },
    },
  ]);
  const byHour = new Map(rows.map((r) => [Number(r._id), r]));
  return Array.from({ length: 24 }, (_, h) => {
    const r = byHour.get(h);
    return { hour: h, label: HOUR_LABEL(h), sales: r ? C.round2(r.gross - r.tax) : 0, bills: r ? r.bills : 0 };
  });
}

async function payments(range) {
  const rows = await POSOrder.aggregate([
    { $match: saleMatch(range.from, range.to) },
    {
      $group: {
        _id: '$paymentMethod',
        amount: { $sum: { $ifNull: ['$total', 0] } },
        bills: { $sum: 1 },
        unpaid: { $sum: { $ifNull: ['$pendingAmount', 0] } },
      },
    },
    { $sort: { amount: -1 } },
  ]);
  return rows.map((r) => ({
    method: r._id || 'other',
    label: PAYMENT_LABELS[r._id] || 'Other',
    amount: C.round2(r.amount),
    bills: r.bills,
    unpaid: C.round2(r.unpaid),
  }));
}

/** Best sellers + categories of the window (revenue after bill discounts, profit at landed cost). */
async function bestSellers(range, limit = 8) {
  const lines = await salesLines({ orderMatch: saleMatch(range.from, range.to), lineMatch: C.PRODUCT_LINE_MATCH, groupBy: {} });
  const top = [...lines].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
  const stock = top.length
    ? await Product.find({ _id: { $in: top.map((r) => C.toId(r.productId)) } })
        .setOptions({ withDeleted: true })
        .select('stock price shortCode sku')
        .lean()
    : [];
  const byId = new Map(stock.map((p) => [String(p._id), p]));
  const products = top.map((r) => {
    const p = byId.get(String(r.productId)) || {};
    return {
      id: String(r.productId),
      name: r.name,
      code: p.shortCode || p.sku || '',
      category: r.category || 'Uncategorised',
      qty: r.qty,
      revenue: C.round2(r.revenue),
      profit: C.round2(r.profit),
      marginPct: C.pct(r.profit, r.revenue),
      stock: Number(p.stock) || 0,
    };
  });

  const cats = new Map();
  let all = 0;
  for (const r of lines) {
    const name = r.category || 'Uncategorised';
    const c = cats.get(name) || { category: name, revenue: 0, qty: 0, profit: 0 };
    c.revenue += r.revenue;
    c.qty += r.qty;
    c.profit += r.profit;
    cats.set(name, c);
    all += r.revenue;
  }
  const categories = [...cats.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8)
    .map((c) => ({ ...c, revenue: C.round2(c.revenue), profit: C.round2(c.profit), sharePct: C.pct(c.revenue, all) }));
  return { products, categories };
}

async function recentBills(limit = 8) {
  const rows = await POSOrder.find({ isDeleted: { $ne: true } })
    .select('orderNumber total paymentMethod paymentStatus orderStatus pendingAmount createdAt customer customerInfo cashier items.quantity items.isGift')
    .populate('customer', 'firstName lastName')
    .populate('cashier', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return rows.map((o) => {
    const c = o.customer && typeof o.customer === 'object' ? o.customer : null;
    const customerName = (c && `${c.firstName || ''} ${c.lastName || ''}`.trim()) || (o.customerInfo && o.customerInfo.name) || 'Walk-in';
    const cashier = o.cashier && typeof o.cashier === 'object' ? `${o.cashier.firstName || ''} ${o.cashier.lastName || ''}`.trim() : '';
    return {
      id: String(o._id),
      orderNumber: o.orderNumber,
      customerName,
      cashierName: cashier,
      total: C.round2(o.total),
      pendingAmount: C.round2(o.pendingAmount || 0),
      items: (o.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0),
      paymentMethod: PAYMENT_LABELS[o.paymentMethod] || o.paymentMethod || '',
      status: o.orderStatus === 'refunded' ? 'refunded' : o.pendingAmount > 0 ? 'unpaid' : 'paid',
      createdAt: o.createdAt,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Needs attention — each item only for users who may open its page     */
/* ------------------------------------------------------------------ */

const ATTENTION_TTL_MS = 60 * 1000; // heavy parts (demand, slow moving) cached briefly
const attentionCache = new Map(); // permission signature -> { at, items }

async function attention(req) {
  const can = (keys) => [].concat(keys).some((k) => req.access.can(k, 'view'));
  const sig = JSON.stringify(
    ['goods_receiving', 'racks', 'stock_putaway', 'report_demand', 'products', 'product_stock', 'report_slow_moving', 'damages', 'till_verify', 'report_receivables', 'pos_orders', 'vendors', 'purchase_orders'].map((k) => (can(k) ? 1 : 0))
  );
  const hit = attentionCache.get(sig);
  if (hit && Date.now() - hit.at < ATTENTION_TTL_MS) return hit.items;

  const jobs = [];
  const add = (fn) => jobs.push(fn().catch((e) => (console.error('[dashboard] attention item failed:', e.message), null)));

  if (can('goods_receiving')) {
    add(async () => {
      const count = await GoodsReceipt.countDocuments({ status: { $in: ['pending', 'in_progress'] } });
      return { key: 'receiving', label: 'Goods to check in', hint: 'Unloaded goods waiting for the receiver', count, level: count ? 'warning' : 'ok', href: '/admin/purchasing/receiving' };
    });
  }
  if (can(['racks', 'stock_putaway'])) {
    add(async () => {
      const loc = require('./inventory/locationService');
      const w = await loc.listWarehouse({ branchId: await getMainBranchId(), page: 1, limit: 1 });
      return { key: 'warehouse', label: 'Waiting in warehouse', hint: `${(w.totalPieces || 0).toLocaleString('en-PK')} pcs not on a shelf yet`, count: w.total || 0, level: w.total ? 'info' : 'ok', href: '/admin/inventory/putaway' };
    });
  }
  if (can('report_demand')) {
    add(async () => {
      const { rows } = await require('./analytics/demandService').buildDemand(req, {});
      const critical = rows.filter((r) => r.urgency === 'critical' || r.stock <= 0).length;
      return { key: 'demand', label: 'Need re-ordering', hint: critical ? `${critical} critical or sold out` : 'Below the re-order level', count: rows.length, level: critical ? 'critical' : rows.length ? 'warning' : 'ok', href: '/admin/reports/demand' };
    });
  }
  if (can(['products', 'product_stock'])) {
    add(async () => {
      const count = await Product.countDocuments({ status: 'out_of_stock' });
      return { key: 'out_of_stock', label: 'Out of stock', hint: 'Products with no pieces left', count, level: count ? 'critical' : 'ok', href: '/admin/products/stock' };
    });
  }
  if (can('report_slow_moving')) {
    add(async () => {
      const { rows } = await require('./analytics/slowMovingService').buildSlowMoving(req, {});
      return { key: 'slow_moving', label: 'Slow movers', hint: 'Sitting on shelves, hardly selling', count: rows.length, level: rows.length ? 'info' : 'ok', href: '/admin/reports/slow-moving' };
    });
  }
  if (can('damages')) {
    add(async () => {
      const count = await DamageRecord.countDocuments({ status: 'pending' });
      return { key: 'damages', label: 'Damage to approve', hint: 'Reported broken / expired items', count, level: count ? 'warning' : 'ok', href: '/admin/inventory/damages' };
    });
  }
  if (can('till_verify')) {
    add(async () => {
      const count = await CashSession.countDocuments({ status: 'closed' });
      return { key: 'tills', label: 'Cash closings to verify', hint: 'Closed tills waiting for you', count, level: count ? 'warning' : 'ok', href: '/admin/till' };
    });
  }
  if (can(['report_receivables', 'pos_orders'])) {
    add(async () => {
      const [r] = await POSOrder.aggregate([
        { $match: { ...C.SALE_MATCH, pendingAmount: { $gt: 0 } } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$pendingAmount' } } },
      ]);
      const count = r ? r.count : 0;
      return { key: 'receivables', label: 'Customer credit', hint: 'Unpaid bills to collect', count, amount: C.round2(r ? r.amount : 0), level: count ? 'info' : 'ok', href: '/admin/reports/receivables' };
    });
  }
  if (can('vendors')) {
    add(async () => {
      const rows = await VendorLedgerEntry.aggregate([
        { $match: { isVoided: false } },
        { $group: { _id: '$vendor', balance: { $sum: { $subtract: ['$credit', '$debit'] } } } },
        { $match: { balance: { $gt: 0.009 } } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$balance' } } },
      ]);
      const r = rows[0];
      const count = r ? r.count : 0;
      return { key: 'payables', label: 'Owed to vendors', hint: count ? `${count} vendor${count === 1 ? '' : 's'} to pay` : 'Nothing owed', count, amount: C.round2(r ? r.amount : 0), level: count ? 'info' : 'ok', href: '/admin/vendors' };
    });
  }
  if (can('purchase_orders')) {
    add(async () => {
      const count = await PurchaseOrder.countDocuments({ status: 'open' });
      return { key: 'open_pos', label: 'Purchase orders open', hint: 'Buying trips not closed yet', count, level: count ? 'info' : 'ok', href: '/admin/purchasing/orders' };
    });
  }

  const items = (await Promise.all(jobs)).filter(Boolean);
  attentionCache.set(sig, { at: Date.now(), items });
  return items;
}

/** Stock value at landed cost and at sale price, pieces on shelves vs warehouse. */
async function stockSnapshot() {
  const unitsExpr = {
    $cond: [
      { $eq: ['$productType', 'variant'] },
      { $map: { input: { $ifNull: ['$variants', []] }, as: 'v', in: { stock: '$$v.stock', cost: '$$v.costPrice', price: '$$v.price' } } },
      [{ stock: '$stock', cost: '$costPrice', price: '$price' }],
    ],
  };
  const [groups, skus, outOfStock, shelvedRow, shelvesUsed, shelvesTotal] = await Promise.all([
    Product.aggregate([
      { $project: { isConsignment: 1, units: unitsExpr } },
      { $unwind: '$units' },
      { $match: { 'units.stock': { $gt: 0 } } },
      {
        $group: {
          _id: { $eq: ['$isConsignment', true] },
          pieces: { $sum: '$units.stock' },
          cost: { $sum: { $multiply: ['$units.stock', { $ifNull: ['$units.cost', 0] }] } },
          retail: { $sum: { $multiply: ['$units.stock', { $ifNull: ['$units.price', 0] }] } },
          noCost: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$units.cost', 0] }, 0] }, 0, 1] } },
        },
      },
    ]),
    Product.countDocuments({}),
    Product.countDocuments({ status: 'out_of_stock' }),
    LocationStock.aggregate([{ $match: { qty: { $gt: 0 } } }, { $group: { _id: null, pieces: { $sum: '$qty' } } }]),
    LocationStock.distinct('shelf', { qty: { $gt: 0 } }),
    Shelf.countDocuments({ isActive: true }),
  ]);
  const own = groups.find((g) => g._id === false) || { pieces: 0, cost: 0, retail: 0, noCost: 0 };
  const cons = groups.find((g) => g._id === true) || { pieces: 0, cost: 0, retail: 0 };
  const pieces = own.pieces + cons.pieces;
  const shelved = Math.min(pieces, shelvedRow[0] ? shelvedRow[0].pieces : 0);
  return {
    skus,
    outOfStock,
    pieces,
    shelvedPieces: shelved,
    warehousePieces: Math.max(0, pieces - shelved),
    shelvesUsed: shelvesUsed.length,
    shelvesTotal,
    valueAtCost: C.round2(own.cost),
    valueAtPrice: C.round2(own.retail),
    potentialProfit: C.round2(own.retail - own.cost),
    itemsWithoutCost: own.noCost, // lines with stock but no landed cost yet
    consignmentPieces: cons.pieces,
    consignmentValue: C.round2(cons.cost),
  };
}

async function tillsNow() {
  const [open, closedToVerify] = await Promise.all([
    CashSession.find({ status: 'open' }).populate('counter', 'name').populate('cashier', 'firstName lastName').sort({ openedAt: 1 }).lean(),
    CashSession.countDocuments({ status: 'closed' }),
  ]);
  return {
    open: open.map((s) => ({
      id: String(s._id),
      counterName: (s.counter && s.counter.name) || s.counterName || 'Counter',
      cashierName: s.cashier && typeof s.cashier === 'object' ? `${s.cashier.firstName || ''} ${s.cashier.lastName || ''}`.trim() : s.cashierName || '',
      openedAt: s.openedAt,
      lateOpen: !!s.lateOpen,
    })),
    toVerify: closedToVerify,
  };
}

/** Everything the dashboard shows. `req.access` decides the optional blocks. */
async function getDashboardData(req, rangeKey) {
  const range = resolveRange(rangeKey);
  const can = (keys) => [].concat(keys).some((k) => req.access.can(k, 'view'));

  const [now, prev, refundRow, trendRows, hours, paymentRows, sellers, bills, attentionItems, stock, tills] = await Promise.all([
    totals(range.from, range.to),
    totals(range.prevFrom, range.prevTo),
    refunds(range.from, range.to),
    trend(range),
    busyHours(range),
    payments(range),
    bestSellers(range),
    recentBills(),
    attention(req),
    can(['products', 'product_stock', 'report_stock']) ? stockSnapshot() : null,
    can(['till_verify', 'sale_counters']) ? tillsNow() : null,
  ]);

  return {
    range: {
      key: range.key,
      label: range.label,
      compareLabel: range.compareLabel,
      bucket: range.bucket,
      from: range.from,
      to: range.to,
      prevFrom: range.prevFrom,
      prevTo: range.prevTo,
      timezone: range.timezone,
    },
    generatedAt: new Date(),
    kpis: { ...now, refunds: refundRow, previous: prev },
    trend: trendRows,
    hours,
    payments: paymentRows,
    topProducts: sellers.products,
    topCategories: sellers.categories,
    recentBills: bills,
    attention: attentionItems,
    stock,
    tills,
  };
}

module.exports = { getDashboardData, resolveRange, RANGES };
