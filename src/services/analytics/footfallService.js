// src/services/analytics/footfallService.js
// Footfall: buyers, bills and average bill value per day (Pakistan time), by
// hour × weekday and cashier; optional visitor counts per day turn
// bills into a conversion %.
//
// Unique customers: same phone (digits only, +92 -> 0) or same customer
// account = one buyer; a bill with neither (walk-in) counts as one buyer.
const POSOrder = require('../../models/posOrder');
const FootfallEntry = require('../../models/footfallEntry');
const User = require('../../models/user');
const T = require('./time');
const C = require('./common');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Phone digits with spaces / dashes / brackets removed and +92 / 92 turned into 0.
const phoneExpr = (() => {
  let s = { $trim: { input: { $ifNull: ['$customerInfo.phone', ''] } } };
  for (const ch of [' ', '-', '(', ')', '.']) s = { $replaceAll: { input: s, find: ch, replacement: '' } };
  const plus = { $cond: [{ $eq: [{ $substrCP: [s, 0, 3] }, '+92'] }, { $concat: ['0', { $substrCP: [s, 3, 20] }] }, s] };
  return {
    $cond: [
      { $and: [{ $eq: [{ $substrCP: [plus, 0, 2] }, '92'] }, { $gte: [{ $strLenCP: plus }, 12] }] },
      { $concat: ['0', { $substrCP: [plus, 2, 20] }] },
      plus,
    ],
  };
})();

const buyerExpr = {
  $let: {
    vars: { ph: phoneExpr },
    in: {
      $cond: [
        { $gte: [{ $strLenCP: '$$ph' }, 7] },
        { $concat: ['p:', '$$ph'] },
        {
          $cond: [
            { $ne: [{ $ifNull: ['$customer', null] }, null] },
            { $concat: ['c:', { $toString: '$customer' }] },
            { $concat: ['b:', { $toString: '$_id' }] },
          ],
        },
      ],
    },
  },
};

// Pieces of product lines on a bill.
const piecesExpr = {
  $sum: {
    $map: {
      input: {
        $filter: {
          input: { $ifNull: ['$items', []] },
          as: 'i',
          cond: { $gt: ['$$i.product', null] }, // product lines only
        },
      },
      as: 'i',
      in: { $ifNull: ['$$i.quantity', 0] },
    },
  },
};

async function footfallReport(req, query = {}) {
  const scope = await C.reportScope(req);
  const range = T.parseRange(query, { defaultFrom: 30, maxDays: 370 });
  const match = { ...C.SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: range.start, $lt: range.end } };

  const entryMatch = { day: { $gte: range.from, $lte: range.to } };
  if (scope.branchId) entryMatch.branch = C.toId(scope.branchId);

  const [[facet], entries] = await Promise.all([
    POSOrder.aggregate([
      { $match: match },
      {
        $project: {
          total: { $ifNull: ['$total', 0] },
          cashier: 1,
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: T.TZ } },
          hour: { $hour: { date: '$createdAt', timezone: T.TZ } },
          dow: { $dayOfWeek: { date: '$createdAt', timezone: T.TZ } }, // 1 = Sunday
          buyer: buyerExpr,
          pieces: piecesExpr,
        },
      },
      {
        $facet: {
          totals: [{ $group: { _id: null, bills: { $sum: 1 }, sales: { $sum: '$total' }, pieces: { $sum: '$pieces' } } }],
          buyers: [{ $group: { _id: '$buyer' } }, { $count: 'n' }],
          walkIns: [{ $match: { buyer: { $regex: '^b:' } } }, { $count: 'n' }],
          days: [{ $group: { _id: '$day', bills: { $sum: 1 }, sales: { $sum: '$total' }, pieces: { $sum: '$pieces' }, buyers: { $addToSet: '$buyer' } } }, { $project: { bills: 1, sales: 1, pieces: 1, buyers: { $size: '$buyers' } } }],
          heat: [{ $group: { _id: { d: '$dow', h: '$hour' }, bills: { $sum: 1 }, sales: { $sum: '$total' } } }],
          cashiers: [{ $group: { _id: '$cashier', bills: { $sum: 1 }, sales: { $sum: '$total' }, pieces: { $sum: '$pieces' } } }, { $sort: { bills: -1 } }],
        },
      },
    ]).allowDiskUse(true),
    FootfallEntry.find(entryMatch).sort({ day: 1 }).lean(),
  ]);

  // Visitors per day.
  const visitorsByDay = new Map();
  for (const e of entries) visitorsByDay.set(e.day, (visitorsByDay.get(e.day) || 0) + (e.visitors || 0));

  const dayMap = new Map(facet.days.map((d) => [d._id, d]));
  const days = T.listDays(range.from, range.to).map((day) => {
    const d = dayMap.get(day) || { bills: 0, sales: 0, pieces: 0, buyers: 0 };
    const visitors = visitorsByDay.has(day) ? visitorsByDay.get(day) : null;
    return {
      day,
      weekday: WEEKDAYS[new Date(T.dayStart(day).getTime() + T.OFFSET_MS).getUTCDay()],
      bills: d.bills,
      buyers: d.buyers,
      sales: C.round2(d.sales),
      avgBill: d.bills ? C.round2(d.sales / d.bills) : 0,
      itemsPerBill: d.bills ? C.round2(d.pieces / d.bills) : 0,
      visitors,
      conversionPct: visitors ? C.pct(d.bills, visitors) : null,
    };
  });

  // Hour × weekday heatmap (weekday 0 = Sunday ... 6 = Saturday).
  const heatmap = Array.from({ length: 7 }, (_, d) => ({ weekday: d, label: WEEKDAYS[d], hours: Array.from({ length: 24 }, () => ({ bills: 0, sales: 0 })) }));
  for (const h of facet.heat) heatmap[h._id.d - 1].hours[h._id.h] = { bills: h.bills, sales: C.round2(h.sales) };
  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const bills = heatmap.reduce((s, d) => s + d.hours[hour].bills, 0);
    const sales = heatmap.reduce((s, d) => s + d.hours[hour].sales, 0);
    return { hour, bills, sales: C.round2(sales), avgBill: bills ? C.round2(sales / bills) : 0 };
  });
  // Weekday averages use how many of that weekday the range has.
  const weekdayCount = Array(7).fill(0);
  for (const d of days) weekdayCount[WEEKDAYS.indexOf(d.weekday)] += 1;
  const byWeekday = heatmap.map((d) => {
    const bills = d.hours.reduce((s, h) => s + h.bills, 0);
    const sales = d.hours.reduce((s, h) => s + h.sales, 0);
    const n = weekdayCount[d.weekday] || 1;
    return { weekday: d.weekday, label: d.label, bills, sales: C.round2(sales), avgBills: C.round1(bills / n), avgSales: C.round2(sales / n), avgBill: bills ? C.round2(sales / bills) : 0 };
  });

  const users = await User.find({ _id: { $in: facet.cashiers.map((c) => c._id).filter(Boolean) } })
    .select('firstName lastName email')
    .lean();
  const userName = new Map(users.map((u) => [String(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'User']));
  const byCashier = facet.cashiers.map((c) => ({
    cashierId: c._id ? String(c._id) : null,
    name: (c._id && userName.get(String(c._id))) || 'Unknown',
    bills: c.bills,
    sales: C.round2(c.sales),
    avgBill: c.bills ? C.round2(c.sales / c.bills) : 0,
    itemsPerBill: c.bills ? C.round2(c.pieces / c.bills) : 0,
  }));
  const t = facet.totals[0] || { bills: 0, sales: 0, pieces: 0 };
  const daysWithVisitors = days.filter((d) => d.visitors);
  const visitors = daysWithVisitors.reduce((s, d) => s + d.visitors, 0);
  const billsOnCountedDays = daysWithVisitors.reduce((s, d) => s + d.bills, 0);
  const peakHour = byHour.reduce((b, h) => (h.bills > (b ? b.bills : 0) ? h : b), null);
  const peakDay = byWeekday.reduce((b, d) => (d.avgBills > (b ? b.avgBills : 0) ? d : b), null);
  const busiest = days.reduce((b, d) => (d.bills > (b ? b.bills : 0) ? d : b), null);

  return {
    range: { from: range.from, to: range.to, days: range.days },
    summary: {
      bills: t.bills,
      buyers: facet.buyers[0] ? facet.buyers[0].n : 0,
      walkInBills: facet.walkIns[0] ? facet.walkIns[0].n : 0,
      sales: C.round2(t.sales),
      avgBill: t.bills ? C.round2(t.sales / t.bills) : 0,
      itemsPerBill: t.bills ? C.round2(t.pieces / t.bills) : 0,
      avgBillsPerDay: C.round1(t.bills / range.days),
      visitors: daysWithVisitors.length ? visitors : null,
      conversionPct: visitors ? C.pct(billsOnCountedDays, visitors) : null,
      daysWithVisitors: daysWithVisitors.length,
      peakHour: peakHour ? peakHour.hour : null,
      peakWeekday: peakDay ? peakDay.label : null,
      busiestDay: busiest ? busiest.day : null,
    },
    days,
    heatmap,
    byHour,
    byWeekday,
    byCashier,
  };
}

// ---------------- visitor counts (FootfallEntry) ----------------

async function listEntries(req, query = {}) {
  const scope = await C.reportScope(req);
  const range = T.parseRange(query, { defaultFrom: 30, maxDays: 370 });
  const match = { day: { $gte: range.from, $lte: range.to } };
  if (scope.branchId) match.branch = C.toId(scope.branchId);
  return FootfallEntry.find(match).sort({ day: -1 }).limit(2000).lean();
}

function entryFields(body = {}) {
  const day = String(body.day || body.date || '').slice(0, 10);
  if (!T.isDayKey(day)) throw C.httpError('Pick the day (YYYY-MM-DD)');
  if (day > T.dayKey()) throw C.httpError('The day cannot be in the future');
  const visitors = C.numParam(body.visitors, null, { min: 0, max: 1000000 });
  if (visitors === null) throw C.httpError('Enter the number of visitors');
  return { day, date: T.dayStart(day), visitors: Math.round(visitors), note: String(body.note || '').trim().slice(0, 300) };
}

/** Sets the visitor count of a branch/day (creates or replaces). */
async function saveEntry(branchId, body, userId) {
  const fields = entryFields(body);
  const branch = C.toId(branchId);
  const existing = await FootfallEntry.findOne({ branch, day: fields.day }).lean();
  const doc = await FootfallEntry.findOneAndUpdate(
    { branch, day: fields.day },
    { $set: { ...fields, updatedBy: C.toId(userId) }, $setOnInsert: { createdBy: C.toId(userId) } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).lean();
  return { entry: doc, created: !existing };
}

async function findEntry(req, id) {
  const entry = C.isId(id) ? await FootfallEntry.findById(id).lean() : null;
  if (!entry) throw C.httpError('Visitor entry not found', 404);
  if (!req.access.isSuperAdmin && String(entry.branch) !== String(req.access.branchId)) throw C.httpError('Visitor entry not found', 404);
  return entry;
}

async function updateEntry(req, id, body, userId) {
  const entry = await findEntry(req, id);
  const fields = entryFields({ day: entry.day, ...body });
  if (fields.day !== entry.day) {
    const clash = await FootfallEntry.findOne({ branch: entry.branch, day: fields.day, _id: { $ne: entry._id } }).lean();
    if (clash) throw C.httpError('That day already has a visitor count', 409, 'DUPLICATE');
  }
  return FootfallEntry.findByIdAndUpdate(entry._id, { $set: { ...fields, updatedBy: C.toId(userId) } }, { new: true, runValidators: true }).lean();
}

async function deleteEntry(req, id) {
  const entry = await findEntry(req, id);
  await FootfallEntry.deleteOne({ _id: entry._id });
  return { _id: entry._id };
}

module.exports = { footfallReport, listEntries, saveEntry, updateEntry, deleteEntry, WEEKDAYS };
