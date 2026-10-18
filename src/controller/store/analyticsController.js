// src/controller/store/analyticsController.js
// Reports & analytics (/api/analytics/...). Logic lives in services/analytics/*;
// every report has a JSON endpoint and a CSV export (same filters).
const demand = require('../../services/analytics/demandService');
const trends = require('../../services/analytics/trendsService');
const slowMoving = require('../../services/analytics/slowMovingService');
const expenses = require('../../services/analytics/expensesService');
const footfall = require('../../services/analytics/footfallService');
const categoryPerf = require('../../services/analytics/categoryPerformanceService');
const { listCategories } = require('../../services/analytics/categoryAssignmentService');
const Vendor = require('../../models/vendor');
const { resolveWriteBranch } = require('../../middleware/access');
const { sendCsv, csvDay } = require('../../services/analytics/csv');
const T = require('../../services/analytics/time');

const today = () => T.dayKey();
const ok = (res, data, meta, status = 200) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

// ---------------- Filter options (category / vendor dropdowns) ----------------

exports.filters = async (req, res) => {
  const [categories, vendors] = await Promise.all([
    listCategories(),
    Vendor.find({ isDeleted: { $ne: true } }).select('name isConsignment').sort({ name: 1 }).limit(1000).lean(),
  ]);
  ok(res, {
    categories: categories.filter((c) => c.products > 0 || c.inCatalog).map((c) => c.name),
    vendors: vendors.map((v) => ({ _id: String(v._id), name: v.name, isConsignment: !!v.isConsignment })),
  });
};

// ---------------- Demand list ----------------

exports.demand = async (req, res) => {
  const { data, meta } = await demand.demandReport(req, req.query);
  ok(res, data, meta);
};

exports.demandExport = async (req, res) => {
  const { rows } = await demand.buildDemand(req, req.query);
  sendCsv(res, `demand-list-${today()}`, [
    { label: 'Urgency', value: (r) => r.urgency },
    { label: 'Product', value: (r) => r.name },
    { label: 'Variant', value: (r) => r.variantLabel },
    { label: 'Code', value: (r) => r.code },
    { label: 'Category', value: (r) => r.category },
    { label: 'Branch', value: (r) => r.branchName },
    { label: 'Stock', value: (r) => r.stock },
    { label: 'Base qty', value: (r) => r.base },
    { label: 'Base from', value: (r) => r.baseSource },
    { label: 'Threshold %', value: (r) => r.thresholdPct },
    { label: '% left', value: (r) => r.pctLeft },
    { label: 'Last received', value: (r) => csvDay(r.lastReceivedAt) },
    { label: 'Last received qty', value: (r) => r.lastReceivedQty },
    { label: 'Fell below on', value: (r) => csvDay(r.crossedAt) },
    { label: 'Days to fall below', value: (r) => r.daysToCross },
    { label: 'Sold since receipt', value: (r) => r.soldSinceReceipt },
    { label: 'Avg daily sales (30d)', value: (r) => r.avgDailySales },
    { label: 'Days of cover', value: (r) => r.daysOfCover },
    { label: 'Suggested qty', value: (r) => r.suggestedQty },
    { label: 'Last vendor', value: (r) => r.vendorName },
    { label: 'Cheapest vendor', value: (r) => r.cheapestVendorName },
    { label: 'Cheapest price', value: (r) => r.cheapestPrice },
    { label: 'Landed cost', value: (r) => r.landedCost },
    { label: 'Sale price', value: (r) => r.salePrice },
    { label: 'Margin', value: (r) => r.margin },
    { label: 'Margin %', value: (r) => r.marginPct },
    { label: 'Reorder cost', value: (r) => r.reorderCost },
  ], rows);
};

exports.demandSettings = async (req, res) => ok(res, await demand.getSettings());

// Store-wide % / cover days: report_demand edit (super admin until that action
// is in the catalogue). Product par levels: the same, or products edit.
exports.saveDemandSettings = async (req, res) => {
  const a = req.access;
  const canGlobal = a.can('report_demand', 'edit');
  const result = await demand.saveSettings(req.body || {}, {
    userId: a.userId,
    canGlobal,
    canProducts: canGlobal || a.can('products', 'edit'),
  });
  ok(res, result);
};

// ---------------- Trends ----------------

exports.trends = async (req, res) => ok(res, await trends.trendsReport(req, req.query));

exports.trendsProduct = async (req, res) => ok(res, await trends.productTrend(req, req.query));

exports.trendsExport = async (req, res) => {
  const r = await trends.trendsReport(req, { ...req.query, top: req.query.top || 500 });
  const monthCols = (key) => r.months.map((m) => ({ label: `${T.monthLabel(m)} ${key}`, value: (row) => (row.months.find((x) => x.month === m) || {})[key] }));
  if (req.query.part === 'categories') {
    return sendCsv(res, `sales-trends-categories-${today()}`, [
      { label: 'Category', value: (c) => c.category },
      { label: 'Pieces', value: (c) => c.total.qty },
      { label: 'Net sales', value: (c) => c.total.revenue },
      { label: 'Profit', value: (c) => c.total.profit },
      { label: 'Best month', value: (c) => c.peakMonth },
      ...monthCols('revenue'),
    ], r.categories);
  }
  if (req.query.part === 'monthly') {
    return sendCsv(res, `sales-trends-monthly-${today()}`, [
      { label: 'Month', value: (m) => m.month },
      { label: 'Bills', value: (m) => m.bills },
      { label: 'Pieces', value: (m) => m.qty },
      { label: 'Gift pieces', value: (m) => m.giftQty },
      { label: 'Net sales', value: (m) => m.revenue },
      { label: 'Cost', value: (m) => m.cost },
      { label: 'Profit', value: (m) => m.profit },
      { label: 'Margin %', value: (m) => m.marginPct },
    ], r.monthly);
  }
  return sendCsv(res, `sales-trends-products-${today()}`, [
    { label: 'Product', value: (p) => p.name },
    { label: 'Category', value: (p) => p.category },
    { label: 'Pieces', value: (p) => p.total.qty },
    { label: 'Net sales', value: (p) => p.total.revenue },
    { label: 'Profit', value: (p) => p.total.profit },
    ...monthCols('qty'),
  ], r.products);
};

// ---------------- Slow moving ----------------

exports.slowMoving = async (req, res) => {
  const { data, meta } = await slowMoving.slowMovingReport(req, req.query);
  ok(res, data, meta);
};

exports.slowMovingExport = async (req, res) => {
  const { rows } = await slowMoving.buildSlowMoving(req, req.query);
  sendCsv(res, `slow-moving-${today()}`, [
    { label: 'Product', value: (r) => r.name },
    { label: 'Variant', value: (r) => r.variantLabel },
    { label: 'Code', value: (r) => r.code },
    { label: 'Category', value: (r) => r.category },
    { label: 'Branch', value: (r) => r.branchName },
    { label: 'Vendor', value: (r) => r.vendorName },
    { label: 'Consignment', value: (r) => (r.isConsignment ? 'yes' : '') },
    { label: 'Received on', value: (r) => csvDay(r.receivedAt) },
    { label: 'Received qty', value: (r) => r.receivedQty },
    { label: 'Days', value: (r) => r.days },
    { label: 'Sold qty', value: (r) => r.soldQty },
    { label: 'Sold %', value: (r) => r.soldPct },
    { label: 'Stock', value: (r) => r.stock },
    { label: 'Cost price', value: (r) => r.costPrice },
    { label: 'Stock value (cost)', value: (r) => r.stockValue },
    { label: 'Shelves', value: (r) => r.shelves.map((s) => `${s.code} (${s.qty})`).join(' ') },
    { label: 'Action', value: (r) => r.action },
    { label: 'Action qty', value: (r) => r.actionQty },
    { label: 'Why', value: (r) => r.reason },
  ], rows);
};

exports.saveSlowMovingSettings = async (req, res) => ok(res, await slowMoving.saveSettings(req.body || {}, req.access.userId));

// ---------------- Expenses ----------------

exports.expenses = async (req, res) => {
  const { data, meta } = await expenses.expensesReport(req, req.query);
  ok(res, data, meta);
};

exports.expensesExport = async (req, res) => {
  if (req.query.part === 'periods') {
    const { data } = await expenses.expensesReport(req, { ...req.query, limit: 1 });
    return sendCsv(res, `expenses-by-${data.range.groupBy}-${data.range.from}-${data.range.to}`, [
      { label: 'Period', value: (p) => p.label },
      { label: 'Start', value: (p) => p.key },
      { label: 'Entries', value: (p) => p.count },
      { label: 'Total', value: (p) => p.total },
      { label: 'Shop use', value: (p) => p.shopUse },
      { label: 'Other expenses', value: (p) => p.other },
      ...data.categoriesInPeriods.map((c) => ({ label: c, value: (p) => p.categories[c] || 0 })),
    ], data.periods);
  }
  const rows = await expenses.expenseRows(req, req.query);
  return sendCsv(res, `expenses-${today()}`, [
    { label: 'Date', value: (e) => csvDay(e.date) },
    { label: 'Title', value: (e) => e.title },
    { label: 'Category', value: (e) => e.category },
    { label: 'Amount', value: (e) => e.amount },
    { label: 'Shop use', value: (e) => (e.source === 'shop_use' ? 'yes' : '') },
    { label: 'Source', value: (e) => e.source || 'manual' },
    { label: 'Payment method', value: (e) => e.paymentMethod },
    { label: 'Reference', value: (e) => e.reference },
    { label: 'Notes', value: (e) => e.notes },
  ], rows);
};

// ---------------- Footfall ----------------

exports.footfall = async (req, res) => ok(res, await footfall.footfallReport(req, req.query));

exports.footfallExport = async (req, res) => {
  const r = await footfall.footfallReport(req, req.query);
  if (req.query.part === 'hours') {
    return sendCsv(res, `footfall-hours-${r.range.from}-${r.range.to}`, [
      { label: 'Weekday', value: (d) => d.label },
      ...Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, value: (d) => d.hours[h].bills })),
    ], r.heatmap);
  }
  return sendCsv(res, `footfall-${r.range.from}-${r.range.to}`, [
    { label: 'Day', value: (d) => d.day },
    { label: 'Weekday', value: (d) => d.weekday },
    { label: 'Bills', value: (d) => d.bills },
    { label: 'Buyers', value: (d) => d.buyers },
    { label: 'Sales', value: (d) => d.sales },
    { label: 'Avg bill', value: (d) => d.avgBill },
    { label: 'Items per bill', value: (d) => d.itemsPerBill },
    { label: 'Visitors', value: (d) => d.visitors },
    { label: 'Conversion %', value: (d) => d.conversionPct },
  ], r.days);
};

exports.footfallEntries = async (req, res) => ok(res, await footfall.listEntries(req, req.query));

exports.saveFootfallEntry = async (req, res) => {
  const branchId = await resolveWriteBranch(req);
  const { entry, created } = await footfall.saveEntry(branchId, req.body || {}, req.access.userId);
  ok(res, entry, undefined, created ? 201 : 200);
};

exports.updateFootfallEntry = async (req, res) => ok(res, await footfall.updateEntry(req, req.params.id, req.body || {}, req.access.userId));

exports.deleteFootfallEntry = async (req, res) => ok(res, await footfall.deleteEntry(req, req.params.id));

// ---------------- Category performance ----------------

exports.categoryPerformance = async (req, res) => ok(res, await categoryPerf.categoryPerformance(req, req.query));

exports.categoryPerformanceExport = async (req, res) => {
  const r = await categoryPerf.categoryPerformance(req, req.query);
  if (req.query.part === 'employees') {
    return sendCsv(res, `employee-progress-${r.range.from}-${r.range.to}`, [
      { label: 'Rank', value: (e) => e.rank },
      { label: 'Employee', value: (e) => e.name },
      { label: 'Position', value: (e) => e.position },
      { label: 'Credited sales', value: (e) => e.credited },
      { label: 'Credited profit', value: (e) => e.profit },
      { label: 'Target', value: (e) => e.target },
      { label: 'Progress %', value: (e) => e.progressPct },
      { label: 'Categories', value: (e) => e.categories.map((c) => `${c.category} (${c.sharePct}%)`).join('; ') },
    ], r.employees);
  }
  return sendCsv(res, `category-performance-${r.range.from}-${r.range.to}`, [
    { label: 'Category', value: (c) => c.category },
    { label: 'Pieces', value: (c) => c.qty },
    { label: 'Net sales', value: (c) => c.revenue },
    { label: 'Cost', value: (c) => c.cost },
    { label: 'Profit', value: (c) => c.profit },
    { label: 'Margin %', value: (c) => c.marginPct },
    { label: 'Share of sales %', value: (c) => c.salesSharePct },
    { label: 'Target', value: (c) => c.target },
    { label: 'Target %', value: (c) => c.targetPct },
    { label: 'Staff', value: (c) => c.employees.map((e) => `${e.name} (${e.sharePct}%: ${e.credited})`).join('; ') },
  ], r.categories);
};
