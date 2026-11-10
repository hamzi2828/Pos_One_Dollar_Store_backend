// src/services/hr/portalService.js
// Employee Portal (read only): a staff login sees ONLY its own HR data.
// The employee is always found from the login (Employee.user = userId),
// never from an id sent by the browser. Routes: routes/modules/employeePortalRoutes.js.
//
//   profile(userId)            details, today, this month, last payslip, advance balance, tips
//   attendance(userId, month)  month summary + every day
//   payslips(userId)           approved / paid payslips, newest first
//   payslip(userId, runId)     own line of one approved / paid run
//   money(userId)              advances, deductions, tips, bonuses
const mongoose = require('mongoose');
const T = require('../analytics/time');
const Employee = require('../../models/employee');
const Shift = require('../../models/shift');
const AttendanceRecord = require('../../models/attendanceRecord');
const PayrollRun = require('../../models/payrollRun');
const SalaryAdvance = require('../../models/salaryAdvance');
const PayrollDeduction = require('../../models/payrollDeduction');
const StaffTip = require('../../models/staffTip');
const core = require('./attendanceCore');
const schedule = require('./scheduleService');
const policies = require('./policyService');
const payroll = require('./payrollService');
const { httpError, isId } = require('./util');

const NO_LINK = 'No employee record is linked to this login. Ask the shop admin.';
// Payslips are shown only once the owner approved the run.
const SHOWN_RUNS = ['approved', 'paid'];

const EXTRA_FIELDS = 'department phone email employmentType salaryPayDay salaryPaymentMethod bankDetails';

/** The login's own employee (404 when none is linked). */
async function employeeFor(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) throw httpError(404, NO_LINK, 'NO_EMPLOYEE');
  const e = await Employee.findOne({ user: userId, isDeleted: { $ne: true } })
    .select(`${core.EMP_FIELDS} ${EXTRA_FIELDS}`)
    .lean();
  if (!e) throw httpError(404, NO_LINK, 'NO_EMPLOYEE');
  return e;
}

/** '1234567890' -> '******7890' (only the last 4 shown). */
function mask(v) {
  const s = String(v || '').replace(/\s/g, '');
  if (!s) return null;
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

function monthOf(v, now) {
  const s = String(v || '').trim() || T.monthKey(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw httpError(400, 'Month must be YYYY-MM');
  return s;
}

const fullName = (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim();

/** monthSummary row -> the short numbers the portal shows. */
function shortSummary(month, s) {
  const x = s || {};
  const leave = x.leave || {};
  return {
    month,
    present: (x.presentDays || 0) + (x.offDaysWorked || 0),
    absent: x.absentDays || 0,
    late: x.lateCount || 0,
    halfDay: x.halfDays || 0,
    leave: (leave.paid || 0) + (leave.sick || 0) + (leave.unpaid || 0),
    off: (x.offDays || 0) + (x.holidayDays || 0),
    upcoming: x.upcomingDays || 0,
    workedMinutes: x.workedMinutes || 0,
    lateMinutes: x.lateMinutes || 0,
    overtimeMinutes: x.overtimeMinutesApproved || 0,
    overtimePendingMinutes: x.overtimeMinutesPending || 0,
  };
}

async function summaryOf(e, month, now) {
  const r = await core.monthSummary(month, { employeeIds: [e._id], now });
  return r.employees.find((x) => x.employeeId === String(e._id)) || null;
}

// Own payroll lines only: $elemMatch keeps other employees' lines out of the query result.
const ownRuns = (e, filter = {}) =>
  PayrollRun.find(
    { ...filter, status: { $in: SHOWN_RUNS }, 'lines.employee': e._id },
    { runNo: 1, month: 1, monthLabel: 1, status: 1, paidAt: 1, lines: { $elemMatch: { employee: e._id } } }
  )
    .sort({ month: -1 })
    .lean();

const payslipRow = (run) => {
  const l = run.lines[0];
  return {
    runId: String(run._id),
    runNo: run.runNo,
    month: run.month,
    monthLabel: run.monthLabel || T.monthLabel(run.month),
    runStatus: run.status,
    lineId: String(l._id),
    payslipNo: l.payslipNo || '',
    gross: l.gross || 0,
    totalDeductions: l.totalDeductions || 0,
    net: l.net || 0,
    bonus: l.bonus || 0,
    status: l.status, // pending | paid
    paidAt: l.paidAt || null,
  };
};

// ---------------------------------------------------------------- profile

async function profile(userId, { now = new Date() } = {}) {
  const e = await employeeFor(userId);
  const month = T.monthKey(now);
  const [shift, policy, s, view, lastRun, adv, tips] = await Promise.all([
    e.defaultShift ? Shift.findById(e.defaultShift).select('name').lean() : null,
    policies.policyFor(e),
    summaryOf(e, month, now),
    core.dayView({ dateKey: T.dayKey(now), employees: [e], now }),
    ownRuns(e).limit(1),
    SalaryAdvance.aggregate([{ $match: { employee: e._id, status: 'open' } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
    StaffTip.aggregate([
      { $match: { employee: e._id, isDeleted: { $ne: true }, day: { $regex: `^${month}` } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const b = e.salaryBreakdown || {};
  const bank = e.bankDetails || {};
  const legacyShift = e.shift && e.shift.start && e.shift.end ? `${e.shift.start} - ${e.shift.end}` : '';
  const q = policy.leave || {};
  const lv = (s && s.leave) || {};
  const paidAllowed = Number(q.paidPerMonth) || 0;
  const sickAllowed = Number(q.sickPerMonth) || 0;

  const row = view[0];
  const plan = row && row.plan;
  const today =
    plan && plan.source !== 'not_employed'
      ? {
          date: T.dayKey(now),
          status: row.eval.status,
          checkIn: (row.record && row.record.checkIn) || null,
          checkOut: (row.record && row.record.checkOut) || null,
          planned: { type: plan.type, shiftName: plan.shiftName || '', start: plan.start || null, end: plan.end || null },
        }
      : null;

  const last = lastRun[0] ? payslipRow(lastRun[0]) : null;

  return {
    employee: {
      _id: String(e._id),
      name: fullName(e),
      firstName: e.firstName || '',
      lastName: e.lastName || '',
      code: e.employeeCode || '',
      designation: e.designation || '',
      department: e.department || '',
      photo: e.photo || null,
      phone: e.phone || '',
      email: e.email || '',
      joiningDate: e.joiningDate || e.hireDate || null,
      employmentType: e.employmentType || 'permanent',
      payType: e.payType || 'monthly',
      salary: Number(e.salary) || 0,
      dailyRate: Number(e.dailyRate) || 0,
      salaryBreakdown: { basic: Number(b.basic) || 0, allowances: (b.allowances || []).map((a) => ({ name: a.name, amount: Number(a.amount) || 0 })) },
      salaryPayDay: e.salaryPayDay || 7,
      salaryPaymentMethod: e.salaryPaymentMethod || 'cash',
      bank: { accountTitle: bank.accountTitle || '', bankName: bank.bankName || '', accountNumber: mask(bank.accountNumber), iban: mask(bank.iban) },
      status: e.status || 'active',
      shiftName: (shift && shift.name) || legacyShift,
      weeklyOff: e.weeklyOff || [],
      leave: {
        month,
        paidPerMonth: paidAllowed,
        paidUsed: lv.paid || 0,
        paidLeft: Math.max(0, paidAllowed - (lv.paid || 0)),
        sickPerMonth: sickAllowed,
        sickUsed: lv.sick || 0,
        sickLeft: Math.max(0, sickAllowed - (lv.sick || 0)),
        unpaid: lv.unpaidTotal || 0,
      },
    },
    today,
    thisMonth: shortSummary(month, s),
    lastPayslip: last ? { runId: last.runId, lineId: last.lineId, month: last.month, monthLabel: last.monthLabel, net: last.net, status: last.status, paidAt: last.paidAt } : null,
    openAdvanceBalance: (adv[0] && adv[0].total) || 0,
    tipsThisMonth: (tips[0] && tips[0].total) || 0,
  };
}

// ---------------------------------------------------------------- attendance

async function attendance(userId, month, { now = new Date() } = {}) {
  const e = await employeeFor(userId);
  const m = monthOf(month, now);
  const from = `${m}-01`;
  const to = `${m}-${String(T.daysInMonth(m)).padStart(2, '0')}`;
  const today = T.dayKey(now);
  const [s, plans, recs, policy] = await Promise.all([
    summaryOf(e, m, now),
    schedule.planFor([e], from, to),
    AttendanceRecord.find({ employee: e._id, date: { $gte: from, $lte: to } }).lean(),
    policies.policyFor(e),
  ]);
  const recBy = new Map(recs.map((r) => [r.date, r]));

  const days = (plans.get(String(e._id)) || []).map((plan) => {
    const record = recBy.get(plan.date) || null;
    const planned = {
      type: plan.type,
      shiftName: plan.shiftName || '',
      start: plan.start || null,
      end: plan.end || null,
      leaveType: plan.leaveType || null,
      holidayName: plan.holidayName || '',
    };
    const blank = { lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, overtimeApproved: null, lateExcused: false };
    if (plan.source === 'not_employed') return { date: plan.date, status: 'not_employed', planned, checkIn: null, checkOut: null, ...blank };
    const ev = core.evaluate(plan, record, policy, now);
    // Same rule as monthSummary: future days are "upcoming".
    const status = plan.date > today ? 'upcoming' : ev.status;
    return {
      date: plan.date,
      status,
      planned,
      checkIn: (record && record.checkIn) || null,
      checkOut: (record && record.checkOut) || null,
      workedMinutes: ev.workedMinutes || 0,
      lateMinutes: ev.lateMinutes || 0,
      earlyLeaveMinutes: ev.earlyLeaveMinutes || 0,
      overtimeMinutes: ev.overtimeMinutes || 0,
      overtimeApproved: ev.overtimeApproved,
      lateExcused: core.lateExcusedOf(record, ev),
    };
  });

  return { month: m, summary: shortSummary(m, s), days };
}

// ---------------------------------------------------------------- payslips

async function payslips(userId) {
  const e = await employeeFor(userId);
  const runs = await ownRuns(e);
  return { payslips: runs.filter((r) => r.lines && r.lines[0]).map(payslipRow) };
}

async function payslip(userId, runId) {
  const e = await employeeFor(userId);
  if (!isId(runId)) throw httpError(404, 'Payslip not found');
  const [run] = await ownRuns(e, { _id: new mongoose.Types.ObjectId(String(runId)) });
  if (!run || !run.lines || !run.lines[0]) throw httpError(404, 'Payslip not found');
  const full = await payroll.payslip(run._id, run.lines[0]._id);
  const l = full.line;
  // Own line only; it is the same line we found above.
  if (String(l.employee) !== String(e._id)) throw httpError(404, 'Payslip not found');
  const emp = full.employee || {};
  const bank = emp.bank || {};
  return {
    runId: String(run._id),
    runNo: run.runNo,
    month: run.month,
    monthLabel: run.monthLabel || T.monthLabel(run.month),
    runStatus: run.status,
    line: {
      lineId: String(l._id),
      payslipNo: l.payslipNo || '',
      payType: l.payType,
      salary: l.salary || 0,
      dailyRate: l.dailyRate || 0,
      dayRate: l.dayRate || 0,
      earnings: l.earnings || [],
      deductions: l.deductions || [],
      gross: l.gross || 0,
      totalDeductions: l.totalDeductions || 0,
      net: l.net || 0,
      shortfall: l.shortfall || 0,
      bonus: l.bonus || 0,
      bonusNote: l.bonusNote || '',
      adjustments: (l.adjustments || []).map((a) => ({ label: a.label, amount: a.amount, note: a.note || '' })),
      advanceRecovery: l.advanceRecovery || 0,
      attendance: l.attendance || {},
      employedDays: l.employedDays || 0,
      joinedOn: l.joinedOn || '',
      leftOn: l.leftOn || '',
      notes: l.notes || [],
      status: l.status,
      paidAt: l.paidAt || null,
    },
    employee: {
      name: emp.name || fullName(e),
      code: emp.code || '',
      designation: emp.designation || '',
      department: emp.department || '',
      joiningDate: emp.joiningDate || null,
      paymentMethod: emp.paymentMethod || '',
      bank: { accountTitle: bank.accountTitle || '', bankName: bank.bankName || '', accountNumber: mask(bank.accountNumber), iban: mask(bank.iban) },
    },
    payment: full.payment,
    letterhead: full.letterhead,
    netInWords: full.netInWords,
  };
}

// ---------------------------------------------------------------- money

async function money(userId) {
  const e = await employeeFor(userId);
  const [advances, deductions, tips, runs] = await Promise.all([
    SalaryAdvance.find({ employee: e._id, status: { $ne: 'cancelled' } }).sort({ date: -1, _id: -1 }).lean(),
    PayrollDeduction.find({ employee: e._id, status: { $ne: 'waived' } }).sort({ date: -1, _id: -1 }).lean(),
    StaffTip.find({ employee: e._id, isDeleted: { $ne: true } }).sort({ date: -1, _id: -1 }).lean(),
    ownRuns(e),
  ]);
  return {
    advances: advances.map((a) => ({
      advanceNo: a.advanceNo,
      date: a.date,
      amount: a.amount,
      installments: a.installments || 1,
      recovered: a.recovered || 0,
      balance: a.balance || 0,
      status: a.status,
      note: a.note || '',
    })),
    deductions: deductions.map((d) => ({
      type: d.type,
      amount: d.amount,
      date: d.date,
      status: d.status,
      note: d.note || '',
      appliedMonth: d.appliedMonth || '',
    })),
    tips: tips.map((t) => ({ tipNo: t.tipNo, day: t.day, amount: t.amount, method: t.method, note: t.note || '' })),
    bonuses: runs
      .map((r) => r.lines && r.lines[0] && { month: r.month, monthLabel: r.monthLabel || T.monthLabel(r.month), runNo: r.runNo, amount: r.lines[0].bonus || 0, note: r.lines[0].bonusNote || '' })
      .filter((b) => b && b.amount > 0),
  };
}

module.exports = { profile, attendance, payslips, payslip, money, employeeFor, mask, NO_LINK };
