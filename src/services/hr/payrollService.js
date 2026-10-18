// src/services/hr/payrollService.js
// Payroll: salary advances, deductions (incl. till shortages from cash closing),
// the monthly payroll run (generate → review → approve → pay) and payslips.
// OWNER: Payroll module.
//
// The numbers come from attendanceCore.monthSummary (policy already applied in
// DAYS); this file turns them into money with each employee's HR policy.
// Money on a payroll line is in whole rupees.
//
//   Advances    createAdvance, listAdvances, getAdvance, cancelAdvance
//   Deductions  listDeductions, createDeduction, approveDeduction, waiveDeduction,
//               recordTillShortage(session)   ← tillService calls this on verify
//   Runs        listRuns, getRun, generateRun, regenerateRun, updateLine, deleteRun,
//               approveRun, reopenRun, payRun, payslip, exportCsv
//   Pure        baseLine, finishLine, totalsOf (calculation, no database)
//
// Calculation rules (all values from the employee's policy):
//   monthly  base = salary (prorated: day rate × employed days when joined / left mid-month)
//            day rate = salary ÷ divisor (fixed days | days in month | working days)
//            hourly rate = day rate ÷ default-shift work hours (else 8)
//            cuts: absent, half day, late (days, or minutes × minute rate), unpaid leave,
//                  weekly offs / holidays when the policy says they are unpaid
//   daily    wage = days worked × daily rate (+ overtime; off-day work is paid as a day)
//            late rule applies
//   overtime = approved minutes ÷ 60 × hourly rate × policy rate (pending is not paid)
//   then, from what is left: approved deductions (oldest first, till shortages
//   capped at tillShortage.maxPerMonth), then advance installments. Anything
//   that does not fit is carried to next month; net pay is never below 0.
const mongoose = require('mongoose');
const T = require('../analytics/time');
const Employee = require('../../models/employee');
const Shift = require('../../models/shift');
const AttendanceRecord = require('../../models/attendanceRecord');
const PayrollDeduction = require('../../models/payrollDeduction');
const SalaryAdvance = require('../../models/salaryAdvance');
const PayrollRun = require('../../models/payrollRun');
const Expense = require('../../models/expense');
const ExpenseCategory = require('../../models/expenseCategory');
const Settings = require('../../models/settings');
const core = require('./attendanceCore');
const schedule = require('./scheduleService');
const policies = require('./policyService');
const { rupeesInWords } = require('./numberWords');
const { httpError, isId, paging, pageMeta, toCsv, containsRe, str } = require('./util');
const { nextNumber } = require('../sequenceService');
const notificationService = require('../notificationService');

const { ObjectId } = mongoose.Types;

const ACTIVE = Employee.ACTIVE_STATUSES || ['active', 'on_leave'];
const METHODS = ['cash', 'bank', 'easypaisa', 'jazzcash'];
const METHOD_LABEL = { cash: 'Cash', bank: 'Bank transfer', easypaisa: 'Easypaisa', jazzcash: 'JazzCash' };
const EXPENSE_METHOD = { cash: 'Cash', bank: 'Bank Transfer', easypaisa: 'Other', jazzcash: 'Other' };
const EXPENSE_CATEGORY = 'Salaries';
const LOCK_NOTE = 'Payroll lock'; // placeholder day records created by approve (removed by reopen)
const MAX_MONEY = 10000000;

// Rows the calculation makes from attendance (the rest come from manual inputs,
// deductions and advances and are rebuilt by finishLine).
const AUTO_EARNINGS = new Set(['base', 'days', 'overtime']);
const AUTO_CUTS = new Set(['absent', 'half_day', 'late', 'unpaid_leave', 'unpaid_off', 'unpaid_holiday']);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const rs = (n) => Math.round(Number(n) || 0); // whole rupees
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, f = (x) => x) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : '');
const nameOf = (e) => (e ? `${e.firstName || ''} ${e.lastName || ''}`.trim() : '');

const fmtRs = (n) => {
  const v = rs(n);
  return `${v < 0 ? '-' : ''}Rs ${Math.abs(v).toLocaleString('en-US')}`;
};
const fmtRate = (n) => {
  const v = r2(n);
  return `Rs ${v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const num = (n) => String(r2(n));
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;
const hoursText = (minutes) => {
  const m = Math.round(Number(minutes) || 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h} h ${rest} min`;
  return h ? `${h} h` : `${rest} min`;
};
const dayLabel = (d) => {
  if (!d) return '';
  const key = typeof d === 'string' && T.isDayKey(d) ? d : T.dayKey(new Date(d));
  const [, m, day] = key.split('-').map(Number);
  return `${day} ${T.MONTH_NAMES[m - 1]}`;
};

function assertMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) throw httpError(400, 'Pick a month (YYYY-MM)', 'INVALID_MONTH');
  return String(month);
}

function periodOf(month) {
  const daysInMonth = T.daysInMonth(month);
  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  return {
    month,
    label: T.monthLabel(month),
    from,
    to,
    daysInMonth,
    start: T.dayStart(from),
    endExclusive: T.dayStart(T.addDays(to, 1)), // items dated before this belong to the month
  };
}

/** Whole rupees from user input. */
function rupees(v, label, { allowNull = false, allowNegative = false, min = 0 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (allowNull) return null;
    throw httpError(400, `${label} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${label} must be a number`);
  const whole = Math.round(n);
  if (!allowNegative && whole < min) throw httpError(400, `${label} must be ${min} or more`);
  if (Math.abs(whole) > MAX_MONEY) throw httpError(400, `${label} is too large`);
  return whole;
}

/** A shop day ('YYYY-MM-DD' → noon PKT) or an ISO date; never in the future. */
function shopDate(v, label = 'Date', now = new Date()) {
  if (v === undefined || v === null || v === '') return new Date(now);
  const s = String(v);
  const d = T.isDayKey(s) ? new Date(T.dayStart(s).getTime() + 12 * 3600 * 1000) : new Date(s);
  if (Number.isNaN(d.getTime())) throw httpError(400, `Invalid ${label.toLowerCase()}`);
  if (T.dayKey(d) > T.dayKey(now)) throw httpError(400, `${label} cannot be in the future`);
  return d;
}

const method = (v, fallback = 'cash') => {
  const m = String(v || fallback).toLowerCase();
  if (!METHODS.includes(m)) throw httpError(400, 'Payment method must be cash, bank, easypaisa or jazzcash');
  return m;
};

const historyRow = (userId, action, note = '', at = new Date()) => ({ at, by: userId || null, action, note });

async function employeeMap(ids, fields = 'firstName lastName employeeCode designation phone') {
  const list = await Employee.find({ _id: { $in: ids } }).select(fields).lean();
  return new Map(list.map((e) => [String(e._id), e]));
}

/* ------------------------------------------------------------------ */
/* Advances                                                            */
/* ------------------------------------------------------------------ */

/** What the next payroll suggests to recover from this advance. */
function nextInstallment(a, { fullBalance = false } = {}) {
  const balance = rs(a.balance);
  const done = (a.recoveries || []).length;
  const remaining = Math.max(1, (Number(a.installments) || 1) - done);
  const suggested = remaining === 1 || fullBalance ? balance : Math.min(balance, Math.round(balance / remaining));
  return { balance, remaining, suggested, installmentNo: Math.min(done + 1, Number(a.installments) || 1) };
}

function advanceView(a) {
  const next = a.status === 'open' ? nextInstallment(a) : null;
  return { ...a, perMonth: next ? next.suggested : 0, remainingInstallments: next ? next.remaining : 0 };
}

async function loadEmployee(employeeId) {
  if (!isId(employeeId)) throw httpError(400, 'Pick an employee');
  const e = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } })
    .select('firstName lastName employeeCode designation status hrPolicy user payType salary dailyRate phone')
    .lean();
  if (!e) throw httpError(404, 'Employee not found');
  return e;
}

async function createAdvance(body = {}, { userId, now = new Date() } = {}) {
  const e = await loadEmployee(body.employeeId || body.employee);
  if (!ACTIVE.includes(e.status)) throw httpError(400, `${nameOf(e)} is not working here now`);
  const amount = rupees(body.amount, 'Amount', { min: 1 });
  const installments = Math.round(Number(body.installments ?? 1));
  if (!Number.isFinite(installments) || installments < 1 || installments > 24) {
    throw httpError(400, 'Installments must be 1 to 24 months');
  }
  const doc = await SalaryAdvance.create({
    advanceNo: await nextNumber('ADV'),
    employee: e._id,
    employeeName: nameOf(e),
    employeeCode: e.employeeCode || '',
    amount,
    date: shopDate(body.date, 'Date', now),
    method: method(body.method),
    reference: str(body.reference, 120) || '',
    installments,
    note: str(body.note, 500) || '',
    recovered: 0,
    balance: amount,
    status: 'open',
    createdBy: userId || null,
    history: [historyRow(userId, 'given', `${fmtRs(amount)} in ${plural(installments, 'installment')}`, now)],
  });
  return advanceView(doc.toObject());
}

async function listAdvances(query = {}) {
  const { page, limit, skip } = paging(query);
  const filter = {};
  if (query.employee || query.employeeId) {
    const id = query.employee || query.employeeId;
    if (!isId(id)) throw httpError(400, 'Invalid employee');
    filter.employee = new ObjectId(String(id));
  }
  if (query.status && query.status !== 'all') {
    if (!SalaryAdvance.STATUSES.includes(query.status)) throw httpError(400, 'Unknown status');
    filter.status = query.status;
  }
  if (query.search && String(query.search).trim()) {
    const re = containsRe(query.search);
    filter.$or = [{ employeeName: re }, { advanceNo: re }, { employeeCode: re }];
  }
  const [total, rows, open] = await Promise.all([
    SalaryAdvance.countDocuments(filter),
    SalaryAdvance.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    SalaryAdvance.aggregate([{ $match: { status: 'open' } }, { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balance' } } }]),
  ]);
  const o = open[0] || { count: 0, balance: 0 };
  return { data: rows.map(advanceView), meta: { ...pageMeta({ page, limit }, total), summary: { openCount: o.count, openBalance: rs(o.balance) } } };
}

async function getAdvance(id) {
  if (!isId(id)) throw httpError(404, 'Advance not found');
  const a = await SalaryAdvance.findById(id).lean();
  if (!a) throw httpError(404, 'Advance not found');
  return advanceView(a);
}

async function cancelAdvance(id, { reason } = {}, { userId, now = new Date() } = {}) {
  const a = await getAdvance(id);
  if (a.status === 'cancelled') throw httpError(409, 'This advance is already cancelled');
  if (a.recovered > 0 || (a.recoveries || []).length) {
    throw httpError(409, 'Part of this advance is already taken back from salary — it cannot be cancelled', 'ADVANCE_RECOVERED');
  }
  const note = str(reason, 300) || '';
  const updated = await SalaryAdvance.findOneAndUpdate(
    { _id: a._id, status: 'open', recovered: 0, 'recoveries.0': { $exists: false } },
    {
      $set: { status: 'cancelled', balance: 0, cancelledAt: now, cancelledBy: userId || null, cancelReason: note },
      $push: { history: historyRow(userId, 'cancelled', note, now) },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This advance was just changed. Refresh.');
  return advanceView(updated);
}

/** Active staff for the pickers (payroll permission, no employees permission needed). */
async function employeeOptions(query = {}) {
  const filter = { isDeleted: { $ne: true }, status: { $in: ACTIVE } };
  if (query.search && String(query.search).trim()) {
    const re = containsRe(query.search);
    filter.$or = [{ firstName: re }, { lastName: re }, { employeeCode: re }, { phone: re }];
  }
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const list = await Employee.find(filter)
    .select('firstName lastName employeeCode designation payType salary dailyRate phone user')
    .sort({ firstName: 1, lastName: 1 })
    .limit(limit)
    .lean();
  const balances = await SalaryAdvance.aggregate([
    { $match: { status: 'open', employee: { $in: list.map((e) => e._id) } } },
    { $group: { _id: '$employee', balance: { $sum: '$balance' } } },
  ]);
  const balBy = new Map(balances.map((b) => [String(b._id), rs(b.balance)]));
  return list.map((e) => ({
    _id: e._id,
    name: nameOf(e),
    code: e.employeeCode || '',
    designation: e.designation || '',
    payType: e.payType || 'monthly',
    salary: Number(e.salary) || 0,
    dailyRate: Number(e.dailyRate) || 0,
    phone: e.phone || '',
    advanceBalance: balBy.get(String(e._id)) || 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Deductions                                                          */
/* ------------------------------------------------------------------ */

const DEDUCTION_TYPES = ['till_shortage', 'damage', 'other'];
const DEDUCTION_LABEL = { till_shortage: 'Till shortage', damage: 'Damage', other: 'Deduction' };

async function deductionViews(rows) {
  const emps = await employeeMap([...new Set(rows.map((d) => idOf(d.employee)))]);
  return rows.map((d) => {
    const e = emps.get(idOf(d.employee));
    return {
      ...d,
      employeeName: nameOf(e) || 'Unknown employee',
      employeeCode: (e && e.employeeCode) || '',
      typeLabel: DEDUCTION_LABEL[d.type] || d.type,
      link: d.refType === 'CashSession' && d.refId ? `/admin/till?session=${d.refId}` : '',
    };
  });
}

async function listDeductions(query = {}) {
  const { page, limit, skip } = paging(query);
  const filter = {};
  if (query.status && query.status !== 'all') {
    const list = String(query.status).split(',').filter(Boolean);
    if (list.some((s) => !PayrollDeduction.schema.path('status').enumValues.includes(s))) throw httpError(400, 'Unknown status');
    filter.status = { $in: list };
  }
  if (query.type && query.type !== 'all') {
    if (!DEDUCTION_TYPES.includes(query.type)) throw httpError(400, 'Unknown type');
    filter.type = query.type;
  }
  if (query.employee || query.employeeId) {
    const id = query.employee || query.employeeId;
    if (!isId(id)) throw httpError(400, 'Invalid employee');
    filter.employee = new ObjectId(String(id));
  }
  const [total, rows, counts] = await Promise.all([
    PayrollDeduction.countDocuments(filter),
    PayrollDeduction.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    PayrollDeduction.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);
  const summary = { pending: { count: 0, amount: 0 }, approved: { count: 0, amount: 0 }, applied: { count: 0, amount: 0 }, waived: { count: 0, amount: 0 } };
  for (const c of counts) if (summary[c._id]) summary[c._id] = { count: c.count, amount: r2(c.amount) };
  return { data: await deductionViews(rows), meta: { ...pageMeta({ page, limit }, total), summary } };
}

async function getDeductionDoc(id) {
  if (!isId(id)) throw httpError(404, 'Deduction not found');
  const d = await PayrollDeduction.findById(id).lean();
  if (!d) throw httpError(404, 'Deduction not found');
  return d;
}

async function createDeduction(body = {}, { userId, canApprove = false, now = new Date() } = {}) {
  const e = await loadEmployee(body.employeeId || body.employee);
  const type = String(body.type || 'other');
  if (!['damage', 'other'].includes(type)) throw httpError(400, 'Type must be damage or other (till shortages come from cash closing)');
  const amount = rupees(body.amount, 'Amount', { min: 1 });
  const note = str(body.note, 500);
  if (!note) throw httpError(400, 'Write what this deduction is for');
  const approveNow = body.approveNow === true || body.approveNow === 'true';
  if (approveNow && !canApprove) throw httpError(403, 'You cannot approve deductions');
  const doc = await PayrollDeduction.create({
    employee: e._id,
    type,
    amount,
    date: shopDate(body.date, 'Date', now),
    refNo: str(body.refNo, 60) || '',
    note,
    status: approveNow ? 'approved' : 'pending',
    decidedBy: approveNow ? userId : null,
    decidedAt: approveNow ? now : null,
    createdBy: userId || null,
  });
  return (await deductionViews([doc.toObject()]))[0];
}

/** pending → approved (optionally for a smaller amount). */
async function approveDeduction(id, body = {}, { userId, now = new Date() } = {}) {
  const d = await getDeductionDoc(id);
  if (d.status !== 'pending') throw httpError(409, `This deduction is already ${d.status}`);
  const set = { status: 'approved', decidedBy: userId || null, decidedAt: now };
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    const amount = rupees(body.amount, 'Amount', { min: 1 });
    if (amount > rs(d.amount)) throw httpError(400, `Amount cannot be more than ${fmtRs(d.amount)}`);
    if (amount !== rs(d.amount)) {
      set.amount = amount;
      set.note = `${d.note ? `${d.note} · ` : ''}approved ${fmtRs(amount)} of ${fmtRs(d.amount)}`.slice(0, 1000);
    }
  }
  const updated = await PayrollDeduction.findOneAndUpdate({ _id: d._id, status: 'pending' }, { $set: set }, { new: true }).lean();
  if (!updated) throw httpError(409, 'This deduction was just changed. Refresh.');
  return (await deductionViews([updated]))[0];
}

/** pending | approved → waived (note required). Applied ones cannot be waived. */
async function waiveDeduction(id, body = {}, { userId, now = new Date() } = {}) {
  const d = await getDeductionDoc(id);
  if (!['pending', 'approved'].includes(d.status)) throw httpError(409, `This deduction is already ${d.status}`);
  const why = str(body.note, 500);
  if (!why) throw httpError(400, 'Write why it is waived');
  const updated = await PayrollDeduction.findOneAndUpdate(
    { _id: d._id, status: { $in: ['pending', 'approved'] } },
    { $set: { status: 'waived', decidedBy: userId || null, decidedAt: now, note: `${d.note ? `${d.note} · ` : ''}Waived: ${why}`.slice(0, 1000) } },
    { new: true }
  ).lean();
  if (!updated) throw httpError(409, 'This deduction was just changed. Refresh.');
  return (await deductionViews([updated]))[0];
}

/**
 * Till hook: a verified cash closing that is short becomes a till-shortage
 * deduction for the cashier's employee record (when their policy says so).
 * One per session (unique ref), never throws — verifying must not fail because of payroll.
 */
async function recordTillShortage(session, { userId = null, now = new Date() } = {}) {
  try {
    if (!session || !session._id) return null;
    const variance = Number(session.variance);
    if (!Number.isFinite(variance) || variance >= 0) return null;
    const shortage = r2(-variance);
    if (shortage < 1) return null; // paisa differences are not cut
    const employee = await Employee.findOne({ user: session.cashier, isDeleted: { $ne: true } })
      .select('firstName lastName hrPolicy')
      .lean();
    if (!employee) {
      console.warn(`[payroll] till ${session.sessionNo} short ${fmtRs(shortage)}: cashier has no employee record, no deduction made`);
      return null;
    }
    const policy = await policies.policyFor(employee);
    const rule = policy.tillShortage || {};
    if (!rule.deduct) return null;
    if (await PayrollDeduction.exists({ refType: 'CashSession', refId: session._id })) return null;
    const pending = rule.needsApproval !== false;
    const doc = await PayrollDeduction.create({
      employee: employee._id,
      type: 'till_shortage',
      amount: shortage,
      date: session.closedAt || now,
      refType: 'CashSession',
      refId: session._id,
      refNo: session.sessionNo || '',
      note: `${session.counterName ? `${session.counterName}: ` : ''}cash short ${fmtRate(shortage)} at closing (verified)`,
      status: pending ? 'pending' : 'approved',
      decidedBy: pending ? null : userId,
      decidedAt: pending ? null : now,
      createdBy: userId,
    });
    if (pending) {
      await notificationService.notify({
        type: 'payroll_deduction_pending',
        level: 'warning',
        title: `Till shortage to approve: ${nameOf(employee)}`,
        message: `${session.sessionNo} was short ${fmtRate(shortage)}. Approve or waive it before payroll.`,
        link: '/admin/hr/advances?tab=deductions&status=pending',
        branchId: session.branch,
        audience: 'payroll',
        meta: { deductionId: doc._id, sessionId: session._id },
      });
    }
    return doc.toObject();
  } catch (err) {
    if (err && err.code === 11000) return null; // already recorded (two verifies at once)
    console.error('[payroll] till shortage deduction failed:', err && err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Line calculation (pure)                                             */
/* ------------------------------------------------------------------ */

const policySnapshot = (p) => ({
  _id: p._id,
  name: p.name,
  attendance: p.attendance || {},
  pay: p.pay || {},
  overtime: p.overtime || {},
  leave: p.leave || {},
  tillShortage: p.tillShortage || {},
});

/**
 * Everything that comes from attendance, rates and open items (no manual inputs).
 * @param input { employee, summary (monthSummary row with days), policy, period,
 *                workMinutes (default shift), wholeMonthShiftDays, advances, deductions }
 */
function baseLine({ employee: e, summary: s, policy: p, period, workMinutes = 0, wholeMonthShiftDays = 0, advances = [], deductions = [] }) {
  const pay = p.pay || {};
  const ot = p.overtime || {};
  const att = p.attendance || {};
  const lr = att.lateRule || {};
  const cuts = s.cuts || {};
  const payType = e.payType === 'daily' ? 'daily' : 'monthly';
  const salary = r2(e.salary);
  const dailyRate = r2(e.dailyRate);
  const employedDays = period.daysInMonth - (s.notEmployedDays || 0);
  const days = s.days || [];
  const past = (d) => d.status !== 'upcoming' && d.status !== 'not_employed';

  const joinedKey = e.joiningDate || e.hireDate ? T.dayKey(new Date(e.joiningDate || e.hireDate)) : '';
  const leftKey = e.exitDate ? T.dayKey(new Date(e.exitDate)) : '';
  const joinedOn = joinedKey > period.from && joinedKey <= period.to ? joinedKey : '';
  const leftOn = leftKey >= period.from && leftKey < period.to ? leftKey : '';

  // ---- rates ----
  let divisor;
  let divisorLabel;
  if (payType === 'daily') {
    divisor = 1;
    divisorLabel = 'daily wage';
  } else if (pay.dayDivisor === 'month_days') {
    divisor = period.daysInMonth;
    divisorLabel = `salary ÷ ${divisor} (days in ${period.label})`;
  } else if (pay.dayDivisor === 'working_days') {
    divisor = wholeMonthShiftDays;
    divisorLabel = `salary ÷ ${divisor} (working days in ${period.label})`;
  } else {
    divisor = Number(pay.fixedDays) || 30;
    divisorLabel = `salary ÷ ${divisor}`;
  }
  if (!(divisor > 0)) {
    divisor = Number(pay.fixedDays) || 30;
    divisorLabel = `salary ÷ ${divisor} (no working days planned)`;
  }
  const dayRate = payType === 'daily' ? dailyRate : salary / divisor;
  const workHours = workMinutes > 0 ? workMinutes / 60 : 8;
  const hourlyRate = dayRate / workHours;

  // ---- overtime minutes (daily wage: work on an off day / holiday is paid as a day, not as overtime) ----
  let otPaid = Number(s.overtimeMinutesApproved) || 0;
  let otPending = Number(s.overtimeMinutesPending) || 0;
  let otOffDay = 0;
  if (payType === 'daily') {
    otPaid = 0;
    otPending = 0;
    for (const d of days) {
      if (!past(d) || !(d.overtimeMinutes > 0)) continue;
      const offDay = d.planned === 'off' || d.planned === 'holiday';
      if (d.overtimeApproved === true) {
        if (offDay) otOffDay += d.overtimeMinutes;
        else otPaid += d.overtimeMinutes;
      } else if (d.overtimeApproved === null && !offDay) otPending += d.overtimeMinutes;
    }
  }
  const otRate = ot.enabled === false ? 0 : Number(ot.rate ?? 1) || 0;

  // ---- earnings ----
  const earnings = [];
  if (payType === 'monthly') {
    const units = pay.dayDivisor === 'working_days' ? s.scheduledDaysInMonth : employedDays;
    const full = !s.notEmployedDays;
    const base = full ? salary : Math.min(salary, dayRate * units);
    const why = [joinedOn ? `joined ${dayLabel(joinedOn)}` : '', leftOn ? `left ${dayLabel(leftOn)}` : ''].filter(Boolean).join(', ');
    earnings.push({
      key: 'base',
      label: 'Basic salary',
      amount: rs(base),
      detail: full
        ? `Monthly salary ${fmtRs(salary)}`
        : `${why ? `${why[0].toUpperCase()}${why.slice(1)}: ` : ''}${plural(units, pay.dayDivisor === 'working_days' ? 'working day' : 'day')} × ${fmtRate(dayRate)} = ${fmtRs(base)} (of ${fmtRs(salary)})`,
    });
  } else {
    const halfPart = r2(s.halfDays * (1 - (Number(pay.halfDayCut) || 0)));
    const parts = [];
    if (s.presentDays) parts.push(plural(s.presentDays, 'full day'));
    if (s.halfDays) parts.push(`${plural(s.halfDays, 'half day')} (${num(halfPart)})`);
    if (s.offDaysWorked) parts.push(plural(s.offDaysWorked, 'off day worked', 'off days worked'));
    const wage = s.daysWorked * dailyRate;
    earnings.push({
      key: 'days',
      label: 'Daily wage',
      amount: rs(wage),
      detail: `${parts.length > 1 ? `${parts.join(' + ')} = ` : ''}${plural(s.daysWorked, 'day')} × ${fmtRate(dailyRate)} = ${fmtRs(wage)}`,
    });
  }
  if (otPaid > 0 && otRate > 0) {
    const amount = (otPaid / 60) * hourlyRate * otRate;
    earnings.push({
      key: 'overtime',
      label: 'Overtime',
      amount: rs(amount),
      detail:
        `${hoursText(otPaid)} approved × ${fmtRate(hourlyRate)}/hour${otRate !== 1 ? ` × ${num(otRate)}` : ''} = ${fmtRs(amount)}` +
        (otPending > 0 ? ` (${hoursText(otPending)} still waiting for approval, not paid)` : ''),
    });
  }

  // ---- attendance cuts ----
  const deductionsRows = [];
  const rate = dayRate;
  const cutRow = (key, label, cutDays, why) => {
    const amount = cutDays * rate;
    if (rs(amount) > 0) deductionsRows.push({ key, label, amount: rs(amount), detail: `${why} → ${plural(cutDays, 'day')} = ${fmtRs(amount)}` });
  };
  if (payType === 'monthly') {
    cutRow('absent', 'Absent', Number(cuts.absentCutDays) || 0, plural(s.absentDays, 'absent day'));
    cutRow('half_day', 'Half days', Number(cuts.halfDayCutDays) || 0, plural(s.halfDays, 'half day'));
  }
  // Late rule (both pay types).
  const earlyAsLate = !!att.earlyLeaveCountsAsLate;
  if (cuts.lateRule === 'minutes' && cuts.lateCutMinutes > 0) {
    const amount = cuts.lateCutMinutes * (hourlyRate / 60);
    if (rs(amount) > 0) {
      deductionsRows.push({
        key: 'late',
        label: 'Late minutes',
        amount: rs(amount),
        detail: `${plural(cuts.lateCutMinutes, 'minute')} late${earlyAsLate && s.earlyLeaveMinutes ? ' / left early' : ''} × ${fmtRate(hourlyRate / 60)}/min = ${fmtRs(amount)}`,
      });
    }
  } else if (cuts.lateRule === 'count' && cuts.lateCutDays > 0) {
    const parts = [plural(s.lateCount, 'late')];
    if (earlyAsLate && s.earlyLeaveCount) parts.push(plural(s.earlyLeaveCount, 'early leave'));
    const amount = cuts.lateCutDays * rate;
    deductionsRows.push({
      key: 'late',
      label: 'Lates',
      amount: rs(amount),
      detail: `${parts.join(' + ')} → ${plural(cuts.lateCutDays, 'day')} = ${fmtRs(amount)} (every ${Number(lr.latesPerCut) || 3} = ${plural(Number(lr.cutDays) || 0, 'day')})`,
    });
  }
  if (payType === 'monthly') {
    const leave = s.leave || {};
    const extraPaid = (leave.paid || 0) - (leave.paidWithinQuota ?? leave.paid ?? 0);
    const extraSick = (leave.sick || 0) - (leave.sickWithinQuota ?? leave.sick ?? 0);
    const parts = [];
    if (leave.unpaid) parts.push(`${plural(leave.unpaid, 'day')} unpaid leave`);
    if (extraPaid > 0) parts.push(`${plural(extraPaid, 'paid leave day')} over the monthly quota`);
    if (extraSick > 0) parts.push(`${plural(extraSick, 'sick day')} over the monthly quota`);
    cutRow('unpaid_leave', 'Unpaid leave', Number(cuts.unpaidLeaveCutDays) || 0, parts.join(' + ') || 'Unpaid leave');
    // Unpaid weekly offs / holidays (only when the policy says so). A worked one is paid as overtime.
    const offDays = days.filter((d) => past(d) && d.planned === 'off').length;
    const holidays = days.filter((d) => past(d) && d.planned === 'holiday').length;
    if (pay.paidWeeklyOff === false && offDays) cutRow('unpaid_off', 'Unpaid weekly offs', offDays, `${plural(offDays, 'weekly off')} (unpaid by policy)`);
    if (pay.paidHolidays === false && holidays) cutRow('unpaid_holiday', 'Unpaid holidays', holidays, `${plural(holidays, 'holiday')} (unpaid by policy)`);
  }

  // ---- open items (used amounts are decided by finishLine) ----
  const lastMonth = !!leftOn || (leftKey && leftKey <= period.to);
  const advanceItems = advances.map((a) => {
    const next = nextInstallment(a, { fullBalance: lastMonth });
    return {
      advance: a._id,
      advanceNo: a.advanceNo,
      date: a.date,
      amount: rs(a.amount),
      balance: next.balance,
      installments: Number(a.installments) || 1,
      installmentNo: next.installmentNo,
      suggested: next.suggested,
      used: 0,
    };
  });
  const deductionItems = deductions.map((d) => ({
    deduction: d._id,
    type: d.type,
    refNo: d.refNo || '',
    date: d.date,
    note: d.note || '',
    amount: r2(d.amount),
    used: 0,
  }));

  return {
    employee: e._id,
    name: nameOf(e),
    code: e.employeeCode || '',
    designation: e.designation || '',
    payType,
    policy: policySnapshot(p),
    salary,
    dailyRate,
    dayRate: r2(dayRate),
    hourlyRate: r2(hourlyRate),
    divisor,
    divisorLabel,
    workHoursPerDay: r2(workHours),
    employedDays,
    joinedOn,
    leftOn,
    attendance: {
      scheduledDaysInMonth: s.scheduledDaysInMonth,
      scheduledDays: s.scheduledDays,
      presentDays: s.presentDays,
      daysWorked: s.daysWorked,
      lateCount: s.lateCount,
      lateMinutes: s.lateMinutes,
      earlyLeaveCount: s.earlyLeaveCount,
      earlyLeaveMinutes: s.earlyLeaveMinutes,
      halfDays: s.halfDays,
      absentDays: s.absentDays,
      missingOutDays: s.missingOutDays,
      pendingCorrections: s.pendingCorrections,
      offDays: s.offDays,
      holidayDays: s.holidayDays,
      offDaysWorked: s.offDaysWorked,
      leave: s.leave,
      workedMinutes: s.workedMinutes,
      overtimeMinutesApproved: s.overtimeMinutesApproved,
      overtimeMinutesPending: otPending,
      overtimeMinutesPaid: otRate > 0 ? otPaid : 0,
      overtimeMinutesOffDay: otOffDay,
      upcomingDays: s.upcomingDays,
      notEmployedDays: s.notEmployedDays,
      cuts,
    },
    earnings,
    deductions: deductionsRows,
    advanceItems,
    deductionItems,
    status: 'pending',
  };
}

const deductionLabel = (d) => `${DEDUCTION_LABEL[d.type] || 'Deduction'}${d.refNo ? ` ${d.refNo}` : ''}`;

/**
 * Manual inputs + money waterfall → final rows, net, used amounts. Pure; works
 * on a fresh baseLine or a saved line (keeps its attendance rows).
 */
function finishLine(line) {
  const notes = [];
  const earnings = (line.earnings || []).filter((r) => AUTO_EARNINGS.has(r.key));
  const deductions = (line.deductions || []).filter((r) => AUTO_CUTS.has(r.key));
  const bonus = rs(line.bonus);
  if (bonus > 0) earnings.push({ key: 'bonus', label: 'Bonus', amount: bonus, detail: line.bonusNote || '' });
  for (const a of line.adjustments || []) {
    const amount = rs(a.amount);
    if (amount > 0) earnings.push({ key: `adj_${a._id}`, label: a.label, amount, detail: a.note || '' });
    else if (amount < 0) deductions.push({ key: `adj_${a._id}`, label: a.label, amount: -amount, detail: a.note || '' });
  }

  const gross = sum(earnings, (r) => r.amount);
  let available = gross - sum(deductions, (r) => r.amount);
  let shortfall = 0;
  if (available < 0) {
    shortfall = -available;
    available = 0;
    notes.push(`Deductions are ${fmtRs(shortfall)} more than the pay, so net pay is Rs 0.`);
  }

  // Approved deductions, oldest first. Till shortages respect the monthly cap.
  const cap = Number(line.policy && line.policy.tillShortage && line.policy.tillShortage.maxPerMonth) || 0;
  let tillLeft = cap > 0 ? cap : Infinity;
  for (const d of line.deductionItems || []) {
    const full = rs(d.amount);
    const want = d.type === 'till_shortage' ? Math.min(full, tillLeft) : full;
    const used = Math.max(0, Math.min(want, available));
    d.used = used;
    available -= used;
    if (d.type === 'till_shortage') tillLeft -= used;
    if (used > 0) {
      deductions.push({
        key: `ded_${d.deduction}`,
        label: deductionLabel(d),
        amount: used,
        detail: `${dayLabel(d.date)}${d.note ? `: ${d.note}` : ''}${used < full ? ` (${fmtRs(used)} of ${fmtRs(full)})` : ''}`,
      });
    }
    if (used < full) {
      const why = used < want ? 'not enough pay' : `monthly till-shortage limit ${fmtRs(cap)}`;
      notes.push(`${deductionLabel(d)}: ${fmtRs(full - used)} moves to next month (${why}).`);
    }
  }

  // Advance installments (or the manager's amount), from what is left.
  const items = line.advanceItems || [];
  const balance = sum(items, (a) => a.balance);
  const suggested = sum(items, (a) => a.suggested);
  const override = line.advanceRecoveryOverride === null || line.advanceRecoveryOverride === undefined ? null : rs(line.advanceRecoveryOverride);
  const want = override === null ? suggested : Math.min(override, balance);
  const take = Math.max(0, Math.min(want, available));
  let left = take;
  for (const a of items) {
    a.used = Math.min(a.suggested, a.balance, left);
    left -= a.used;
  }
  for (const a of items) {
    if (left <= 0) break;
    const extra = Math.min(a.balance - a.used, left);
    a.used += extra;
    left -= extra;
  }
  for (const a of items) {
    if (a.used <= 0) continue;
    const after = a.balance - a.used;
    deductions.push({
      key: `adv_${a.advance}`,
      label: `Advance ${a.advanceNo}`,
      amount: a.used,
      detail: `${after > 0 ? `Installment ${a.installmentNo} of ${a.installments}` : 'Last installment'} · ${fmtRs(after)} left after this`,
    });
  }
  if (override !== null && override !== suggested) notes.push(`Advance recovery set to ${fmtRs(want)} (plan was ${fmtRs(suggested)}).`);
  if (take < want) notes.push(`Advance: ${fmtRs(want - take)} not taken this month (not enough pay).`);
  available -= take;

  return Object.assign(line, {
    earnings,
    deductions,
    gross,
    totalDeductions: sum(deductions, (r) => r.amount),
    net: available,
    shortfall,
    notes,
    bonus,
    advanceSuggested: suggested,
    advanceRecovery: take,
  });
}

function totalsOf(lines) {
  const t = { staff: lines.length, gross: 0, deductions: 0, net: 0, overtime: 0, bonus: 0, advanceRecovery: 0, paid: 0, unpaid: 0, paidCount: 0 };
  for (const l of lines) {
    t.gross += l.gross;
    t.deductions += l.totalDeductions;
    t.net += l.net;
    t.overtime += sum((l.earnings || []).filter((r) => r.key === 'overtime'), (r) => r.amount);
    t.bonus += rs(l.bonus);
    t.advanceRecovery += rs(l.advanceRecovery);
    if (l.status === 'paid') {
      t.paid += l.net;
      t.paidCount += 1;
    } else t.unpaid += l.net;
  }
  return t;
}

/** What must not change between the reviewed draft and approval. */
const lineSignature = (l) =>
  JSON.stringify([
    idOf(l.employee),
    l.gross,
    l.totalDeductions,
    l.net,
    (l.earnings || []).map((r) => [r.key, r.amount]),
    (l.deductions || []).map((r) => [r.key, r.amount]),
    (l.deductionItems || []).map((d) => [idOf(d.deduction), rs(d.amount), d.used]),
    (l.advanceItems || []).map((a) => [idOf(a.advance), a.balance, a.used]),
  ]);
const runSignature = (lines) => lines.map(lineSignature).sort().join('\n');

/* ------------------------------------------------------------------ */
/* Building a month                                                    */
/* ------------------------------------------------------------------ */

const EMP_SELECT = `${core.EMP_FIELDS} phone`;

const manualOf = (l) => ({
  bonus: rs(l.bonus),
  bonusNote: l.bonusNote || '',
  adjustments: (l.adjustments || []).map((a) => ({ _id: a._id, label: a.label, amount: rs(a.amount), note: a.note || '' })),
  advanceRecoveryOverride: l.advanceRecoveryOverride === null || l.advanceRecoveryOverride === undefined ? null : rs(l.advanceRecoveryOverride),
  note: l.note || '',
});
const manualFromRun = (run) => new Map((run.lines || []).map((l) => [idOf(l.employee), manualOf(l)]));

/**
 * Lines + warnings for a month (no writes).
 * @param manual Map employeeId -> manual inputs to keep (regenerate / approve check)
 */
async function buildMonth(month, { now = new Date(), manual = new Map() } = {}) {
  const period = periodOf(month);
  // Everyone who may have worked in the month: active staff + those who left on/after the 1st.
  const candidates = await Employee.find({
    isDeleted: { $ne: true },
    $or: [{ status: { $in: ACTIVE } }, { exitDate: { $gte: period.start } }],
  })
    .select(EMP_SELECT)
    .lean();
  const empBy = new Map(candidates.map((e) => [String(e._id), e]));
  const summary = candidates.length
    ? await core.monthSummary(month, { employeeIds: candidates.map((e) => e._id), includeDays: true, now })
    : { employees: [] };
  const rows = summary.employees.filter((s) => empBy.has(s.employeeId) && s.notEmployedDays < period.daysInMonth);
  const ids = rows.map((s) => new ObjectId(s.employeeId));
  const emps = rows.map((s) => empBy.get(s.employeeId));

  const shiftIds = [...new Set(emps.map((e) => idOf(e.defaultShift)).filter(Boolean))];
  const [shifts, pols, advances, approved, pending] = await Promise.all([
    shiftIds.length ? Shift.find({ _id: { $in: shiftIds } }).setOptions({ withDeleted: true }).lean() : [],
    policies.policiesFor(emps),
    SalaryAdvance.find({ employee: { $in: ids }, status: 'open', balance: { $gt: 0 }, date: { $lt: period.endExclusive } })
      .sort({ date: 1, _id: 1 })
      .lean(),
    PayrollDeduction.find({ employee: { $in: ids }, status: 'approved', date: { $lt: period.endExclusive } }).sort({ date: 1, _id: 1 }).lean(),
    PayrollDeduction.find({ employee: { $in: ids }, status: 'pending', date: { $lt: period.endExclusive } }).sort({ date: 1 }).lean(),
  ]);
  const shiftBy = new Map(shifts.map((s) => [String(s._id), s]));

  // "Working days" divisor for someone who joined / left mid-month: count the
  // shifts of the WHOLE month as if they were employed all month.
  const wholeMonthShiftDays = new Map();
  const needWhole = emps.filter((e, i) => pols.get(String(e._id)).pay?.dayDivisor === 'working_days' && rows[i].notEmployedDays > 0);
  if (needWhole.length) {
    const plans = await schedule.planFor(
      needWhole.map((e) => ({ ...e, joiningDate: null, hireDate: null, exitDate: null })),
      period.from,
      period.to
    );
    for (const e of needWhole) wholeMonthShiftDays.set(String(e._id), (plans.get(String(e._id)) || []).filter((p) => p.type === 'shift').length);
  }

  const group = (list) => {
    const m = new Map();
    for (const x of list) {
      const k = String(x.employee);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  };
  const advBy = group(advances);
  const dedBy = group(approved);
  const pendingBy = group(pending);

  const lines = rows.map((s) => {
    const e = empBy.get(s.employeeId);
    const shift = e.defaultShift ? shiftBy.get(idOf(e.defaultShift)) : null;
    const line = baseLine({
      employee: e,
      summary: s,
      policy: pols.get(s.employeeId),
      period,
      workMinutes: shift ? Shift.workMinutes(shift) : 0,
      wholeMonthShiftDays: wholeMonthShiftDays.get(s.employeeId) ?? s.scheduledDaysInMonth,
      advances: advBy.get(s.employeeId) || [],
      deductions: dedBy.get(s.employeeId) || [],
    });
    Object.assign(line, manualOf(manual.get(s.employeeId) || {}));
    return finishLine(line);
  });
  lines.sort((a, b) => a.name.localeCompare(b.name));

  // ---- warnings (not blocking) ----
  const warnings = [];
  const today = T.dayKey(now);
  if (today <= period.to) {
    warnings.push({
      type: 'month_open',
      message: `${period.label} is not over yet, so these numbers will change. You can approve it from ${dayLabel(T.addDays(period.to, 1))}.`,
    });
  }
  // Attendance page (fingerprint punches; managers fix days there). Extra query params are hints.
  const attLink = (id, view) => `/admin/hr/attendance?view=${view}&month=${month}&employee=${id}`;
  for (const l of lines) {
    const id = idOf(l.employee);
    const a = l.attendance;
    if (a.overtimeMinutesPending > 0) {
      warnings.push({
        type: 'overtime_pending',
        message: `${l.name}: ${hoursText(a.overtimeMinutesPending)} overtime waiting for approval (not paid until approved).`,
        link: attLink(id, 'overtime'),
        linkLabel: 'Approve overtime',
        employee: l.employee,
        employeeName: l.name,
      });
    }
    if (a.pendingCorrections > 0) {
      const as = (l.policy.attendance && l.policy.attendance.missingOutCountsAs) || 'present';
      warnings.push({
        type: 'missing_out',
        message: `${l.name}: ${plural(a.pendingCorrections, 'day')} without a check-out (counted as ${as.replace('_', ' ')}).`,
        link: attLink(id, 'corrections'),
        linkLabel: 'Fix before payroll',
        employee: l.employee,
        employeeName: l.name,
      });
    }
    if (!a.scheduledDaysInMonth) {
      warnings.push({
        type: 'no_schedule',
        message: `${l.name} has no shift or roster this month, so absents cannot be counted.`,
        link: `/admin/hr/roster?month=${month}`,
        linkLabel: 'Set a schedule',
        employee: l.employee,
        employeeName: l.name,
      });
    }
    if ((l.payType === 'monthly' && !(l.salary > 0)) || (l.payType === 'daily' && !(l.dailyRate > 0))) {
      warnings.push({
        type: 'no_salary',
        message: `${l.name} has no ${l.payType === 'daily' ? 'daily rate' : 'salary'} set.`,
        link: `/admin/hr/employees/${id}/edit`,
        linkLabel: 'Set pay',
        employee: l.employee,
        employeeName: l.name,
      });
    }
    if (l.shortfall > 0) {
      warnings.push({ type: 'shortfall', message: `${l.name}: deductions are ${fmtRs(l.shortfall)} more than the pay (net pay kept at Rs 0).`, employee: l.employee, employeeName: l.name });
    }
    for (const n of l.notes) {
      if (n.includes('moves to next month') || n.includes('not taken this month')) {
        warnings.push({ type: 'carried', level: 'info', message: `${l.name}: ${n}`, employee: l.employee, employeeName: l.name });
      }
    }
    const waiting = pendingBy.get(id) || [];
    if (waiting.length) {
      warnings.push({
        type: 'deduction_pending',
        message: `${l.name}: ${plural(waiting.length, 'deduction')} waiting for approval (${fmtRs(sum(waiting, (d) => d.amount))}), not cut until approved.`,
        link: '/admin/hr/advances?tab=deductions&status=pending',
        linkLabel: 'Review deductions',
        employee: l.employee,
        employeeName: l.name,
      });
    }
  }
  return { period, lines, warnings, totals: totalsOf(lines) };
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

async function loadRun(id) {
  if (!isId(id)) throw httpError(404, 'Payroll run not found');
  const run = await PayrollRun.findById(id).lean();
  if (!run) throw httpError(404, 'Payroll run not found');
  return run;
}

const lastMonth = (now = new Date()) => T.addMonths(T.monthKey(now), -1);

async function listRuns(query = {}, { now = new Date() } = {}) {
  const { page, limit, skip } = paging(query, 24);
  const filter = {};
  if (query.month) filter.month = assertMonth(query.month);
  if (query.status && query.status !== 'all') {
    if (!PayrollRun.STATUSES.includes(query.status)) throw httpError(400, 'Unknown status');
    filter.status = query.status;
  }
  const suggestedMonth = lastMonth(now);
  const [total, rows, suggested] = await Promise.all([
    PayrollRun.countDocuments(filter),
    PayrollRun.find(filter)
      .select('runNo month monthLabel status totals warnings generatedAt approvedAt paidAt createdAt updatedAt')
      .sort({ month: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PayrollRun.findOne({ month: suggestedMonth }).select('_id status').lean(),
  ]);
  const data = rows.map(({ warnings, ...r }) => ({ ...r, warningCount: (warnings || []).filter((w) => w.level !== 'info').length }));
  return {
    data,
    meta: {
      ...pageMeta({ page, limit }, total),
      suggestedMonth,
      suggestedMonthLabel: T.monthLabel(suggestedMonth),
      suggestedRun: suggested ? { _id: suggested._id, status: suggested.status } : null,
      currentMonth: T.monthKey(now),
    },
  };
}

const getRun = (id) => loadRun(id);

/** POST {month}: a new draft, or the existing draft of that month. */
async function generateRun(monthInput, { userId, now = new Date() } = {}) {
  const month = assertMonth(monthInput);
  if (month > T.monthKey(now)) throw httpError(400, 'You can run payroll for this month or an earlier one, not a future month');
  const existing = await PayrollRun.findOne({ month }).lean();
  if (existing) {
    if (existing.status !== 'draft') {
      throw httpError(409, `${existing.monthLabel} payroll is already ${existing.status} (${existing.runNo}).`, 'RUN_EXISTS');
    }
    return { run: existing, existing: true };
  }
  const built = await buildMonth(month, { now });
  try {
    const run = await PayrollRun.create({
      runNo: await nextNumber('PAY'),
      month,
      monthLabel: built.period.label,
      from: built.period.from,
      to: built.period.to,
      daysInMonth: built.period.daysInMonth,
      status: 'draft',
      lines: built.lines,
      totals: built.totals,
      warnings: built.warnings,
      generatedAt: now,
      generatedBy: userId || null,
      createdBy: userId || null,
      history: [historyRow(userId, 'generated', `${plural(built.lines.length, 'employee')}`, now)],
    });
    return { run: run.toObject(), existing: false };
  } catch (err) {
    if (err && err.code === 11000) {
      const again = await PayrollRun.findOne({ month }).lean();
      if (again && again.status === 'draft') return { run: again, existing: true };
      throw httpError(409, `${T.monthLabel(month)} payroll already exists.`, 'RUN_EXISTS');
    }
    throw err;
  }
}

/** Conditional write on a draft (nobody changed it since we read it). */
async function saveDraft(run, update) {
  const saved = await PayrollRun.findOneAndUpdate({ _id: run._id, status: 'draft', updatedAt: run.updatedAt }, update, { new: true }).lean();
  if (!saved) throw httpError(409, 'This payroll was just changed by someone else. Refresh and try again.', 'RUN_CHANGED');
  return saved;
}

/** Rebuild a draft with today's attendance / deductions / advances, keeping manual inputs. */
async function regenerateRun(id, { userId, now = new Date() } = {}) {
  const run = await loadRun(id);
  if (run.status !== 'draft') throw httpError(409, 'Only a draft can be regenerated. Reopen it first.');
  const built = await buildMonth(run.month, { now, manual: manualFromRun(run) });
  return saveDraft(run, {
    $set: { lines: built.lines, totals: built.totals, warnings: built.warnings, generatedAt: now, generatedBy: userId || null },
    $push: { history: historyRow(userId, 'regenerated', `${plural(built.lines.length, 'employee')}`, now) },
  });
}

/** Manual inputs of one draft line → recompute that line + run totals. */
async function updateLine(id, lineId, body = {}, { userId, now = new Date() } = {}) {
  const run = await loadRun(id);
  if (run.status !== 'draft') throw httpError(409, 'Only a draft can be changed. Reopen it first.');
  const idx = run.lines.findIndex((l) => String(l._id) === String(lineId));
  if (idx < 0) throw httpError(404, 'Payroll line not found');
  const line = run.lines[idx];

  if (body.bonus !== undefined) line.bonus = rupees(body.bonus === null ? 0 : body.bonus, 'Bonus');
  if (body.bonusNote !== undefined) line.bonusNote = str(body.bonusNote, 200) || '';
  if (body.note !== undefined) line.note = str(body.note, 500) || '';
  if (body.advanceRecoveryOverride !== undefined) {
    line.advanceRecoveryOverride = rupees(body.advanceRecoveryOverride, 'Advance recovery', { allowNull: true });
  }
  if (body.adjustments !== undefined) {
    if (!Array.isArray(body.adjustments) || body.adjustments.length > 20) throw httpError(400, 'Adjustments must be a list (at most 20)');
    line.adjustments = body.adjustments.map((a, i) => {
      const label = str(a && a.label, 80);
      if (!label) throw httpError(400, `Adjustment ${i + 1}: write a label`);
      const amount = rupees(a.amount, `Adjustment "${label}"`, { allowNegative: true });
      if (!amount) throw httpError(400, `Adjustment "${label}": amount cannot be 0`);
      return { _id: isId(a._id) ? new ObjectId(String(a._id)) : new ObjectId(), label, amount, note: str(a.note, 200) || '' };
    });
  }
  finishLine(line);
  const lines = run.lines.map((l, i) => (i === idx ? line : l));
  return saveDraft(run, {
    $set: { [`lines.${idx}`]: line, totals: totalsOf(lines) },
    $push: { history: historyRow(userId, 'line_edited', line.name, now) },
  });
}

async function deleteRun(id, { userId } = {}) {
  const run = await loadRun(id);
  if (run.status !== 'draft') throw httpError(409, 'Only a draft can be deleted');
  const res = await PayrollRun.deleteOne({ _id: run._id, status: 'draft' });
  if (!res.deletedCount) throw httpError(409, 'This payroll was just changed. Refresh.');
  console.log(`[payroll] draft ${run.runNo} (${run.month}) deleted by ${userId}`);
  return { _id: run._id, deleted: true };
}

const plannedSnapshot = (plan) => ({
  type: plan.type,
  shift: plan.shiftId && isId(plan.shiftId) ? plan.shiftId : null,
  shiftName: plan.shiftName || '',
  start: plan.start || null,
  end: plan.end || null,
  breakMinutes: plan.breakMinutes || 0,
  leaveType: plan.leaveType || null,
  holidayName: plan.holidayName || '',
});

/** Lock every day of the month (days without a record get a locked placeholder, so no punch can slip in). */
async function lockAttendance(run, now) {
  const ids = run.lines.map((l) => l.employee);
  const range = { $gte: run.from, $lte: run.to };
  await AttendanceRecord.updateMany({ employee: { $in: ids }, date: range, locked: { $ne: true } }, { $set: { locked: true } });
  const have = new Set((await AttendanceRecord.find({ employee: { $in: ids }, date: range }).select('employee date').lean()).map((r) => `${r.employee}|${r.date}`));
  const emps = await Employee.find({ _id: { $in: ids } }).select(core.EMP_FIELDS).lean();
  const [plans, pols] = await Promise.all([schedule.planFor(emps, run.from, run.to), policies.policiesFor(emps)]);
  const ops = [];
  for (const e of emps) {
    for (const plan of plans.get(String(e._id)) || []) {
      if (plan.source === 'not_employed' || have.has(`${e._id}|${plan.date}`)) continue;
      const ev = core.evaluate(plan, null, pols.get(String(e._id)), now);
      ops.push({
        updateOne: {
          filter: { employee: e._id, date: plan.date },
          update: { $setOnInsert: { employee: e._id, date: plan.date, planned: plannedSnapshot(plan), ...ev, note: LOCK_NOTE }, $set: { locked: true } },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await AttendanceRecord.bulkWrite(ops, { ordered: false });
}

async function unlockAttendance(run) {
  const ids = run.lines.map((l) => l.employee);
  const range = { $gte: run.from, $lte: run.to };
  await AttendanceRecord.deleteMany({
    employee: { $in: ids },
    date: range,
    note: LOCK_NOTE,
    checkIn: null,
    'punches.0': { $exists: false },
    'corrections.0': { $exists: false },
  });
  await AttendanceRecord.updateMany({ employee: { $in: ids }, date: range, locked: true }, { $set: { locked: false } });
}

/** Approval side effects. Every step is safe to run twice (retry after a failure). */
async function applyEffects(run, { userId, now }) {
  await lockAttendance(run, now);

  for (const line of run.lines) {
    for (const d of line.deductionItems || []) {
      if (!(d.used > 0)) continue;
      const set = { status: 'applied', appliedMonth: run.month, appliedRun: run._id };
      if (d.used < rs(d.amount)) {
        // Part cut now: the rest becomes a new approved deduction for next month.
        try {
          await PayrollDeduction.create({
            employee: line.employee,
            type: d.type,
            amount: r2(d.amount - d.used),
            date: d.date,
            refType: 'PayrollDeduction',
            refId: d.deduction,
            refNo: d.refNo,
            note: `Rest of ${deductionLabel(d)} after ${fmtRs(d.used)} was cut in ${run.monthLabel}`,
            status: 'approved',
            decidedBy: userId || null,
            decidedAt: now,
            createdBy: userId || null,
          });
        } catch (err) {
          if (!err || err.code !== 11000) throw err;
        }
        Object.assign(set, { amount: d.used, note: `${d.note ? `${d.note} · ` : ''}${fmtRs(d.used)} of ${fmtRs(d.amount)} cut, rest carried`.slice(0, 1000) });
      }
      await PayrollDeduction.updateOne({ _id: d.deduction, status: 'approved' }, { $set: set });
    }

    for (const a of line.advanceItems || []) {
      if (!(a.used > 0)) continue;
      const res = await SalaryAdvance.findOneAndUpdate(
        { _id: a.advance, status: 'open', balance: { $gte: a.used }, 'recoveries.run': { $ne: run._id } },
        {
          $inc: { recovered: a.used, balance: -a.used },
          $push: {
            recoveries: { run: run._id, runNo: run.runNo, month: run.month, amount: a.used, at: now },
            history: historyRow(userId, 'recovered', `${fmtRs(a.used)} from ${run.runNo} (${run.monthLabel})`, now),
          },
        },
        { new: true }
      ).lean();
      if (res && res.balance <= 0) await SalaryAdvance.updateOne({ _id: res._id, status: 'open', balance: { $lte: 0 } }, { $set: { status: 'recovered', balance: 0 } });
    }
  }

  const set = { effectsDone: true };
  for (let i = 0; i < run.lines.length; i += 1) {
    if (!run.lines[i].payslipNo) set[`lines.${i}.payslipNo`] = await nextNumber('PSL');
  }
  return PayrollRun.findOneAndUpdate({ _id: run._id, status: 'approved' }, { $set: set }, { new: true }).lean();
}

async function reverseEffects(run, { userId, now }) {
  await unlockAttendance(run);
  for (const line of run.lines) {
    for (const d of line.deductionItems || []) {
      if (!(d.used > 0)) continue;
      await PayrollDeduction.updateOne(
        { _id: d.deduction, appliedRun: run._id },
        { $set: { status: 'approved', amount: d.amount, note: d.note || '', appliedMonth: '', appliedRun: null } }
      );
      await PayrollDeduction.deleteMany({ refType: 'PayrollDeduction', refId: d.deduction, status: { $ne: 'applied' } });
    }
    for (const a of line.advanceItems || []) {
      const adv = await SalaryAdvance.findOne({ _id: a.advance, 'recoveries.run': run._id }).lean();
      if (!adv) continue;
      const back = sum(adv.recoveries.filter((r) => String(r.run) === String(run._id)), (r) => r.amount);
      await SalaryAdvance.updateOne(
        { _id: adv._id, 'recoveries.run': run._id },
        {
          $inc: { recovered: -back, balance: back },
          $pull: { recoveries: { run: run._id } },
          $set: { status: 'open' },
          $push: { history: historyRow(userId, 'recovery_reversed', `${fmtRs(back)} back (${run.runNo} reopened)`, now) },
        }
      );
    }
  }
}

async function approveRun(id, { userId, now = new Date() } = {}) {
  const run = await loadRun(id);
  if (run.status === 'approved' && !run.effectsDone && !run.reopening) return applyEffects(run, { userId, now }); // finish an interrupted approval
  if (run.status !== 'draft') throw httpError(409, `This payroll is already ${run.status}`);
  if (T.dayKey(now) <= run.to) {
    throw httpError(409, `${run.monthLabel} is not over yet. You can approve it from ${dayLabel(T.addDays(run.to, 1))}.`, 'MONTH_NOT_OVER');
  }
  if (!run.lines.length) throw httpError(400, 'There is nobody on this payroll');

  // The manager approves exactly what they reviewed: refuse if anything moved since.
  const fresh = await buildMonth(run.month, { now, manual: manualFromRun(run) });
  if (runSignature(fresh.lines) !== runSignature(run.lines)) {
    throw httpError(
      409,
      'Attendance, advances or deductions changed after this draft was made. Press Regenerate, check the numbers, then approve.',
      'STALE_DRAFT'
    );
  }
  const claimed = await PayrollRun.findOneAndUpdate(
    { _id: run._id, status: 'draft', updatedAt: run.updatedAt },
    {
      $set: { status: 'approved', approvedAt: now, approvedBy: userId || null, effectsDone: false },
      $push: { history: historyRow(userId, 'approved', `Net ${fmtRs(run.totals.net)} for ${plural(run.lines.length, 'employee')}`, now) },
    },
    { new: true }
  ).lean();
  if (!claimed) throw httpError(409, 'This payroll was just changed by someone else. Refresh and try again.', 'RUN_CHANGED');
  return applyEffects(claimed, { userId, now });
}

/** Super admin: back to draft (only when nothing is paid and no later month is approved). */
async function reopenRun(id, { reason } = {}, { userId, now = new Date() } = {}) {
  const run = await loadRun(id);
  if (run.status === 'draft') throw httpError(409, 'This payroll is already a draft');
  if (run.status === 'paid' || (run.payments || []).length || run.lines.some((l) => l.status === 'paid')) {
    throw httpError(409, 'Salaries from this payroll are already paid, so it cannot be reopened.', 'RUN_PAID');
  }
  const later = await PayrollRun.findOne({ month: { $gt: run.month }, status: { $in: ['approved', 'paid'] } }).select('monthLabel').lean();
  if (later) throw httpError(409, `${later.monthLabel} payroll is approved after this one. Reopen ${later.monthLabel} first.`, 'LATER_RUN');

  const claimed = await PayrollRun.findOneAndUpdate(
    { _id: run._id, status: 'approved', 'payments.0': { $exists: false } },
    { $set: { reopening: true } },
    { new: true }
  ).lean();
  if (!claimed) throw httpError(409, 'This payroll was just changed by someone else. Refresh.', 'RUN_CHANGED');
  await reverseEffects(claimed, { userId, now });
  return PayrollRun.findOneAndUpdate(
    { _id: run._id },
    {
      $set: { status: 'draft', reopening: false, effectsDone: false, approvedAt: null, approvedBy: null },
      $push: { history: historyRow(userId, 'reopened', str(reason, 300) || '', now) },
    },
    { new: true }
  ).lean();
}

async function ensureSalariesCategory() {
  try {
    await ExpenseCategory.updateOne(
      { name: EXPENSE_CATEGORY },
      { $setOnInsert: { name: EXPENSE_CATEGORY, description: 'Staff salaries paid from payroll (posted automatically).', isActive: true } },
      { upsert: true }
    );
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
}

/**
 * Post the Expense of a payment batch (its id was chosen when the lines were marked paid).
 * Amount = salary earned = net paid + advance recovered. Advances are not expenses when
 * given (the employee owes it); till shortage / damage / other cuts covered a loss, so
 * they are not added back.
 */
async function postPaymentExpense(run, payment, branchId) {
  if (payment.expensePosted) return;
  const expenseAmount = payment.expenseAmount ?? payment.amount;
  if (payment.expense && expenseAmount > 0 && !(await Expense.exists({ _id: payment.expense }))) {
    await ensureSalariesCategory();
    const lineBy = new Map(run.lines.map((l) => [String(l._id), l]));
    const names = payment.lines.map((id) => (lineBy.get(String(id)) || {}).name).filter(Boolean);
    const split = `net ${fmtRs(payment.amount)} + advance recovered ${fmtRs(payment.advanceRecovered || 0)}`;
    try {
      await Expense.create({
        _id: payment.expense,
        title: `Salaries ${run.monthLabel} (${payment.count} staff)`,
        amount: expenseAmount,
        category: EXPENSE_CATEGORY,
        categories: [EXPENSE_CATEGORY],
        date: payment.date,
        paymentMethod: EXPENSE_METHOD[payment.method] || 'Other',
        reference: payment.reference || `${run.runNo}/${payment.no}`,
        notes: `${run.runNo} payment ${payment.no} by ${METHOD_LABEL[payment.method] || payment.method}: ${split}. Staff: ${names.join(', ')}`.slice(0, 1000),
        branch: branchId || null,
        source: 'payroll',
        sourceType: 'PayrollRun',
        sourceRef: run._id,
      });
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
  }
  await PayrollRun.updateOne({ _id: run._id, 'payments._id': payment._id }, { $set: { 'payments.$.expensePosted': true } });
}

/**
 * Mark lines paid (default: every unpaid line) and post ONE Expense for the batch.
 * Safe to retry: paid lines are never paid twice, an unfinished Expense is posted on the next call.
 */
async function payRun(id, body = {}, { userId, branchId, now = new Date() } = {}) {
  const how = method(body.method);
  const date = shopDate(body.date, 'Payment date', now);
  const reference = str(body.reference, 120) || '';
  const requestId = str(body.requestId, 80) || '';
  const wanted = Array.isArray(body.lineIds) && body.lineIds.length ? new Set(body.lineIds.map(String)) : null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await loadRun(id);
    if (run.status === 'draft') throw httpError(409, 'Approve the payroll before paying salaries.', 'NOT_APPROVED');
    if (run.reopening) throw httpError(409, 'This payroll is being reopened. Refresh.', 'RUN_CHANGED');
    if (run.status === 'approved' && !run.effectsDone) throw httpError(409, 'Approval did not finish. Press Approve again first.', 'APPROVAL_UNFINISHED');
    for (const p of run.payments || []) if (!p.expensePosted) await postPaymentExpense(run, p, branchId);

    const repeat = requestId && (run.payments || []).find((p) => p.requestId === requestId);
    if (repeat) return { run: await loadRun(id), payment: repeat, repeated: true };
    if (wanted) for (const lid of wanted) if (!run.lines.some((l) => String(l._id) === lid)) throw httpError(400, 'Unknown payroll line');
    const toPay = run.lines.filter((l) => l.status !== 'paid' && (!wanted || wanted.has(String(l._id))));
    if (!toPay.length) return { run, payment: null, repeated: true }; // already paid (e.g. a retried request)

    const amount = sum(toPay, (l) => l.net); // cash paid
    const advanceRecovered = sum(toPay, (l) => l.advanceRecovery);
    const expenseAmount = amount + advanceRecovered; // salary earned
    const payment = {
      _id: new ObjectId(),
      no: (run.payments || []).length + 1,
      date,
      method: how,
      reference,
      amount,
      advanceRecovered,
      expenseAmount,
      count: toPay.length,
      lines: toPay.map((l) => l._id),
      expense: expenseAmount > 0 ? new ObjectId() : null,
      expensePosted: expenseAmount <= 0,
      requestId,
      by: userId || null,
      at: now,
    };
    const paidIds = new Set(toPay.map((l) => String(l._id)));
    const after = run.lines.map((l) => (paidIds.has(String(l._id)) ? { ...l, status: 'paid' } : l));
    const set = { totals: totalsOf(after) };
    run.lines.forEach((l, i) => {
      if (!paidIds.has(String(l._id))) return;
      set[`lines.${i}.status`] = 'paid';
      set[`lines.${i}.paidAt`] = date;
      set[`lines.${i}.payment`] = payment._id;
    });
    if (after.every((l) => l.status === 'paid')) Object.assign(set, { status: 'paid', paidAt: now });
    const saved = await PayrollRun.findOneAndUpdate(
      { _id: run._id, rev: run.rev || 0, status: 'approved', reopening: { $ne: true } },
      {
        $set: set,
        $inc: { rev: 1 },
        $push: {
          payments: payment,
          history: historyRow(userId, 'paid', `${plural(toPay.length, 'employee')}, ${fmtRs(amount)} by ${METHOD_LABEL[how]}`, now),
        },
      },
      { new: true }
    ).lean();
    if (!saved) continue; // someone paid at the same moment: read again
    await postPaymentExpense(saved, payment, branchId);
    return { run: await loadRun(id), payment, repeated: false };
  }
  throw httpError(409, 'Payroll is busy right now. Try again.', 'RUN_BUSY');
}

/** Everything the payslip page prints. */
async function payslip(id, lineId) {
  const run = await loadRun(id);
  const line = run.lines.find((l) => String(l._id) === String(lineId));
  if (!line) throw httpError(404, 'Payroll line not found');
  const [e, settings] = await Promise.all([
    Employee.findById(line.employee)
      .select('firstName lastName employeeCode designation department cnic phone joiningDate hireDate salaryPaymentMethod bankDetails')
      .lean(),
    Settings.findOne({ isActive: true }).select('siteName address mobileNumber logoUrl').lean(),
  ]);
  const pay = line.payment ? (run.payments || []).find((p) => String(p._id) === String(line.payment)) : null;
  return {
    payslipNo: line.payslipNo || '',
    run: { _id: run._id, runNo: run.runNo, month: run.month, monthLabel: run.monthLabel, status: run.status, from: run.from, to: run.to, daysInMonth: run.daysInMonth },
    line,
    employee: {
      _id: line.employee,
      name: line.name,
      code: line.code,
      designation: line.designation,
      department: (e && e.department) || '',
      cnic: (e && e.cnic) || '',
      phone: (e && e.phone) || '',
      joiningDate: e ? e.joiningDate || e.hireDate || null : null,
      paymentMethod: (e && e.salaryPaymentMethod) || '',
      bank: (e && e.bankDetails) || {},
    },
    payment: pay ? { date: pay.date, method: pay.method, methodLabel: METHOD_LABEL[pay.method] || pay.method, reference: pay.reference } : null,
    letterhead: {
      shopName: (settings && settings.siteName) || 'DOLLAR & Co',
      shopAddress: (settings && settings.address) || '',
      shopPhone: (settings && settings.mobileNumber) || '',
      logoUrl: (settings && settings.logoUrl) || '',
    },
    netInWords: rupeesInWords(line.net),
  };
}

/** Payroll register (one row per employee). */
async function exportCsv(id) {
  const run = await loadRun(id);
  const amt = (rows, pred) => sum((rows || []).filter(pred), (r) => r.amount);
  const header = [
    'Code', 'Employee', 'Designation', 'Pay type', 'Day rate', 'Scheduled days', 'Days worked', 'Absent', 'Half days', 'Lates',
    'Late minutes', 'Unpaid leave days', 'Overtime hours paid', 'Basic / wage', 'Overtime', 'Bonus', 'Other additions', 'Gross',
    'Absent cut', 'Half day cut', 'Late cut', 'Leave cut', 'Off / holiday cut', 'Till shortage', 'Other deductions',
    'Advance recovery', 'Other minus', 'Total deductions', 'Net pay', 'Status', 'Paid on', 'Method', 'Reference', 'Note',
  ];
  const payBy = new Map((run.payments || []).map((p) => [String(p._id), p]));
  const rows = run.lines.map((l) => {
    const a = l.attendance || {};
    const tillKeys = new Set((l.deductionItems || []).filter((d) => d.type === 'till_shortage').map((d) => `ded_${d.deduction}`));
    const p = l.payment ? payBy.get(String(l.payment)) : null;
    return [
      l.code, l.name, l.designation, l.payType, l.dayRate, a.scheduledDaysInMonth, a.daysWorked, a.absentDays, a.halfDays, a.lateCount,
      a.lateMinutes, (a.leave && a.leave.unpaidTotal) || 0, r2((a.overtimeMinutesPaid || 0) / 60),
      amt(l.earnings, (r) => r.key === 'base' || r.key === 'days'), amt(l.earnings, (r) => r.key === 'overtime'),
      amt(l.earnings, (r) => r.key === 'bonus'), amt(l.earnings, (r) => r.key.startsWith('adj_')), l.gross,
      amt(l.deductions, (r) => r.key === 'absent'), amt(l.deductions, (r) => r.key === 'half_day'), amt(l.deductions, (r) => r.key === 'late'),
      amt(l.deductions, (r) => r.key === 'unpaid_leave'), amt(l.deductions, (r) => r.key === 'unpaid_off' || r.key === 'unpaid_holiday'),
      amt(l.deductions, (r) => tillKeys.has(r.key)), amt(l.deductions, (r) => r.key.startsWith('ded_') && !tillKeys.has(r.key)),
      amt(l.deductions, (r) => r.key.startsWith('adv_')), amt(l.deductions, (r) => r.key.startsWith('adj_')), l.totalDeductions, l.net,
      l.status === 'paid' ? 'Paid' : run.status === 'draft' ? 'Draft' : 'To pay',
      p ? T.dayKey(p.date) : '', p ? METHOD_LABEL[p.method] || p.method : '', p ? p.reference : '', l.note || '',
    ];
  });
  // Totals row: sum every money column.
  const moneyCols = ['Basic / wage', 'Overtime', 'Bonus', 'Other additions', 'Gross', 'Absent cut', 'Half day cut', 'Late cut', 'Leave cut',
    'Off / holiday cut', 'Till shortage', 'Other deductions', 'Advance recovery', 'Other minus', 'Total deductions', 'Net pay'];
  const total = header.map(() => '');
  total[1] = 'TOTAL';
  for (const col of moneyCols) {
    const i = header.indexOf(col);
    total[i] = sum(rows, (r) => r[i]);
  }
  rows.push(total);
  return { csv: toCsv(header, rows), filename: `payroll-${run.month}-${run.runNo}.csv` };
}

module.exports = {
  // advances
  createAdvance,
  listAdvances,
  getAdvance,
  cancelAdvance,
  employeeOptions,
  // deductions
  listDeductions,
  createDeduction,
  approveDeduction,
  waiveDeduction,
  recordTillShortage,
  // runs
  listRuns,
  getRun,
  generateRun,
  regenerateRun,
  updateLine,
  deleteRun,
  approveRun,
  reopenRun,
  payRun,
  payslip,
  exportCsv,
  // pure
  buildMonth,
  baseLine,
  finishLine,
  totalsOf,
  nextInstallment,
  LOCK_NOTE,
};
