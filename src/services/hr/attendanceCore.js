// src/services/hr/attendanceCore.js
// The attendance rules engine. The ONLY code that decides present / late /
// half day / absent / overtime, always with the employee's HR policy
// (services/hr/policyService.js) and plan (services/hr/scheduleService.js).
//
//   evaluate(plan, record, policy, now)          pure: computed fields for one day
//   punch({ employeeId, at, source, photo, userId, note })
//                                                 clock in / out (kiosk, manual, device)
//   recomputeDay(employeeId, dateKey)             after a roster / policy / correction change
//   recomputeRange(employeeIds, fromKey, toKey)   same, for many days
//   dayView({ dateKey, employees })               the "who's in" board (no writes)
//   monthSummary(month, { employeeIds, includeDays, now })
//                                                 what payroll needs, policy applied
//
// Days without a record are still evaluated from the plan (a scheduled day with
// no punch is ABSENT once its shift is over).
const mongoose = require('mongoose');
const T = require('../analytics/time');
const Employee = require('../../models/employee');
const AttendanceRecord = require('../../models/attendanceRecord');
const schedule = require('./scheduleService');
const policies = require('./policyService');

const MIN = 60 * 1000;
const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / MIN);
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// After the shift ends, how long a check-out is still expected before the day
// becomes "missing out" (covers overtime).
const OUT_WINDOW_MIN = (policy) => Math.max(60, (policy.overtime && policy.overtime.maxMinutesPerDay) || 0) + 60;

/**
 * Computed fields for one shop day.
 * @param plan   scheduleService plan for that day
 * @param record AttendanceRecord (plain) or null
 * @returns { status, lateMinutes, earlyLeaveMinutes, workedMinutes, overtimeMinutes, overtimeApproved }
 */
function evaluate(plan, record, policy, now = new Date()) {
  const a = policy.attendance || {};
  const ot = policy.overtime || {};
  const r = record || {};
  const checkIn = r.checkIn ? new Date(r.checkIn) : null;
  const checkOut = r.checkOut ? new Date(r.checkOut) : null;
  const out = { status: 'pending', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, overtimeApproved: null };

  const worked = () => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
    const span = minutesBetween(checkIn, checkOut);
    const brk = plan.type === 'shift' ? Number(plan.breakMinutes) || 0 : 0;
    return Math.max(0, span > brk * 2 ? span - brk : span);
  };
  const capOvertime = (raw) => {
    if (!ot.enabled || raw < (Number(ot.minMinutes) || 0)) return 0;
    const max = Number(ot.maxMinutesPerDay) || 0;
    return max > 0 ? Math.min(raw, max) : raw;
  };
  const approval = (minutes) => {
    if (!minutes) return null;
    if (!ot.needsApproval) return true;
    return typeof r.overtimeApproved === 'boolean' ? r.overtimeApproved : null;
  };

  // Not a working day (off / holiday / leave / no schedule).
  if (plan.type !== 'shift') {
    if (checkIn) {
      // No shift end to measure against: still "in" for up to 16 h after the check-in.
      const stillIn = !checkOut && now < new Date(checkIn.getTime() + 16 * 60 * MIN);
      out.status = checkOut || stillIn ? 'present' : 'missing_out';
      out.workedMinutes = worked();
      // Working on an off day / holiday is all extra time (not on leave or unscheduled days).
      if (plan.type === 'off' || plan.type === 'holiday') out.overtimeMinutes = capOvertime(out.workedMinutes);
      out.overtimeApproved = approval(out.overtimeMinutes);
      return out;
    }
    out.status = plan.type === 'none' ? 'off' : plan.type; // off | holiday | leave
    return out;
  }

  const start = new Date(plan.start);
  const end = new Date(plan.end);
  if (!checkIn) {
    out.status = now < end ? 'pending' : 'absent';
    return out;
  }

  const late = Math.max(0, minutesBetween(start, checkIn));
  out.lateMinutes = late > (Number(a.graceMinutes) || 0) ? late : 0;

  if (!checkOut) {
    const stillOpen = now < new Date(end.getTime() + OUT_WINDOW_MIN(policy) * MIN);
    out.status = stillOpen ? (out.lateMinutes ? 'late' : 'present') : 'missing_out';
    return out;
  }

  out.workedMinutes = worked();
  const early = Math.max(0, minutesBetween(checkOut, end));
  out.earlyLeaveMinutes = early > (Number(a.earlyLeaveGraceMinutes) || 0) ? early : 0;
  out.overtimeMinutes = capOvertime(Math.max(0, minutesBetween(end, checkOut)));
  out.overtimeApproved = approval(out.overtimeMinutes);

  const hd = a.halfDay || {};
  const planned = Number(plan.workMinutes) || minutesBetween(start, end);
  const tooLate = hd.enabled && out.lateMinutes > (Number(hd.lateAfterMinutes) || Infinity);
  const tooShort = hd.enabled && planned > 0 && out.workedMinutes < (planned * (Number(hd.minWorkedPct) || 0)) / 100;
  out.status = tooLate || tooShort ? 'half_day' : out.lateMinutes ? 'late' : 'present';
  return out;
}

const plannedSnapshot = (plan) => ({
  type: plan.type,
  shift: plan.shiftId && mongoose.Types.ObjectId.isValid(plan.shiftId) ? plan.shiftId : null,
  shiftName: plan.shiftName || '',
  start: plan.start || null,
  end: plan.end || null,
  breakMinutes: plan.breakMinutes || 0,
  leaveType: plan.leaveType || null,
  holidayName: plan.holidayName || '',
});

const EMP_FIELDS = 'firstName lastName employeeCode designation photo status isActive defaultShift weeklyOff shift joiningDate hireDate exitDate hrPolicy payType dailyRate salary salaryBreakdown user isDeleted';

async function loadEmployee(employeeId) {
  if (!mongoose.Types.ObjectId.isValid(String(employeeId))) throw httpError(400, 'Invalid employee');
  const e = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } }).select(EMP_FIELDS).lean();
  if (!e) throw httpError(404, 'Employee not found');
  return e;
}

/** Re-evaluate one saved day (no-op when there is no record). Returns the record or null. */
async function recomputeDay(employeeId, dateKey, { now = new Date() } = {}) {
  const rec = await AttendanceRecord.findOne({ employee: employeeId, date: dateKey });
  if (!rec || rec.locked) return rec ? rec.toObject() : null;
  const employee = await loadEmployee(employeeId);
  const [plan, policy] = await Promise.all([schedule.planForDay(employee, dateKey), policies.policyFor(employee)]);
  Object.assign(rec, { planned: plannedSnapshot(plan) }, evaluate(plan, rec.toObject(), policy, now));
  await rec.save();
  return rec.toObject();
}

/**
 * Re-evaluate saved days of many employees (after a roster / policy / holiday
 * change) in ONE pass: plans and policies are loaded once, results written with
 * bulkWrite (fast enough for a whole month of the whole shop on serverless).
 */
async function recomputeRange(employeeIds, fromKey, toKey, { now = new Date() } = {}) {
  const match = { date: { $gte: fromKey, $lte: toKey }, locked: { $ne: true } };
  if (employeeIds && employeeIds.length) match.employee = { $in: employeeIds };
  const recs = await AttendanceRecord.find(match).lean();
  if (!recs.length) return 0;
  const ids = [...new Set(recs.map((r) => String(r.employee)))];
  const emps = await Employee.find({ _id: { $in: ids } }).select(EMP_FIELDS).lean();
  const [plans, pols] = await Promise.all([schedule.planFor(emps, fromKey, toKey), policies.policiesFor(emps)]);
  const ops = [];
  for (const r of recs) {
    const id = String(r.employee);
    const plan = (plans.get(id) || []).find((p) => p.date === r.date);
    const policy = pols.get(id);
    if (!plan || !policy) continue;
    ops.push({
      updateOne: {
        filter: { _id: r._id, locked: { $ne: true } },
        update: { $set: { planned: plannedSnapshot(plan), ...evaluate(plan, r, policy, now) } },
      },
    });
  }
  for (let i = 0; i < ops.length; i += 500) await AttendanceRecord.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  return ops.length;
}

/**
 * Which shop day a punch belongs to when yesterday's shift runs past midnight:
 *   - still open (checked in, not out): the punch is yesterday's check-out,
 *     up to 6 h after the shift ends;
 *   - not checked in yet and the shift is still running: a (late) check-in
 *     for yesterday's shift.
 * Otherwise the punch belongs to today.
 */
async function shopDayFor(employee, at) {
  const today = T.dayKey(at);
  const yesterday = T.addDays(today, -1);
  const [yPlan, yRec] = await Promise.all([
    schedule.planForDay(employee, yesterday),
    AttendanceRecord.findOne({ employee: employee._id, date: yesterday }).select('checkIn checkOut').lean(),
  ]);
  const crossesMidnight = yPlan.type === 'shift' && yPlan.end && new Date(yPlan.end) > T.dayStart(today);
  if (!crossesMidnight) return today;
  const end = new Date(yPlan.end);
  const open = yRec && yRec.checkIn && !yRec.checkOut;
  if (open && at <= new Date(end.getTime() + 6 * 60 * MIN)) return yesterday;
  if (!(yRec && yRec.checkIn) && at < end) return yesterday;
  return today;
}

const DOUBLE_PUNCH_MS = 60 * 1000;

/**
 * Clock in or out. First punch of the day = in, later punches = out (the last
 * one counts). A second punch within 60 s is ignored (double tap).
 * @returns { record, kind: 'in'|'out', duplicate, date, plan }
 */
async function punch({ employeeId, at = new Date(), source = 'kiosk', photo = null, userId = null, note = '' }) {
  const employee = await loadEmployee(employeeId);
  if (!employee.isActive) throw httpError(400, 'This employee is not active');
  const when = new Date(at);
  const date = await shopDayFor(employee, when);
  const [plan, policy] = await Promise.all([schedule.planForDay(employee, date), policies.policyFor(employee)]);

  const rec = await AttendanceRecord.findOneAndUpdate(
    { employee: employee._id, date },
    { $setOnInsert: { employee: employee._id, date, planned: plannedSnapshot(plan) } },
    { upsert: true, new: true }
  );
  if (rec.locked) throw httpError(409, 'This day is locked by an approved payroll', 'ATTENDANCE_LOCKED');

  const last = rec.punches.length ? rec.punches[rec.punches.length - 1] : null;
  if (last && Math.abs(when - new Date(last.at)) < DOUBLE_PUNCH_MS) {
    return { record: rec.toObject(), kind: last.kind, duplicate: true, date, plan };
  }

  const kind = rec.checkIn ? 'out' : 'in';
  rec.punches.push({ at: when, kind, source, photo, by: userId || null, note });
  if (kind === 'in') rec.checkIn = when;
  else rec.checkOut = when;
  Object.assign(rec, { planned: plannedSnapshot(plan) }, evaluate(plan, rec.toObject(), policy, new Date()));
  await rec.save();
  return { record: rec.toObject(), kind, duplicate: false, date, plan };
}

/**
 * The board for one shop day: every active employee with plan, record and status.
 * @returns [{ employee, plan, record, eval }]
 */
async function dayView({ dateKey = T.dayKey(new Date()), employees = null, now = new Date() } = {}) {
  const list =
    employees ||
    (await Employee.find({
      isDeleted: { $ne: true },
      // Current staff; old rows saved before `status` existed count when isActive.
      $or: [{ status: { $in: ['active', 'on_leave'] } }, { status: { $exists: false }, isActive: { $ne: false } }],
    })
      .select(EMP_FIELDS)
      .sort({ firstName: 1 })
      .lean());
  const [plans, recs, pols] = await Promise.all([
    schedule.planFor(list, dateKey, dateKey),
    AttendanceRecord.find({ employee: { $in: list.map((e) => e._id) }, date: dateKey }).lean(),
    policies.policiesFor(list),
  ]);
  const recBy = new Map(recs.map((r) => [String(r.employee), r]));
  return list.map((e) => {
    const plan = (plans.get(String(e._id)) || [])[0];
    const record = recBy.get(String(e._id)) || null;
    return { employee: e, plan, record, eval: evaluate(plan, record, pols.get(String(e._id)), now) };
  });
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Month totals per employee with the policy applied — what payroll reads.
 * Future days of the current month are "upcoming" (not absent).
 * @param month 'YYYY-MM'
 * @returns { month, from, to, daysInMonth, employees: [summary] }
 */
async function monthSummary(month, { employeeIds = null, includeDays = false, now = new Date() } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw httpError(400, 'Month must be YYYY-MM');
  const from = `${month}-01`;
  const daysInMonth = T.daysInMonth(month);
  const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const today = T.dayKey(now);

  const match = { isDeleted: { $ne: true } };
  if (employeeIds && employeeIds.length) match._id = { $in: employeeIds };
  const list = await Employee.find(match).select(EMP_FIELDS).sort({ firstName: 1 }).lean();
  const [plans, recs, pols] = await Promise.all([
    schedule.planFor(list, from, to),
    AttendanceRecord.find({ employee: { $in: list.map((e) => e._id) }, date: { $gte: from, $lte: to } }).lean(),
    policies.policiesFor(list),
  ]);
  const recBy = new Map(recs.map((r) => [`${r.employee}|${r.date}`, r]));

  const employees = list.map((e) => {
    const id = String(e._id);
    const policy = pols.get(id);
    const a = policy.attendance || {};
    const pay = policy.pay || {};
    const s = {
      employeeId: id,
      name: `${e.firstName || ''} ${e.lastName || ''}`.trim(),
      code: e.employeeCode || '',
      designation: e.designation || '',
      payType: e.payType || 'monthly',
      dailyRate: Number(e.dailyRate) || 0,
      salary: Number(e.salary) || 0,
      policyId: String(policy._id),
      policyName: policy.name,
      scheduledDaysInMonth: 0, // whole month (for the "working days" divisor)
      scheduledDays: 0, // up to today
      presentDays: 0,
      lateCount: 0,
      lateMinutes: 0,
      halfDays: 0,
      absentDays: 0,
      missingOutDays: 0,
      earlyLeaveCount: 0,
      earlyLeaveMinutes: 0,
      offDays: 0,
      holidayDays: 0,
      offDaysWorked: 0,
      leave: { paid: 0, sick: 0, unpaid: 0 },
      workedMinutes: 0,
      overtimeMinutesApproved: 0,
      overtimeMinutesPending: 0,
      upcomingDays: 0,
      notEmployedDays: 0,
      pendingCorrections: 0, // missing-out days still open for a fix
      days: includeDays ? [] : undefined,
    };

    for (const plan of plans.get(id) || []) {
      if (plan.source === 'not_employed') {
        s.notEmployedDays += 1;
        if (includeDays) s.days.push({ date: plan.date, status: 'not_employed' });
        continue;
      }
      if (plan.type === 'shift') s.scheduledDaysInMonth += 1;
      const record = recBy.get(`${id}|${plan.date}`) || null;
      const ev = evaluate(plan, record, policy, now);
      if (plan.date > today || ev.status === 'pending') {
        s.upcomingDays += 1;
        if (includeDays) s.days.push({ date: plan.date, status: 'upcoming', planned: plan.type, shiftName: plan.shiftName });
        continue;
      }
      if (plan.type === 'shift') s.scheduledDays += 1;

      let status = ev.status;
      if (status === 'missing_out') {
        s.missingOutDays += 1;
        s.pendingCorrections += 1;
        const as = a.missingOutCountsAs || 'present';
        status = as === 'half_day' ? 'half_day' : as === 'absent' ? 'absent' : ev.lateMinutes ? 'late' : 'present';
      }
      switch (status) {
        case 'present':
        case 'late':
          if (plan.type === 'shift') s.presentDays += 1;
          else if (plan.type === 'off' || plan.type === 'holiday') s.offDaysWorked += 1;
          else s.presentDays += 1; // leave / unscheduled day actually worked
          break;
        case 'half_day':
          s.halfDays += 1;
          break;
        case 'absent':
          s.absentDays += 1;
          break;
        case 'off':
          s.offDays += 1;
          break;
        case 'holiday':
          s.holidayDays += 1;
          break;
        case 'leave':
          s.leave[plan.leaveType === 'sick' ? 'sick' : plan.leaveType === 'unpaid' ? 'unpaid' : 'paid'] += 1;
          break;
        default:
          break;
      }
      if (ev.lateMinutes > 0) {
        s.lateCount += 1;
        s.lateMinutes += ev.lateMinutes;
      }
      if (ev.earlyLeaveMinutes > 0) {
        s.earlyLeaveCount += 1;
        s.earlyLeaveMinutes += ev.earlyLeaveMinutes;
      }
      s.workedMinutes += ev.workedMinutes;
      if (ev.overtimeMinutes > 0) {
        if (ev.overtimeApproved === true) s.overtimeMinutesApproved += ev.overtimeMinutes;
        else if (ev.overtimeApproved === null) s.overtimeMinutesPending += ev.overtimeMinutes;
      }
      if (includeDays) {
        s.days.push({
          date: plan.date,
          status: ev.status,
          planned: plan.type,
          shiftName: plan.shiftName,
          leaveType: plan.leaveType,
          holidayName: plan.holidayName,
          checkIn: record ? record.checkIn : null,
          checkOut: record ? record.checkOut : null,
          lateMinutes: ev.lateMinutes,
          earlyLeaveMinutes: ev.earlyLeaveMinutes,
          workedMinutes: ev.workedMinutes,
          overtimeMinutes: ev.overtimeMinutes,
          overtimeApproved: ev.overtimeApproved,
        });
      }
    }

    // Leave quotas: beyond the policy's paid / sick days per month = unpaid.
    const q = policy.leave || {};
    const extraPaid = Math.max(0, s.leave.paid - (Number(q.paidPerMonth) || 0));
    const extraSick = Math.max(0, s.leave.sick - (Number(q.sickPerMonth) || 0));
    s.leave.paidWithinQuota = s.leave.paid - extraPaid;
    s.leave.sickWithinQuota = s.leave.sick - extraSick;
    s.leave.unpaidTotal = s.leave.unpaid + extraPaid + extraSick;

    // Cuts in DAYS (payroll turns them into money with the day rate).
    const lr = a.lateRule || {};
    const lateUnits = s.lateCount + (a.earlyLeaveCountsAsLate ? s.earlyLeaveCount : 0);
    s.cuts = {
      lateUnits,
      lateRule: lr.type || 'count',
      lateCutDays: lr.type === 'count' ? Math.floor(lateUnits / (Number(lr.latesPerCut) || 3)) * (Number(lr.cutDays) || 0) : 0,
      lateCutMinutes: lr.type === 'minutes' ? s.lateMinutes + (a.earlyLeaveCountsAsLate ? s.earlyLeaveMinutes : 0) : 0,
      absentCutDays: r2(s.absentDays * (Number(pay.absentCutDays) || 0)),
      halfDayCutDays: r2(s.halfDays * (Number(pay.halfDayCut) || 0)),
      unpaidLeaveCutDays: s.leave.unpaidTotal,
    };
    // Days actually worked (daily-wage pay basis).
    s.daysWorked = r2(s.presentDays + s.offDaysWorked + s.halfDays * (1 - (Number(pay.halfDayCut) || 0)));
    return s;
  });

  return { month, from, to, daysInMonth, employees };
}

module.exports = { evaluate, punch, recomputeDay, recomputeRange, dayView, monthSummary, shopDayFor, loadEmployee, EMP_FIELDS };
