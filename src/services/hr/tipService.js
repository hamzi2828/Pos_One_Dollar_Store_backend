// src/services/hr/tipService.js
// Staff tips: gift money to employees. A tip is an EXPENSE (category "Staff Tips"),
// never a salary item — payroll does not read tips and pay is not changed.
//
//   createTips(body)   one or many employees at once; each tip posts its own Expense
//   listTips(query)    ?from=&to=&employee=&search= with day / employee totals
//   deleteTip(id)      soft-deletes the tip and its Expense
//
// Expense.date is stored as UTC midnight of the PKT day ('YYYY-MM-DDT00:00:00.000Z'),
// like expenses typed by hand, so the till closing of that day subtracts it.
// OWNER: Payroll module.
const mongoose = require('mongoose');
const T = require('../analytics/time');
const StaffTip = require('../../models/staffTip');
const Expense = require('../../models/expense');
const ExpenseCategory = require('../../models/expenseCategory');
const { httpError, isId, paging, pageMeta, containsRe, str } = require('./util');
const { nextNumber } = require('../sequenceService');
const { helpers } = require('./payrollService');

const { rupees, shopDate, method, loadEmployee, nameOf, dayRange, sumByDay, ACTIVE, METHOD_LABEL, EXPENSE_METHOD } = helpers;
const { ObjectId } = mongoose.Types;

const EXPENSE_CATEGORY = 'Staff Tips';
const MAX_AT_ONCE = 50;

async function ensureTipsCategory() {
  try {
    await ExpenseCategory.updateOne(
      { name: EXPENSE_CATEGORY },
      { $setOnInsert: { name: EXPENSE_CATEGORY, description: 'Tips given to staff from the HR page (posted automatically).', isActive: true } },
      { upsert: true }
    );
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
}

const tipView = (t) => ({ ...t, methodLabel: METHOD_LABEL[t.method] || t.method });

/**
 * body: { date, method, note, tips: [{ employeeId, amount, note? }] }
 *    or { employeeId, amount, date, method, note } for one employee.
 * Everything is checked before anything is saved.
 */
async function createTips(body = {}, { userId, branchId = null, now = new Date() } = {}) {
  const items = Array.isArray(body.tips) && body.tips.length ? body.tips : [{ employeeId: body.employeeId || body.employee, amount: body.amount }];
  if (items.length > MAX_AT_ONCE) throw httpError(400, `At most ${MAX_AT_ONCE} employees at once`);
  const date = shopDate(body.date, 'Date', now);
  const day = T.dayKey(date);
  const payMethod = method(body.method);
  const sharedNote = str(body.note, 500) || '';

  const seen = new Set();
  const checked = [];
  for (const it of items) {
    const e = await loadEmployee(it && (it.employeeId || it.employee));
    if (!ACTIVE.includes(e.status)) throw httpError(400, `${nameOf(e)} is not working here now`);
    if (seen.has(String(e._id))) throw httpError(400, `${nameOf(e)} is picked two times`);
    seen.add(String(e._id));
    checked.push({ e, amount: rupees(it.amount, `Tip for ${nameOf(e)}`, { min: 1 }), note: str(it.note, 500) || sharedNote });
  }

  await ensureTipsCategory();
  const out = [];
  for (const { e, amount, note } of checked) {
    const expenseId = new ObjectId();
    const tip = await StaffTip.create({
      tipNo: await nextNumber('TIP'),
      employee: e._id,
      employeeName: nameOf(e),
      employeeCode: e.employeeCode || '',
      amount,
      date,
      day,
      method: payMethod,
      note,
      expense: expenseId,
      branch: branchId || null,
      createdBy: userId || null,
    });
    try {
      await Expense.create({
        _id: expenseId,
        title: `Tip – ${tip.employeeName}`,
        amount,
        category: EXPENSE_CATEGORY,
        categories: [EXPENSE_CATEGORY],
        date: new Date(`${day}T00:00:00.000Z`),
        paymentMethod: EXPENSE_METHOD[payMethod] || 'Other',
        reference: tip.tipNo,
        notes: `Tip to ${tip.employeeName}${tip.employeeCode ? ` (${tip.employeeCode})` : ''} by ${METHOD_LABEL[payMethod]}${note ? ` — ${note}` : ''}`.slice(0, 1000),
        branch: branchId || null,
        source: 'other',
        sourceType: 'Tip',
        sourceRef: tip._id,
      });
    } catch (err) {
      await StaffTip.deleteOne({ _id: tip._id });
      throw err;
    }
    out.push(tipView(tip.toObject()));
  }
  return out;
}

async function listTips(query = {}) {
  const { page, limit, skip } = paging(query);
  const filter = { isDeleted: { $ne: true } };
  const range = dayRange(query);
  if (range) filter.date = range;
  if (query.employee || query.employeeId) {
    const id = query.employee || query.employeeId;
    if (!isId(id)) throw httpError(400, 'Invalid employee');
    filter.employee = new ObjectId(String(id));
  }
  if (query.search && String(query.search).trim()) {
    const re = containsRe(query.search);
    filter.$or = [{ employeeName: re }, { employeeCode: re }, { tipNo: re }, { note: re }];
  }
  const [total, rows, byDay, byEmp] = await Promise.all([
    StaffTip.countDocuments(filter),
    StaffTip.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    sumByDay(StaffTip, filter),
    StaffTip.aggregate([
      { $match: filter },
      { $group: { _id: '$employee', name: { $last: '$employeeName' }, code: { $last: '$employeeCode' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
      { $limit: 100 },
    ]),
  ]);
  const amount = byDay.reduce((s, d) => s + d.amount, 0);
  return {
    data: rows.map(tipView),
    meta: {
      ...pageMeta({ page, limit }, total),
      summary: { count: total, amount, employees: byEmp.length },
      byDay,
      byEmployee: byEmp.map((b) => ({ employee: b._id, name: b.name, code: b.code || '', count: b.count, amount: Math.round(b.amount) })),
      category: EXPENSE_CATEGORY,
    },
  };
}

async function deleteTip(id, { reason } = {}, { userId, now = new Date() } = {}) {
  if (!isId(id)) throw httpError(404, 'Tip not found');
  const tip = await StaffTip.findOneAndUpdate(
    { _id: id, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: now, deletedBy: userId || null, deleteReason: str(reason, 300) || '' } },
    { new: true }
  ).lean();
  if (!tip) throw httpError(404, 'Tip not found (maybe already deleted)');
  await Expense.updateMany(
    { $or: [{ _id: tip.expense }, { sourceType: 'Tip', sourceRef: tip._id }], isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: now, deletedBy: userId || null } }
  );
  return tipView(tip);
}

module.exports = { EXPENSE_CATEGORY, ensureTipsCategory, createTips, listTips, deleteTip };
