// Financial statements (owner, 2026-11-17): Income Statement, Balance Sheet and
// Cash Flow Statement, worked out from the records the shop already keeps.
// There is no general ledger yet, so each line reads its own source:
//
// INCOME STATEMENT (a period, Pakistan days)
//   Net sales        bill lines (price x qty - discounts), tax left out       analytics/sales.js
//   - Refunds        expenses in the "Refund" category (money back, stock kept).
//                    Bills refunded in full are already out of the sales.
//   - Cost of goods  cost snapshot x qty of every line sold (trip costs are
//                    inside the landed cost, so they are NOT an expense here)
//   = Gross profit
//   - Expenses       every expense by category (salaries, shop use, ...);
//                    display-only rows (trip costs paid from a till) left out
//   - Damage         approved damage records (cost of the lost stock)
//   - Stock count    applied stock adjustments: value out - value in
//   - Depreciation   straight-line on fixed assets for the days in the period
//   = Net profit
//
// BALANCE SHEET (now; stock has no history to value it on an older day)
//   Assets       cash + bank (Cash in Hand "money left"), stock at cost
//                (consignment stock is the vendor's), salary advances,
//                vendor advances, fixed assets at book value
//   Liabilities  owed to vendors, loans, salaries approved but not paid,
//                investment bills not paid yet, sales tax collected
//   Equity       partner money (investments paid) + profit since 25 Oct 2026;
//                what is left over is shown as a difference line, so a missing
//                record is visible instead of hidden.
//
// CASH FLOW (a period): the Cash in Hand movements (start balance onwards),
//   grouped as operating / financing; opening + net change = closing.

const mongoose = require('mongoose');
const { salesLines } = require('../analytics/sales');
const { SALE_MATCH } = require('../analytics/common');
const { depreciate } = require('../hr/depreciation');
const { funds } = require('./fundsReport');
const { jazzcash } = require('./jazzcashReport');

const START = '2026-10-25'; // system start
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const pkStart = (d) => new Date(`${d}T00:00:00.000+05:00`);
const pkEnd = (d) => new Date(`${d}T23:59:59.999+05:00`);
const pkToday = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
const NOT_DELETED = { isDeleted: { $ne: true } };
const REFUND_RX = /^\s*refund\s*$/i;

function range(query = {}) {
  const from = String(query.from || START);
  const to = String(query.to || pkToday());
  if (!DAY.test(from) || !DAY.test(to)) throw bad('Dates must be YYYY-MM-DD');
  if (from > to) throw bad('"From" is after "To"');
  return { from, to, start: pkStart(from), end: pkEnd(to) };
}

const isRefundExpense = (e) => {
  const list = [e.category, ...(Array.isArray(e.categories) ? e.categories : [])]
    .flatMap((c) => String(c || '').split(','))
    .filter(Boolean);
  return list.some((c) => REFUND_RX.test(c));
};

// Expense categories that buy things the shop keeps (capital spend, not a cost).
const CAPITAL_EXPENSE = /^shop\s*setup\b/i;

/** Depreciation of one asset between two moments (stops at disposal). */
function assetDepreciation(a, start, end) {
  const qty = Number(a.quantity) || 1;
  const args = {
    cost: (Number(a.purchasePrice) || 0) * qty,
    salvage: (Number(a.salvageValue) || 0) * qty,
    lifeYears: a.usefulLifeYears,
    method: a.depreciationMethod,
    purchaseDate: a.purchaseDate,
  };
  const stop = a.disposal && a.disposal.date ? new Date(a.disposal.date) : null;
  const cap = (d) => (stop && stop < d ? stop : d);
  const at = (d) => (a.purchaseDate && new Date(a.purchaseDate) < d ? depreciate({ ...args, asOf: cap(d) }).accumulated : 0);
  return Math.max(0, at(end) - at(start));
}

/**
 * Trip-cost share of each product's landed cost (owner 2026-11-17: show goods and
 * trip costs apart). From the goods receipts: trip part = landed − vendor price.
 * -> Map productId -> share (0..1) of the landed cost that is trip costs.
 */
async function tripShares() {
  const db = mongoose.connection.db;
  const [fromEntries, fromLines] = await Promise.all([
    db
      .collection('goodsreceipts')
      .aggregate([
        { $unwind: '$entries' },
        { $match: { 'entries.posted': true, 'entries.landedUnitCost': { $gt: 0 } } },
        {
          $project: {
            p: '$entries.product',
            pcs: { $ifNull: ['$entries.stockQty', '$entries.qty'] },
            landed: '$entries.landedUnitCost',
            price: '$entries.costPrice',
          },
        },
        { $group: { _id: '$p', landed: { $sum: { $multiply: ['$pcs', '$landed'] } }, trip: { $sum: { $multiply: ['$pcs', { $max: [0, { $subtract: ['$landed', '$price'] }] }] } } } },
      ])
      .toArray(),
    db
      .collection('goodsreceipts')
      .aggregate([
        { $unwind: '$lines' },
        { $match: { 'lines.posted': true, 'lines.landedUnitCost': { $gt: 0 } } },
        { $group: { _id: '$lines.product', landed: { $sum: { $multiply: ['$lines.acceptedQty', '$lines.landedUnitCost'] } }, trip: { $sum: { $ifNull: ['$lines.allocatedCharges', 0] } } } },
      ])
      .toArray(),
  ]);
  const acc = new Map();
  for (const r of [...fromEntries, ...fromLines]) {
    const k = String(r._id);
    const a = acc.get(k) || { landed: 0, trip: 0 };
    a.landed += Number(r.landed) || 0;
    a.trip += Number(r.trip) || 0;
    acc.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of acc) if (a.landed > 0) out.set(k, Math.min(1, Math.max(0, a.trip / a.landed)));
  return out;
}

const CHARGE_LABELS = {
  car_rent: 'Car rent',
  transport: 'Transport',
  builty_freight: 'Builty / freight',
  loading: 'Loading',
  unloading: 'Unloading',
  landing: 'Landing',
  labour: 'Labour',
  misc: 'Other trip costs',
};

/**
 * Trip costs of the goods sold, split by charge type (owner 2026-11-20). Each product's
 * trip part comes from its goods receipts; a receipt's trip part is split by that trip's
 * own charges (car rent, builty, loading ...). Adds up to the "Trip costs" line.
 */
async function tripByType(orderMatch) {
  const db = mongoose.connection.db;
  const [entryRows, lineRows] = await Promise.all([
    db
      .collection('goodsreceipts')
      .aggregate([
        { $unwind: '$entries' },
        { $match: { 'entries.posted': true, 'entries.landedUnitCost': { $gt: 0 } } },
        {
          $project: {
            po: '$purchaseOrder',
            p: '$entries.product',
            landed: { $multiply: [{ $ifNull: ['$entries.stockQty', '$entries.qty'] }, '$entries.landedUnitCost'] },
            trip: { $multiply: [{ $ifNull: ['$entries.stockQty', '$entries.qty'] }, { $max: [0, { $subtract: ['$entries.landedUnitCost', '$entries.costPrice'] }] }] },
          },
        },
      ])
      .toArray(),
    db
      .collection('goodsreceipts')
      .aggregate([
        { $unwind: '$lines' },
        { $match: { 'lines.posted': true, 'lines.landedUnitCost': { $gt: 0 } } },
        {
          $project: {
            po: '$purchaseOrder',
            p: '$lines.product',
            landed: { $multiply: ['$lines.acceptedQty', '$lines.landedUnitCost'] },
            trip: { $ifNull: ['$lines.allocatedCharges', 0] },
          },
        },
      ])
      .toArray(),
  ]);
  const rows = [...entryRows, ...lineRows];
  const poIds = [...new Set(rows.map((r) => r.po && String(r.po)).filter(Boolean))];
  const pos = poIds.length
    ? await db.collection('purchaseorders').find({ _id: { $in: poIds.map((x) => new mongoose.Types.ObjectId(x)) } }).project({ charges: 1 }).toArray()
    : [];
  // Charge-type mix of each trip.
  const mix = new Map();
  for (const po of pos) {
    const by = {};
    let t = 0;
    for (const c of po.charges || []) {
      const a = Number(c.amount) || 0;
      by[c.type || 'misc'] = (by[c.type || 'misc'] || 0) + a;
      t += a;
    }
    if (t > 0) mix.set(String(po._id), Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v / t])));
  }
  // Per product: landed total and trip amount per type.
  const prod = new Map();
  for (const r of rows) {
    const k = String(r.p);
    const a = prod.get(k) || { landed: 0, types: {} };
    a.landed += Number(r.landed) || 0;
    const trip = Number(r.trip) || 0;
    const m = (r.po && mix.get(String(r.po))) || { misc: 1 };
    for (const [type, share] of Object.entries(m)) a.types[type] = (a.types[type] || 0) + trip * share;
    prod.set(k, a);
  }
  // Sold lines: cost x (trip of type / landed).
  const lines = await salesLines({ orderMatch, groupBy: {} });
  const out = {};
  for (const l of lines) {
    const a = prod.get(String(l.productId));
    if (!a || !(a.landed > 0)) continue;
    for (const [type, amt] of Object.entries(a.types)) {
      const share = Math.min(1, amt / a.landed);
      out[type] = (out[type] || 0) + l.cost * share;
    }
  }
  return Object.entries(out)
    .map(([type, amount]) => ({ type, label: CHARGE_LABELS[type] || type, amount: round2(amount) }))
    .filter((x) => x.amount !== 0)
    .sort((x, y) => y.amount - x.amount);
}

/**
 * Net sales / cost / gross profit per counter (owner 2026-11-20). Same line rules as
 * the totals; a bill's counter is its own, else its till's.
 */
async function counterSales(orderMatch) {
  const db = mongoose.connection.db;
  const lines = await salesLines({ orderMatch, groupBy: { c: '$counter', s: '$cashSession' } });
  const counterIds = [...new Set(lines.map((l) => l.key.c).filter(Boolean).map(String))];
  const sessionIds = [...new Set(lines.filter((l) => !l.key.c && l.key.s).map((l) => l.key.s))];
  const [counters, sessions] = await Promise.all([
    counterIds.length ? db.collection('salecounters').find({ _id: { $in: counterIds.map((x) => new mongoose.Types.ObjectId(x)) } }).project({ name: 1 }).toArray() : [],
    sessionIds.length ? db.collection('cashsessions').find({ _id: { $in: sessionIds } }).project({ counter: 1, counterName: 1 }).toArray() : [],
  ]);
  const cName = new Map(counters.map((c) => [String(c._id), c.name]));
  const sName = new Map(sessions.map((s) => [String(s._id), (s.counter && cName.get(String(s.counter))) || s.counterName || null]));
  const acc = new Map();
  for (const l of lines) {
    const name = (l.key.c && cName.get(String(l.key.c))) || (l.key.s && sName.get(String(l.key.s))) || 'No counter';
    const a = acc.get(name) || { counter: name, netSales: 0, cost: 0, qty: 0 };
    a.netSales += l.revenue;
    a.cost += l.cost;
    a.qty += l.qty;
    acc.set(name, a);
  }
  return [...acc.values()]
    .map((a) => ({ counter: a.counter, netSales: round2(a.netSales), cost: round2(a.cost), grossProfit: round2(a.netSales - a.cost), itemsSold: a.qty }))
    .sort((x, y) => x.counter.localeCompare(y.counter));
}

/**
 * Goods (vendor price) of what was sold, per vendor, and what was paid to each vendor
 * in the period (owner 2026-11-20). A sold piece's vendor is the stock code it was
 * scanned with; otherwise the product's own code, else its latest stock.
 */
async function vendorGoods(orderMatch, start, end, shares) {
  const db = mongoose.connection.db;
  const [groups, payments] = await Promise.all([
    db
      .collection('posorders')
      .aggregate([
        { $match: orderMatch },
        { $unwind: '$items' },
        { $match: { 'items.product': { $ne: null } } },
        {
          $group: {
            _id: { p: '$items.product', code: { $toUpper: { $ifNull: ['$items.scannedCode', ''] } } },
            qty: { $sum: '$items.quantity' },
            snapCost: { $sum: { $cond: [{ $isNumber: '$items.costPrice' }, { $multiply: ['$items.costPrice', '$items.quantity'] }, 0] } },
            noCostQty: { $sum: { $cond: [{ $isNumber: '$items.costPrice' }, 0, '$items.quantity'] } },
          },
        },
      ])
      .toArray(),
    db
      .collection('vendorpayments')
      .aggregate([
        { $match: { status: { $ne: 'voided' }, date: { $gte: start, $lte: end } } },
        { $group: { _id: '$vendor', paid: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const pids = [...new Set(groups.map((g) => String(g._id.p)))];
  const products = pids.length
    ? await db
        .collection('products')
        .find({ _id: { $in: pids.map((x) => new mongoose.Types.ObjectId(x)) } })
        .project({ costPrice: 1, 'stockCodes.code': 1, 'stockCodes.vendor': 1, 'stockCodes.vendorName': 1, 'stockCodes.plain': 1, 'stockCodes.undone': 1, 'stockCodes.createdAt': 1 })
        .toArray()
    : [];
  const byP = new Map(products.map((p) => [String(p._id), p]));
  // Products with no vendor on their stock codes: vendor of their latest posted goods receipt.
  const noCode = products.filter((p) => !(p.stockCodes || []).some((c) => c && c.vendor)).map((p) => p._id);
  const grnVendor = new Map(
    noCode.length
      ? (
          await db
            .collection('goodsreceipts')
            .aggregate([
              { $match: { 'entries.product': { $in: noCode } } },
              { $unwind: '$entries' },
              { $match: { 'entries.product': { $in: noCode }, 'entries.posted': true } },
              { $sort: { createdAt: -1 } },
              {
                $group: {
                  _id: '$entries.product',
                  vendor: { $first: { $ifNull: ['$entries.vendor', '$vendor'] } },
                  vendorName: { $first: { $ifNull: ['$entries.vendorName', '$vendorName'] } },
                },
              },
            ])
            .toArray()
        ).map((r) => [String(r._id), r])
      : []
  );
  const acc = new Map();
  const bump = (id, name) => {
    const k = id ? String(id) : 'none';
    const a = acc.get(k) || { vendorId: id ? String(id) : null, name: name || '', goodsCost: 0, qty: 0, paid: 0, payments: 0 };
    if (!a.name && name) a.name = name;
    acc.set(k, a);
    return a;
  };
  for (const g of groups) {
    const p = byP.get(String(g._id.p));
    const codes = ((p && p.stockCodes) || []).filter((c) => c && c.vendor);
    const live = codes.filter((c) => !c.undone);
    const sc =
      (g._id.code && codes.find((c) => String(c.code || '').toUpperCase() === g._id.code)) ||
      live.find((c) => c.plain) ||
      live.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] ||
      grnVendor.get(String(g._id.p)) ||
      null;
    const cost = g.snapCost + g.noCostQty * ((p && Number(p.costPrice)) || 0);
    const goods = cost * (1 - (shares.get(String(g._id.p)) || 0)); // vendor price part (trip costs out)
    const a = bump(sc && sc.vendor, sc && sc.vendorName);
    a.goodsCost += goods;
    a.qty += g.qty;
  }
  for (const pay of payments) {
    const a = bump(pay._id, '');
    a.paid += pay.paid;
    a.payments += pay.count;
  }
  const ids = [...acc.values()].map((a) => a.vendorId).filter(Boolean);
  const vendors = ids.length
    ? await db.collection('vendors').find({ _id: { $in: ids.map((x) => new mongoose.Types.ObjectId(x)) } }).project({ name: 1 }).toArray()
    : [];
  const vName = new Map(vendors.map((v) => [String(v._id), v.name]));
  return [...acc.values()]
    .map((a) => ({
      vendorId: a.vendorId,
      name: (a.vendorId && vName.get(a.vendorId)) || a.name || (a.vendorId ? 'Deleted vendor' : 'No vendor on record'),
      goodsCost: round2(a.goodsCost),
      qty: a.qty,
      paid: round2(a.paid),
      payments: a.payments,
    }))
    .sort((x, y) => y.goodsCost - x.goodsCost || y.paid - x.paid);
}

// ---------------------------------------------------------------------------
// Income statement
// ---------------------------------------------------------------------------
/** Money of manual POS lines (no product) on the matched bills: (price × qty − line discount) × bill factor. */
async function manualSales(orderMatch) {
  const rows = await mongoose.connection.db
    .collection('posorders')
    .aggregate([
      { $match: orderMatch },
      {
        $project: {
          items: 1,
          factor: {
            $cond: [{ $gt: ['$subtotal', 0] }, { $max: [0, { $min: [1, { $divide: [{ $subtract: ['$subtotal', { $ifNull: ['$discount', 0] }] }, '$subtotal'] }] }] }, 1],
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.product': null, 'items.isGift': { $ne: true } } },
      {
        $group: {
          _id: null,
          revenue: { $sum: { $multiply: [{ $max: [0, { $subtract: [{ $multiply: ['$items.price', '$items.quantity'] }, { $ifNull: ['$items.discount', 0] }] }] }, '$factor'] } },
        },
      },
    ])
    .toArray();
  return (rows[0] && rows[0].revenue) || 0;
}

async function incomeFor(start, end) {
  const db = mongoose.connection.db;
  const orderMatch = { ...SALE_MATCH, createdAt: { $gte: start, $lte: end } };

  // Bills of the period refunded in full (owner 2026-11-20): shown in Sales and again
  // in Refunds, so "Refunds given" holds every refund; net sales does not change.
  const refundedMatch = {
    isDeleted: { $ne: true },
    orderStatus: { $ne: 'cancelled' },
    $or: [{ orderStatus: 'refunded' }, { paymentStatus: 'refunded' }],
    createdAt: { $gte: start, $lte: end },
  };
  const [lines, billAgg, expenses, damage, adjust, assets, refundedLines] = await Promise.all([
    salesLines({ orderMatch, groupBy: {} }),
    db
      .collection('posorders')
      .aggregate([
        { $match: orderMatch },
        { $group: { _id: null, bills: { $sum: 1 }, discount: { $sum: { $ifNull: ['$discount', 0] } }, tax: { $sum: { $ifNull: ['$tax', 0] } } } },
      ])
      .toArray(),
    db
      .collection('expenses')
      .find({ ...NOT_DELETED, displayOnly: { $ne: true }, date: { $gte: start, $lte: end } })
      .project({ amount: 1, category: 1, categories: 1, source: 1, loanRepayLoan: 1, partner: 1, title: 1, date: 1, investment: 1 })
      .toArray(),
    db
      .collection('damagerecords')
      .aggregate([
        { $match: { status: 'approved', date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$totalLoss', 0] } }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('stockadjustments')
      .aggregate([
        { $match: { status: 'applied', $expr: { $and: [{ $gte: [{ $ifNull: ['$appliedAt', '$createdAt'] }, start] }, { $lte: [{ $ifNull: ['$appliedAt', '$createdAt'] }, end] }] } } },
        { $group: { _id: null, out: { $sum: { $ifNull: ['$totals.valueOut', 0] } }, in: { $sum: { $ifNull: ['$totals.valueIn', 0] } }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('assets')
      .find({ ...NOT_DELETED, purchaseDate: { $lte: end } })
      .project({ purchasePrice: 1, quantity: 1, salvageValue: 1, usefulLifeYears: 1, depreciationMethod: 1, purchaseDate: 1, disposal: 1 })
      .toArray(),
    salesLines({ orderMatch: refundedMatch, groupBy: {} }).catch(() => []),
  ]);
  // Owner 2026-11-20: manual items (typed at the POS, no product) are real sales: the cash is in
  // the till, so their money counts as sales too. They take no stock, so no cost is added.
  const manualRevenue = await manualSales(orderMatch).catch(() => 0);
  const manualRefunded = await manualSales(refundedMatch).catch(() => 0);
  const fullRefunds = refundedLines.reduce((t, l) => t + (l.revenue || 0), 0) + manualRefunded;

  let revenue = 0;
  let cogs = 0;
  let qty = 0;
  let tripPart = 0;
  const shares = await tripShares().catch(() => new Map());
  revenue += manualRevenue;
  for (const l of lines) {
    revenue += l.revenue;
    cogs += l.cost;
    qty += l.qty;
    tripPart += l.cost * (shares.get(String(l.productId)) || 0);
  }
  const b = billAgg[0] || { bills: 0, discount: 0, tax: 0 };

  let refunds = 0;
  const byCat = new Map();
  let equipmentBought = 0;
  const equipmentItems = []; // each asset bought from shop money (shown under "Assets purchased")
  for (const e of expenses) {
    const amount = Number(e.amount) || 0;
    if (e.loanRepayLoan || e.partner) continue; // paying back a loan / a partner taking money is not a cost
    if (isRefundExpense(e)) {
      refunds += amount;
      continue;
    }
    const cat = String(e.category || 'Other').split(',')[0].trim() || 'Other';
    // Owner 2026-11-20 (final): every asset paid from shop money in the period comes off the
    // profit as "Assets purchased" (so profit is after ALL money spent): equipment bought
    // (Shop Setup / Equipment, also when it is on Fixed assets) and payments on an investment
    // bill (e.g. the electrical work, camera, sign board).
    if (CAPITAL_EXPENSE.test(cat) || e.investment) {
      equipmentBought += amount;
      equipmentItems.push({ title: e.title || cat, amount: round2(amount), date: e.date || null });
      continue;
    }
    // Shop use: automatic rows and hand-typed "Shop Use ..." categories are one line (owner 2026-11-17).
    const name = e.source === 'payroll' ? 'Salaries' : e.source === 'shop_use' || /^shop\s*use\b/i.test(cat) ? 'Shop use (own stock)' : cat;
    const row = byCat.get(name) || { category: name, amount: 0, count: 0 };
    row.amount += amount;
    row.count += 1;
    byCat.set(name, row);
  }
  const expenseRows = [...byCat.values()].map((r) => ({ ...r, amount: round2(r.amount) })).sort((x, y) => y.amount - x.amount);
  const totalExpenses = expenseRows.reduce((t, r) => t + r.amount, 0);

  const damageLoss = (damage[0] && damage[0].total) || 0;
  const countLoss = adjust[0] ? (adjust[0].out || 0) - (adjust[0].in || 0) : 0;
  const depreciation = assets.reduce((t, a) => t + assetDepreciation(a, start, end), 0);

  const netSales = revenue - refunds; // refunded bills are not in `revenue`
  const gross = netSales - cogs;
  // Owner 2026-11-20: "Assets purchased" sits right after the operating expenses, so it is
  // taken off before the operating profit (net profit is the same either way).
  const otherCosts = damageLoss + countLoss + depreciation;
  const operating = gross - totalExpenses - equipmentBought;
  const net = operating - otherCosts;
  const pct = (n) => (netSales > 0 ? Math.round((n / netSales) * 1000) / 10 : null);

  return {
    bills: b.bills,
    itemsSold: qty,
    sales: round2(revenue + fullRefunds), // incl. bills refunded later (taken off again in refunds)
    billDiscounts: round2(b.discount),
    taxCollected: round2(b.tax),
    refunds: round2(refunds + fullRefunds), // whole bills + part refunds
    refundsFull: round2(fullRefunds),
    refundsPartial: round2(refunds),
    netSales: round2(netSales),
    costOfGoods: round2(cogs),
    // Cost of goods split: vendor price of what was sold + its share of trip costs.
    goodsCost: round2(cogs - tripPart),
    tripCost: round2(tripPart),
    grossProfit: round2(gross),
    grossMargin: pct(gross),
    expenses: expenseRows,
    totalExpenses: round2(totalExpenses),
    equipmentBought: round2(equipmentBought), // "Shop Setup / Equipment" spend, kept out of expenses
    equipmentItems: equipmentItems.sort((x, y) => new Date(x.date || 0) - new Date(y.date || 0)),
    operatingProfit: round2(operating),
    damage: round2(damageLoss),
    damageCount: (damage[0] && damage[0].count) || 0,
    stockCount: round2(countLoss),
    depreciation: round2(depreciation),
    otherCosts: round2(otherCosts),
    netProfit: round2(net),
    netMargin: pct(net),
  };
}

async function incomeStatement(query = {}) {
  const r = range(query);
  const current = await incomeFor(r.start, r.end);
  // Per counter and per vendor (current period only; a breakdown never blocks the statement).
  const orderMatch = { ...SALE_MATCH, createdAt: { $gte: r.start, $lte: r.end } };
  const shares = await tripShares().catch(() => new Map());
  const [byCounter, byVendor, tripTypes] = await Promise.all([
    counterSales(orderMatch).catch((e) => (console.error('[fin] by counter', e.message), null)),
    vendorGoods(orderMatch, r.start, r.end, shares).catch((e) => (console.error('[fin] by vendor', e.message), null)),
    tripByType(orderMatch).catch((e) => (console.error('[fin] trip by type', e.message), null)),
  ]);
  current.byCounter = byCounter;
  current.byVendor = byVendor;
  current.tripByType = tripTypes;
  // Same number of days just before, for comparison.
  let previous = null;
  if (String(query.compare || '1') !== '0') {
    const days = Math.round((r.end - r.start) / 86400000);
    const pEnd = new Date(r.start.getTime() - 1);
    const pStart = new Date(r.start.getTime() - days * 86400000);
    if (pEnd >= pkStart(START)) previous = { from: new Date(pStart.getTime() + 5 * 3600000).toISOString().slice(0, 10), to: new Date(pEnd.getTime() + 5 * 3600000).toISOString().slice(0, 10), ...(await incomeFor(pStart < pkStart(START) ? pkStart(START) : pStart, pEnd)) };
  }
  return { range: { from: r.from, to: r.to, systemStart: START }, current, previous };
}

// ---------------------------------------------------------------------------
// Balance sheet (as of now)
// ---------------------------------------------------------------------------
async function balanceSheet() {
  const db = mongoose.connection.db;
  const now = new Date();

  const [money, stockAgg, consignAgg, advances, ledger, assets, loans, payroll, investments, taxAgg, profit] = await Promise.all([
    funds(),
    db
      .collection('products')
      .aggregate([
        { $match: { ...NOT_DELETED, isConsignment: { $ne: true }, stock: { $gt: 0 } } },
        { $group: { _id: null, value: { $sum: { $multiply: ['$stock', { $ifNull: ['$costPrice', 0] }] } }, units: { $sum: '$stock' }, products: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('products')
      .aggregate([
        { $match: { ...NOT_DELETED, isConsignment: true, stock: { $gt: 0 } } },
        { $group: { _id: null, value: { $sum: { $multiply: ['$stock', { $ifNull: ['$consignmentRate', { $ifNull: ['$costPrice', 0] }] }] } }, units: { $sum: '$stock' } } },
      ])
      .toArray(),
    db
      .collection('salaryadvances')
      .aggregate([{ $match: { status: 'open' } }, { $group: { _id: null, total: { $sum: { $ifNull: ['$balance', 0] } }, count: { $sum: 1 } } }])
      .toArray(),
    db
      .collection('vendorledgerentries')
      .aggregate([
        { $match: { isVoided: { $ne: true } } },
        { $group: { _id: '$vendor', name: { $last: '$vendorName' }, balance: { $sum: { $subtract: [{ $ifNull: ['$credit', 0] }, { $ifNull: ['$debit', 0] }] } } } },
      ])
      .toArray(),
    db
      .collection('assets')
      .find({ ...NOT_DELETED, status: { $nin: ['sold', 'disposed'] } })
      .project({ name: 1, purchasePrice: 1, quantity: 1, salvageValue: 1, usefulLifeYears: 1, depreciationMethod: 1, purchaseDate: 1 })
      .toArray(),
    db
      .collection('loans')
      .find({ ...NOT_DELETED })
      .project({ amount: 1, repayments: 1, lenderName: 1, loanNo: 1 })
      .toArray(),
    db
      .collection('payrollruns')
      .aggregate([{ $match: { status: { $in: ['approved', 'paid'] } } }, { $group: { _id: null, unpaid: { $sum: { $ifNull: ['$totals.unpaid', 0] } } } }])
      .toArray(),
    db
      .collection('investments')
      .find({ ...NOT_DELETED })
      .project({ amount: 1, paidAmount: 1, balance: 1, partner: 1, startupCost: 1 })
      .toArray(),
    db
      .collection('posorders')
      .aggregate([{ $match: SALE_MATCH }, { $group: { _id: null, tax: { $sum: { $ifNull: ['$tax', 0] } } } }])
      .toArray(),
    incomeFor(pkStart(START), now),
  ]);

  // Vendors: credit - debit > 0 = we owe them; < 0 = we paid ahead.
  let payables = 0;
  let vendorAdvances = 0;
  for (const v of ledger) {
    if (v.balance > 0.005) payables += v.balance;
    else if (v.balance < -0.005) vendorAdvances += -v.balance;
  }

  let fixedCost = 0;
  let fixedDep = 0;
  for (const a of assets) {
    const qty = Number(a.quantity) || 1;
    const cost = (Number(a.purchasePrice) || 0) * qty;
    fixedCost += cost;
    fixedDep += depreciate({ cost, salvage: (Number(a.salvageValue) || 0) * qty, lifeYears: a.usefulLifeYears, method: a.depreciationMethod, purchaseDate: a.purchaseDate, asOf: now }).accumulated;
  }

  let loansLeft = 0;
  for (const l of loans) {
    const paid = (l.repayments || []).reduce((t, x) => t + (Number(x.amount) || 0), 0);
    loansLeft += Math.max(0, (Number(l.amount) || 0) - paid);
  }

  // Investment bills: paid by partners (capital) and part still unpaid.
  const pids = [...new Set(investments.map((i) => String(i.partner || '')).filter((x) => /^[a-f\d]{24}$/i.test(x)))];
  const partners = pids.length
    ? await db.collection('investmentpartners').find({ _id: { $in: pids.map((x) => new mongoose.Types.ObjectId(x)) } }).project({ name: 1 }).toArray()
    : [];
  const pname = new Map(partners.map((p) => [String(p._id), p.name || 'Partner']));
  const byPartner = new Map();
  let capital = 0;
  let investUnpaid = 0;
  let startupCosts = 0; // partner money spent on start-up costs that are not assets
  for (const i of investments) {
    const paid = Number(i.paidAmount ?? i.amount) || 0;
    const left = Number(i.balance ?? Math.max(0, (Number(i.amount) || 0) - paid)) || 0;
    capital += paid;
    investUnpaid += left;
    if (i.startupCost) startupCosts += paid;
    const name = pname.get(String(i.partner)) || 'Partner (not set)';
    byPartner.set(name, (byPartner.get(name) || 0) + paid);
  }

  const cash = money.left; // null when no start balance was set
  const stock = (stockAgg[0] && stockAgg[0].value) || 0;
  const advancesTotal = (advances[0] && advances[0].total) || 0;
  // Owner 2026-11-20 rule: an asset bought with shop cash is taken off the profit ("Assets
  // purchased"), so that part is not counted again as asset value here.
  const paidFromCash = Math.min(Math.max(0, fixedCost - fixedDep), Number(profit.equipmentBought) || 0);
  const fixedNet = fixedCost - fixedDep - paidFromCash;
  // JazzCash wallet (owner 2026-11-17): shown on its own line, taken out of "money left"
  // (same start as the start balance, so the two lines still add up to money left).
  let jazz = 0;
  if (cash !== null) {
    try {
      const fromDay = new Date(new Date(money.baseline.at).getTime() + 5 * 3600000).toISOString().slice(0, 10);
      const j = await jazzcash({ from: fromDay < START ? START : fromDay });
      jazz = round2((j.totals && j.totals.net) || 0);
    } catch (err) {
      console.error('JazzCash balance failed:', err.message);
    }
  }

  const assetRows = [
    { key: 'cash', label: 'Cash + bank (UBL)', amount: round2((cash || 0) - jazz), missing: cash === null },
    { key: 'jazzcash', label: 'JazzCash wallet', amount: jazz, hint: 'Money received by JazzCash minus paid out from it' },
    { key: 'stock', label: 'Stock at cost', amount: round2(stock), hint: stockAgg[0] ? `${Math.round(stockAgg[0].units)} pieces · ${stockAgg[0].products} products` : '' },
    { key: 'advances', label: 'Salary advances (staff owe)', amount: round2(advancesTotal) },
    { key: 'vendorAdvances', label: 'Paid ahead to vendors', amount: round2(vendorAdvances) },
    {
      key: 'fixed',
      label: 'Fixed assets (book value)',
      amount: round2(fixedNet),
      hint: `Cost ${round2(fixedCost)} − depreciation ${round2(fixedDep)}${paidFromCash ? ` − bought from shop cash (already off profit) ${round2(paidFromCash)}` : ''}`,
    },
  ];
  const liabilityRows = [
    { key: 'payables', label: 'Owed to vendors', amount: round2(payables) },
    { key: 'loans', label: 'Loans to pay back', amount: round2(loansLeft) },
    { key: 'salaries', label: 'Salaries approved, not paid', amount: round2((payroll[0] && payroll[0].unpaid) || 0) },
    { key: 'investBills', label: 'Investment bills not paid yet', amount: round2(investUnpaid) },
    { key: 'tax', label: 'Sales tax collected', amount: round2((taxAgg[0] && taxAgg[0].tax) || 0) },
  ];
  const totalAssets = round2(assetRows.reduce((t, r) => t + r.amount, 0));
  const totalLiabilities = round2(liabilityRows.reduce((t, r) => t + r.amount, 0));
  const netWorth = round2(totalAssets - totalLiabilities);
  // Money partners took out (Profit Distribution expenses) lowers the owners' share.
  const drawAgg = await db
    .collection('expenses')
    .aggregate([{ $match: { ...NOT_DELETED, displayOnly: { $ne: true }, partner: { $type: 'objectId' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
    .toArray();
  const drawings = round2((drawAgg[0] && drawAgg[0].total) || 0);
  // Vendor payments before 5 Nov are NOT added here: they were paid from the "buying" money
  // already entered in Investments (owner 2026-11-20 — counting them again doubled it).
  const difference = round2(netWorth - capital - profit.netProfit + drawings + startupCosts);

  return {
    asOf: now,
    systemStart: START,
    assets: assetRows,
    totalAssets,
    liabilities: liabilityRows,
    totalLiabilities,
    equity: [
      { key: 'capital', label: 'Partner money put in', amount: round2(capital), partners: [...byPartner].map(([name, amount]) => ({ name, amount: round2(amount) })) },
      { key: 'profit', label: `Profit made (since ${START})`, amount: round2(profit.netProfit) },
      { key: 'drawings', label: 'Taken by partners (profit distribution)', amount: -drawings },
      { key: 'startup', label: 'Start-up costs (paid by partners, not assets)', amount: -round2(startupCosts) },
      { key: 'difference', label: 'Opening balances / not explained', amount: difference },
    ],
    totalEquity: netWorth,
    // Off the balance sheet: the vendor's own stock sitting on our shelves.
    consignmentStock: round2((consignAgg[0] && consignAgg[0].value) || 0),
    cashMissing: cash === null,
    gapReasons: await gapReasons(db).catch((e) => (console.error('[fin] gap reasons', e.message), null)),
  };
}

/**
 * Owner 2026-11-20: why the balance sheet does not add up, from the data (the shop started from 0).
 * Vendor bills vs what was unpacked from them (vendor price × qty of goods-receipt entries):
 *   overBills  unpacked goods differ from the bill amount (bill too low, e.g. a Rs 1,000
 *              placeholder, or unpacked prices wrong)
 *   inBoxes    bills with nothing unpacked yet: owed, not in stock yet
 */
async function gapReasons(db) {
  const pos = await db
    .collection('purchaseorders')
    .find({ status: { $ne: 'cancelled' } })
    .project({ goodsReceipt: 1, 'bills._id': 1, 'bills.billTotal': 1, 'bills.billAmount': 1, 'bills.subtotal': 1, 'bills.discount': 1 })
    .toArray();
  const grnIds = pos.map((p) => p.goodsReceipt).filter(Boolean);
  const grns = grnIds.length
    ? await db.collection('goodsreceipts').find({ _id: { $in: grnIds } }).project({ 'entries.bill': 1, 'entries.undone': 1, 'entries.value': 1, 'entries.qty': 1, 'entries.costPrice': 1 }).toArray()
    : [];
  const unpacked = new Map();
  for (const g of grns)
    for (const e of g.entries || []) {
      if (e.undone) continue;
      const k = String(e.bill);
      unpacked.set(k, (unpacked.get(k) || 0) + (Number(e.value) || (Number(e.qty) || 0) * (Number(e.costPrice) || 0)));
    }
  let overBills = 0;
  let overCount = 0;
  let placeholders = 0;
  let inBoxes = 0;
  let inBoxesCount = 0;
  for (const p of pos)
    for (const b of p.bills || []) {
      const total = Number(b.billTotal) > 0 ? Number(b.billTotal) : Number(b.billAmount) > 0 ? Number(b.billAmount) : Math.max(0, (Number(b.subtotal) || 0) - (Number(b.discount) || 0));
      const got = unpacked.get(String(b._id));
      if (got === undefined) {
        inBoxes += total;
        inBoxesCount += 1;
        continue;
      }
      const d = got - total;
      if (Math.abs(d) > Math.max(100, total * 0.02)) {
        overBills += d;
        overCount += 1;
        if (total <= 1000 && got > total) placeholders += 1;
      }
    }
  return { overBills: round2(overBills), overCount, placeholders, inBoxes: round2(-inBoxes), inBoxesCount };
}

// ---------------------------------------------------------------------------
// Cash flow (a period) — built on the Cash in Hand movements.
// ---------------------------------------------------------------------------
async function cashFlow(query = {}) {
  const r = range(query);
  const f = await funds();
  if (!f.baseline) return { range: { from: r.from, to: r.to }, baseline: null };
  const base = new Date(f.baseline.at);
  const moves = [...f.movements].reverse(); // oldest first
  let opening = f.baseline.amount;
  for (const m of moves) if (new Date(m.at) < r.start) opening += m.amount;
  const inside = moves.filter((m) => new Date(m.at) >= r.start && new Date(m.at) <= r.end);
  // Owner 2026-11-20: equipment bought from shop money (Shop Setup / Equipment) is Investing, not Operating.
  const isCapital = (m) => m.kind === 'expense' && CAPITAL_EXPENSE.test(m.category || '');
  const sum = (k) => round2(inside.filter((m) => m.kind === k && !isCapital(m)).reduce((t, m) => t + m.amount, 0));
  const capitalOut = round2(inside.filter(isCapital).reduce((t, m) => t + m.amount, 0));
  const investing = [{ key: 'assets_bought', label: 'Assets bought from shop money', amount: capitalOut }];

  const operating = [
    { key: 'sales', label: 'Money received from sales', amount: sum('sales') },
    { key: 'refund', label: 'Refunds paid to customers', amount: sum('refund') },
    { key: 'vendor_payment', label: 'Paid to vendors', amount: sum('vendor_payment') },
    { key: 'trip_cost', label: 'Trip costs (rent, builty, loading)', amount: sum('trip_cost') },
    { key: 'expense', label: 'Shop expenses + salaries', amount: sum('expense') },
  ];
  const financing = [
    { key: 'loan_in', label: 'Loans received', amount: sum('loan_in') },
    { key: 'loan_out', label: 'Loans paid back', amount: sum('loan_out') },
    { key: 'partner_draw', label: 'Taken by partners (profit distribution)', amount: sum('partner_draw') },
  ];

  // Assets bought in the period and partner-paid bills: they do not pass
  // through the till / bank, so they are shown for information only.
  const db = mongoose.connection.db;
  const [assetsBought, partnerPaid] = await Promise.all([
    db
      .collection('assets')
      .aggregate([
        { $match: { ...NOT_DELETED, purchaseDate: { $gte: r.start, $lte: r.end } } },
        { $group: { _id: null, total: { $sum: { $multiply: [{ $ifNull: ['$purchasePrice', 0] }, { $ifNull: ['$quantity', 1] }] } } } },
      ])
      .toArray(),
    db
      .collection('investments')
      .aggregate([
        { $match: { ...NOT_DELETED } },
        { $unwind: '$payments' },
        { $match: { 'payments.date': { $gte: r.start, $lte: r.end } } },
        { $group: { _id: null, total: { $sum: '$payments.amount' } } },
      ])
      .toArray(),
  ]);

  const opTotal = round2(operating.reduce((t, x) => t + x.amount, 0));
  const finTotal = round2(financing.reduce((t, x) => t + x.amount, 0));
  const invTotal = capitalOut;
  const net = round2(opTotal + invTotal + finTotal);
  return {
    range: { from: r.from, to: r.to },
    baseline: f.baseline,
    startsAtBaseline: r.start < base,
    opening: round2(opening),
    operating,
    operatingTotal: opTotal,
    investing,
    investingTotal: invTotal,
    financing,
    financingTotal: finTotal,
    netChange: net,
    closing: round2(opening + net),
    nonCash: {
      // Assets register for the period minus the ones already paid from shop money (Investing above).
      assetsBought: round2(Math.max(0, ((assetsBought[0] && assetsBought[0].total) || 0) + capitalOut)),
      partnerPaid: round2((partnerPaid[0] && partnerPaid[0].total) || 0),
    },
    // Closing money split (owner 2026-11-17): JazzCash wallet on the last day, rest = cash + bank.
    closingSplit: await (async () => {
      try {
        const baseDay = new Date(base.getTime() + 5 * 3600000).toISOString().slice(0, 10);
        const j = await jazzcash({ from: baseDay < START ? START : baseDay, to: r.to });
        const jz = round2((j.totals && j.totals.net) || 0);
        return { cashBank: round2(opening + net - jz), jazzcash: jz };
      } catch (err) {
        return null;
      }
    })(),
    // JazzCash part of the money above, for the same days (owner 2026-11-17).
    jazzcash: await jazzcash({ from: r.from, to: r.to })
      .then((j) => ({ in: round2(j.totals.in), out: round2(j.totals.out), net: round2(j.totals.net), bills: j.totals.bills }))
      .catch(() => null),
  };
}

// ---------------------------------------------------------------------------
// Partners (owner 2026-11-17): who owns what. Hamza 30% / Adil 70% (sharePercent).
//   capital   money each partner put in (investment bills they paid)
//   profit    net profit since the start × their share %
//   taken     "Profit Distribution" expenses for that partner
//   balance   capital + profit − taken = their part of the company today
// ---------------------------------------------------------------------------
async function partners() {
  const db = mongoose.connection.db;
  const [list, invest, draws, profit] = await Promise.all([
    db.collection('investmentpartners').find({ ...NOT_DELETED }).project({ name: 1, sharePercent: 1 }).sort({ name: 1 }).toArray(),
    db
      .collection('investments')
      .aggregate([
        { $match: { ...NOT_DELETED } },
        { $group: { _id: '$partner', paid: { $sum: { $ifNull: ['$paidAmount', '$amount'] } } } },
      ])
      .toArray(),
    db
      .collection('expenses')
      .aggregate([
        { $match: { ...NOT_DELETED, displayOnly: { $ne: true }, partner: { $type: 'objectId' } } },
        { $sort: { date: -1 } },
        {
          $group: {
            _id: '$partner',
            taken: { $sum: '$amount' },
            count: { $sum: 1 },
            rows: { $push: { _id: '$_id', title: '$title', amount: '$amount', date: '$date', paymentMethod: '$paymentMethod', counterName: '$counterName' } },
          },
        },
      ])
      .toArray(),
    incomeFor(pkStart(START), new Date()),
  ]);
  const investBy = new Map(invest.map((r) => [String(r._id), Number(r.paid) || 0]));
  const drawBy = new Map(draws.map((r) => [String(r._id), r]));
  const net = profit.netProfit;
  const totalShare = list.reduce((t, p) => t + (Number(p.sharePercent) || 0), 0);

  const rows = list.map((p) => {
    const id = String(p._id);
    const share = Number(p.sharePercent) || 0;
    const capital = round2(investBy.get(id) || 0);
    const profitShare = round2((net * share) / 100);
    const d = drawBy.get(id);
    const taken = round2((d && d.taken) || 0);
    return {
      _id: id,
      name: p.name,
      sharePercent: share,
      capital,
      profitShare,
      taken,
      balance: round2(capital + profitShare - taken),
      profitLeft: round2(profitShare - taken),
      draws: d ? d.rows.slice(0, 50).map((x) => ({ ...x, _id: String(x._id), amount: round2(x.amount) })) : [],
    };
  });
  const sum = (k) => round2(rows.reduce((t, r) => t + r[k], 0));
  // Where the owners' money is today (owner 2026-11-17): goods/stock vs money.
  let worth = null;
  try {
    const b = await balanceSheet();
    const a = (k) => (b.assets.find((x) => x.key === k) || {}).amount || 0;
    worth = {
      netWorth: b.totalEquity,
      totalAssets: b.totalAssets,
      totalLiabilities: b.totalLiabilities,
      stock: a('stock'),
      money: round2(a('cash') + a('jazzcash')),
      other: round2(a('advances') + a('vendorAdvances') + a('fixed')),
    };
  } catch (err) {
    console.error('Partners worth failed:', err.message);
  }
  return {
    worth,
    since: START,
    grossProfit: round2(profit.grossProfit),
    grossMargin: profit.grossMargin,
    // Gross profit − these = net profit (owner 2026-11-19: show expenses between them).
    totalExpenses: round2(profit.totalExpenses),
    otherCosts: round2(profit.otherCosts), // damage + stock count loss + depreciation
    netMargin: profit.netMargin,
    netProfit: round2(net),
    totalShare,
    rows,
    totals: { capital: sum('capital'), profitShare: sum('profitShare'), taken: sum('taken'), balance: sum('balance'), profitLeft: sum('profitLeft') },
  };
}

/** Change a partner's share % (all partners should add up to 100). */
async function setPartnerShare(id, body = {}) {
  if (!/^[a-f\d]{24}$/i.test(String(id || ''))) throw bad('Bad partner');
  const pct = Number(body.sharePercent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw bad('Share must be between 0 and 100');
  const r = await mongoose.connection.db
    .collection('investmentpartners')
    .updateOne({ _id: new mongoose.Types.ObjectId(String(id)), ...NOT_DELETED }, { $set: { sharePercent: Math.round(pct * 100) / 100, updatedAt: new Date() } });
  if (!r.matchedCount) throw Object.assign(new Error('Partner not found'), { status: 404 });
  return partners();
}

/** Goods (vendor price) sold per vendor + paid to each vendor, for a period (Reports page). */
async function vendorGoodsReport(query = {}) {
  const r = range(query);
  const orderMatch = { ...SALE_MATCH, createdAt: { $gte: r.start, $lte: r.end } };
  const shares = await tripShares().catch(() => new Map());
  const pieces = await receiptPieces();
  const [sold, ledger, stock] = await Promise.all([vendorGoods(orderMatch, r.start, r.end, shares), vendorLedgerTotals(r.start, r.end), stockByVendor(pieces)]);
  const received = receivedByVendor(pieces, r.start, r.end);

  // Owner 2026-11-20: per vendor — goods received (goods receipts) and billed (vendor bills)
  // in the period, sold, in store now, paid in the period, still owed now, and goods received
  // that have no vendor bill yet (since the start).
  const byId = new Map();
  const row = (id, name) => {
    const k = id ? String(id) : 'none';
    let x = byId.get(k);
    if (!x) {
      x = { vendorId: id ? String(id) : null, name: name || '', received: 0, receivedQty: 0, billed: 0, goodsCost: 0, qty: 0, inStore: 0, inStoreQty: 0, paid: 0, payments: 0, owed: 0, receivedAll: 0, billedAll: 0 };
      byId.set(k, x);
    }
    if (!x.name && name) x.name = name;
    return x;
  };
  for (const s of sold) Object.assign(row(s.vendorId, s.name), { goodsCost: s.goodsCost, qty: s.qty, paid: s.paid, payments: s.payments });
  for (const l of ledger) Object.assign(row(l.vendorId, l.name), { billed: l.billed, billedAll: l.billedAll, owed: l.owed });
  for (const x of received) Object.assign(row(x.vendorId, x.name), { received: x.received, receivedQty: x.receivedQty, receivedAll: x.receivedAll });
  for (const s of stock) Object.assign(row(s.vendorId, s.name), { inStore: s.value, inStoreQty: s.qty });

  const ids = [...byId.values()].map((x) => x.vendorId).filter(Boolean);
  const vendors = ids.length
    ? await mongoose.connection.db.collection('vendors').find({ _id: { $in: ids.map((x) => new mongoose.Types.ObjectId(x)) } }).project({ name: 1 }).toArray()
    : [];
  const vName = new Map(vendors.map((v) => [String(v._id), v.name]));
  const rows = [...byId.values()]
    .map((x) => ({
      ...x,
      name: (x.vendorId && vName.get(x.vendorId)) || x.name || (x.vendorId ? 'Deleted vendor' : 'No vendor (stock added without a goods receipt)'),
      received: round2(x.received),
      billed: round2(x.billed),
      inStore: round2(x.inStore),
      owed: round2(x.owed),
      // Received but not billed (since the start): + = vendor bill missing / lower than the goods.
      notBilled: round2(x.receivedAll - x.billedAll),
      receivedAll: undefined,
      billedAll: undefined,
    }))
    .filter((x) => x.received || x.billed || x.goodsCost || x.inStore || x.paid || Math.abs(x.owed) >= 0.01 || Math.abs(x.notBilled) >= 0.01)
    .sort((a, b) => b.received - a.received || b.inStore - a.inStore || b.goodsCost - a.goodsCost);
  const sum = (k) => round2(rows.reduce((t, x) => t + (x[k] || 0), 0));
  return {
    range: { from: r.from, to: r.to, systemStart: START },
    summary: {
      vendors: rows.filter((x) => x.vendorId).length,
      received: sum('received'),
      receivedQty: rows.reduce((t, x) => t + x.receivedQty, 0),
      billed: sum('billed'),
      notBilled: sum('notBilled'),
      goodsCost: sum('goodsCost'),
      qty: rows.reduce((t, x) => t + x.qty, 0),
      inStore: sum('inStore'),
      inStoreQty: rows.reduce((t, x) => t + x.inStoreQty, 0),
      inStoreNoVendor: round2((rows.find((x) => !x.vendorId) || {}).inStore || 0),
      paid: sum('paid'),
      payments: rows.reduce((t, x) => t + x.payments, 0),
      owed: round2(rows.reduce((t, x) => t + Math.max(0, x.owed), 0)), // same as "Owed to vendors" on the balance sheet
      advance: round2(rows.reduce((t, x) => t + Math.max(0, -x.owed), 0)),
    },
    rows,
  };
}

/**
 * Vendor ledger per vendor: billed in the period and since the start (bills + credit notes −
 * returns / debit notes) and the balance owed today (all non-voided entries, like the balance sheet).
 */
async function vendorLedgerTotals(start, end) {
  const inRange = { $and: [{ $gte: ['$date', start] }, { $lte: ['$date', end] }] };
  const rows = await mongoose.connection.db
    .collection('vendorledgerentries')
    .aggregate([
      { $match: { isVoided: { $ne: true } } },
      {
        $group: {
          _id: '$vendor',
          name: { $last: '$vendorName' },
          billed: {
            $sum: {
              $cond: [
                inRange,
                {
                  $switch: {
                    branches: [
                      { case: { $in: ['$type', ['bill', 'credit_note']] }, then: { $ifNull: ['$credit', 0] } },
                      { case: { $eq: ['$type', 'debit_note'] }, then: { $multiply: [-1, { $ifNull: ['$debit', 0] }] } },
                    ],
                    default: 0,
                  },
                },
                0,
              ],
            },
          },
          billedAll: {
            $sum: {
              $switch: {
                branches: [
                  { case: { $in: ['$type', ['bill', 'credit_note']] }, then: { $ifNull: ['$credit', 0] } },
                  { case: { $eq: ['$type', 'debit_note'] }, then: { $multiply: [-1, { $ifNull: ['$debit', 0] }] } },
                ],
                default: 0,
              },
            },
          },
          owed: { $sum: { $subtract: [{ $ifNull: ['$credit', 0] }, { $ifNull: ['$debit', 0] }] } },
        },
      },
    ])
    .toArray();
  return rows.map((x) => ({ vendorId: x._id ? String(x._id) : null, name: x.name || '', billed: x.billed || 0, billedAll: x.billedAll || 0, owed: x.owed || 0 }));
}

/**
 * Every posted goods receipt piece, per product and vendor (old line flow: acceptedQty;
 * new entry flow: stockQty), valued at the vendor price typed when receiving.
 */
async function receiptPieces() {
  const rows = await mongoose.connection.db
    .collection('goodsreceipts')
    .aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      {
        $project: {
          vendor: 1,
          vendorName: 1,
          updatedAt: 1,
          items: {
            $concatArrays: [
              {
                $map: {
                  input: { $filter: { input: { $ifNull: ['$lines', []] }, as: 'l', cond: { $eq: ['$$l.posted', true] } } },
                  as: 'l',
                  in: { product: '$$l.product', vendor: '$$l.vendor', vendorName: '$$l.vendorName', qty: { $ifNull: ['$$l.acceptedQty', 0] }, price: { $ifNull: ['$$l.unitPrice', 0] }, at: '$$l.postedAt' },
                },
              },
              {
                $map: {
                  // Undone entries (wrong qty typed, then undone) never count.
                  input: { $filter: { input: { $ifNull: ['$entries', []] }, as: 'e', cond: { $and: [{ $eq: ['$$e.posted', true] }, { $ne: ['$$e.undone', true] }] } } },
                  as: 'e',
                  in: { product: '$$e.product', vendor: '$$e.vendor', vendorName: '$$e.vendorName', qty: { $ifNull: ['$$e.stockQty', 0] }, price: { $ifNull: ['$$e.costPrice', 0] }, at: '$$e.postedAt' },
                },
              },
            ],
          },
        },
      },
      { $unwind: '$items' },
      {
        $project: {
          _id: 0,
          product: '$items.product',
          vendor: { $ifNull: ['$items.vendor', '$vendor'] },
          vendorName: { $ifNull: ['$items.vendorName', '$vendorName'] },
          qty: '$items.qty',
          price: '$items.price',
          at: { $ifNull: ['$items.at', '$updatedAt'] },
        },
      },
    ])
    .toArray();
  // Some old rows keep qty / price as text: make them numbers (else "12" + "5" = "125").
  return rows.map((x) => ({ ...x, qty: Number(x.qty) || 0, price: Number(x.price) || 0 })).filter((x) => x.qty > 0);
}

/** Goods received (vendor price) per vendor: in the period and since the start. */
function receivedByVendor(pieces, start, end) {
  const acc = new Map();
  for (const x of pieces) {
    const k = x.vendor ? String(x.vendor) : 'none';
    const a = acc.get(k) || { vendorId: x.vendor ? String(x.vendor) : null, name: x.vendorName || '', received: 0, receivedQty: 0, receivedAll: 0 };
    if (!a.name && x.vendorName) a.name = x.vendorName;
    const value = x.qty * (Number(x.price) || 0);
    a.receivedAll += value;
    const at = new Date(x.at || 0);
    if (at >= start && at <= end) {
      a.received += value;
      a.receivedQty += x.qty;
    }
    acc.set(k, a);
  }
  return [...acc.values()];
}

/**
 * Stock in the shop now, per vendor, valued like the balance sheet (pieces × product cost).
 * Stock is one number per product, so its pieces go to the NEWEST goods receipts first
 * (older pieces sell first). Pieces no receipt explains = stock added by hand (no vendor).
 */
async function stockByVendor(pieces) {
  const products = await mongoose.connection.db
    .collection('products')
    .find({ ...NOT_DELETED, isConsignment: { $ne: true }, stock: { $gt: 0 } })
    .project({ stock: 1, costPrice: 1 })
    .toArray();
  const byProduct = new Map();
  for (const x of pieces) {
    const k = String(x.product);
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(x);
  }
  const acc = new Map();
  const add = (vendor, name, qty, cost) => {
    if (!(qty > 0)) return;
    const k = vendor ? String(vendor) : 'none';
    const a = acc.get(k) || { vendorId: vendor ? String(vendor) : null, name: name || '', qty: 0, value: 0 };
    if (!a.name && name) a.name = name;
    a.qty += qty;
    a.value += qty * cost;
    acc.set(k, a);
  };
  for (const p of products) {
    const cost = Number(p.costPrice) || 0;
    let left = Number(p.stock) || 0;
    const recs = (byProduct.get(String(p._id)) || []).slice().sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    for (const r of recs) {
      if (left <= 0) break;
      const take = Math.min(left, r.qty);
      add(r.vendor, r.vendorName, take, cost);
      left -= take;
    }
    add(null, '', left, cost); // no goods receipt for these pieces
  }
  return [...acc.values()];
}

module.exports = { incomeStatement, balanceSheet, cashFlow, partners, setPartnerShare, vendorGoodsReport, START };
