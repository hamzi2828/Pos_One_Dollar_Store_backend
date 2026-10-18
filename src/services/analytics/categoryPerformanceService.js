// src/services/analytics/categoryPerformanceService.js
// Category performance + employee progress.
//
// Per category: net sales, pieces, profit and progress against the monthly
// target of the staff assigned to it. Per employee: credited sales = the
// category's net sales × their share (equal split when no shares are set),
// summed over their categories, against their share of the targets.
//
// Which assignment covers a sale: the one for the sale's branch, else the
// all-branch one. Targets are monthly; a period covers
// Σ(days of the period in each month / days in that month) months.
const Employee = require('../../models/employee');
const CategoryAssignment = require('../../models/categoryAssignment');
const T = require('./time');
const C = require('./common');
const { salesLines, addTo, zero, branchExpr } = require('./sales');
const { effectiveShares, employeeName, keyOf } = require('./categoryAssignmentService');

/** How many "months" the inclusive day range covers (for pro-rating monthly targets). */
function monthsCovered(from, to) {
  let total = 0;
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = T.addMonths(m, 1)) {
    const first = `${m}-01`;
    const last = `${m}-${String(T.daysInMonth(m)).padStart(2, '0')}`;
    const a = from > first ? from : first;
    const b = to < last ? to : last;
    total += (T.daysBetween(a, b) + 1) / T.daysInMonth(m);
  }
  return total;
}

async function categoryPerformance(req, query = {}) {
  const scope = await C.reportScope(req);
  const range = T.parseRange(query, { defaultFrom: 'month', maxDays: 731 });
  const factor = monthsCovered(range.from, range.to);
  const orderMatch = { ...C.SALE_MATCH, ...scope.salesMatch, createdAt: { $gte: range.start, $lt: range.end } };

  const assignmentFilter = { isActive: true };
  if (scope.branchId) assignmentFilter.branch = { $in: [C.toId(scope.branchId), null] };

  const [lines, assignments] = await Promise.all([
    salesLines({ orderMatch, groupBy: { b: branchExpr(scope.mainBranchOid) } }),
    CategoryAssignment.find(assignmentFilter).select('-history').lean(),
  ]);
  // Sales per branch + category.
  const bucketMap = new Map();
  for (const l of lines) {
    const k = `${l.key.b || ''}|${l.category}`;
    if (!bucketMap.has(k)) bucketMap.set(k, { _id: { b: l.key.b || null, c: l.category }, ...zero() });
    addTo(bucketMap.get(k), l);
  }
  const buckets = [...bucketMap.values()];

  // Assignments by category key + branch ('' = all branches).
  const byKey = new Map();
  for (const a of assignments) byKey.set(`${a.categoryKey}|${a.branch ? String(a.branch) : ''}`, a);
  const coverFor = (catKey, branchId) => byKey.get(`${catKey}|${branchId}`) || byKey.get(`${catKey}|`) || null;

  // Assignments whose target counts in this view: all of them for "all branches";
  // for one branch only the one that covers it (its own, else the all-branch one).
  const applicable = scope.branchId
    ? [...new Set([...new Set(assignments.map((a) => a.categoryKey))].map((k) => coverFor(k, String(scope.branchId))).filter(Boolean))]
    : assignments;

  const cats = new Map(); // categoryKey -> row
  const catRow = (key, name) => {
    if (!cats.has(key)) cats.set(key, { category: name, qty: 0, giftQty: 0, revenue: 0, cost: 0, target: 0, assignments: [], employees: new Map() });
    return cats.get(key);
  };
  const emps = new Map(); // employeeId -> leaderboard row
  const empRow = (id) => {
    if (!emps.has(id)) emps.set(id, { employeeId: id, credited: 0, profit: 0, qty: 0, target: 0, categories: new Map() });
    return emps.get(id);
  };
  const credit = (row, cat, empId, share, amounts) => {
    const e = empRow(empId);
    e.credited += amounts.revenue * share;
    e.profit += (amounts.revenue - amounts.cost) * share;
    e.qty += amounts.qty * share;
    const ec = e.categories.get(cat.key) || { category: cat.name, credited: 0, target: 0, sharePct: C.round2(share * 100) };
    ec.credited += amounts.revenue * share;
    e.categories.set(cat.key, ec);
    const ce = row.employees.get(empId) || { employeeId: empId, credited: 0, target: 0, sharePct: C.round2(share * 100) };
    ce.credited += amounts.revenue * share;
    row.employees.set(empId, ce);
  };

  // Targets first (so categories with staff but no sales still show).
  for (const a of applicable) {
    const row = catRow(a.categoryKey, a.category);
    const target = (Number(a.monthlyTarget) || 0) * factor;
    row.target += target;
    row.assignments.push({ _id: String(a._id), branch: a.branch ? String(a.branch) : null, monthlyTarget: a.monthlyTarget || 0 });
    const shares = effectiveShares(a.employees || []);
    (a.employees || []).forEach((e, i) => {
      const id = String(e.employee);
      const er = empRow(id);
      er.target += target * shares[i];
      const ec = er.categories.get(a.categoryKey) || { category: a.category, credited: 0, target: 0, sharePct: C.round2(shares[i] * 100) };
      ec.target += target * shares[i];
      er.categories.set(a.categoryKey, ec);
      const ce = row.employees.get(id) || { employeeId: id, credited: 0, target: 0, sharePct: C.round2(shares[i] * 100) };
      ce.target += target * shares[i];
      row.employees.set(id, ce);
    });
  }

  // Sales, credited to the covering assignment's staff.
  let unassigned = 0;
  for (const b of buckets) {
    const name = b._id.c || 'Uncategorized';
    const key = keyOf(name);
    const row = catRow(key, cats.has(key) ? cats.get(key).category : name);
    row.qty += b.qty;
    row.giftQty += b.giftQty;
    row.revenue += b.revenue;
    row.cost += b.cost;
    const a = coverFor(key, b._id.b ? String(b._id.b) : '');
    if (!a || !(a.employees || []).length) {
      unassigned += b.revenue;
      continue;
    }
    const shares = effectiveShares(a.employees);
    a.employees.forEach((e, i) => credit(row, { key, name: row.category }, String(e.employee), shares[i], b));
  }

  const people = await Employee.find({ _id: { $in: [...emps.keys()].map(C.toId) } }).select('firstName lastName position isActive isDeleted').lean();
  const personById = new Map(people.map((p) => [String(p._id), p]));
  const nameOf = (id) => employeeName(personById.get(id));

  const totalRevenue = [...cats.values()].reduce((s, r) => s + r.revenue, 0);
  const categories = [...cats.values()]
    .map((r) => ({
      category: r.category,
      assigned: r.assignments.length > 0,
      qty: r.qty,
      giftQty: r.giftQty,
      revenue: C.round2(r.revenue),
      cost: C.round2(r.cost),
      profit: C.round2(r.revenue - r.cost),
      marginPct: C.pct(r.revenue - r.cost, r.revenue),
      salesSharePct: C.pct(r.revenue, totalRevenue),
      target: C.round2(r.target),
      targetPct: r.target > 0 ? C.pct(r.revenue, r.target) : null,
      assignments: r.assignments,
      employees: [...r.employees.values()]
        .map((e) => ({ ...e, name: nameOf(e.employeeId), credited: C.round2(e.credited), target: C.round2(e.target), progressPct: e.target > 0 ? C.pct(e.credited, e.target) : null }))
        .sort((x, y) => y.credited - x.credited),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.target - a.target || a.category.localeCompare(b.category));

  const employees = [...emps.values()]
    .map((e) => {
      const p = personById.get(e.employeeId);
      return {
        employeeId: e.employeeId,
        name: nameOf(e.employeeId),
        position: p ? p.position || '' : '',
        isActive: !!p && p.isActive !== false && p.isDeleted !== true,
        credited: C.round2(e.credited),
        profit: C.round2(e.profit),
        qty: C.round2(e.qty),
        target: C.round2(e.target),
        progressPct: e.target > 0 ? C.pct(e.credited, e.target) : null,
        categories: [...e.categories.values()]
          .map((c) => ({ ...c, credited: C.round2(c.credited), target: C.round2(c.target) }))
          .sort((x, y) => y.credited - x.credited),
      };
    })
    .sort((a, b) => b.credited - a.credited || (b.progressPct ?? -1) - (a.progressPct ?? -1));
  employees.forEach((e, i) => (e.rank = i + 1));

  const totalCost = categories.reduce((s, r) => s + r.cost, 0);
  const totalTarget = categories.reduce((s, r) => s + r.target, 0);
  const assignedRevenue = totalRevenue - unassigned;
  return {
    range: { from: range.from, to: range.to, days: range.days, months: Math.round(factor * 1000) / 1000 },
    summary: {
      revenue: C.round2(totalRevenue),
      profit: C.round2(totalRevenue - totalCost),
      marginPct: C.pct(totalRevenue - totalCost, totalRevenue),
      qty: categories.reduce((s, r) => s + r.qty, 0),
      categories: categories.length,
      assignedCategories: categories.filter((c) => c.assigned).length,
      assignedRevenue: C.round2(assignedRevenue),
      assignedPct: C.pct(assignedRevenue, totalRevenue),
      unassignedRevenue: C.round2(unassigned),
      target: C.round2(totalTarget),
      targetPct: totalTarget > 0 ? C.pct(assignedRevenue, totalTarget) : null,
      employees: employees.length,
      topEmployee: employees[0] && employees[0].credited > 0 ? { name: employees[0].name, credited: employees[0].credited } : null,
    },
    categories,
    employees,
    branchId: scope.branchId,
  };
}

module.exports = { categoryPerformance, monthsCovered };
