// src/services/hr/attendanceService.js
// Attendance screens: the "who's in" board, saved days, corrections, overtime
// approval, the month sheet and the "fix before payroll" list.
//
// Staff punch ONLY with their fingerprint on the DOLLAR & Co Attendance
// desktop app (punches arrive through attendanceCore.punch with source
// 'device'). The only web change is a manager correction with a reason.
// Every status / late / overtime decision comes from attendanceCore (the rules
// engine with the employee's HR policy). This file only reads, validates,
// writes corrected times and asks the core to re-evaluate.
const mongoose = require('mongoose');
const T = require('../analytics/time');
const core = require('./attendanceCore');
const schedule = require('./scheduleService');
const policies = require('./policyService');
const Employee = require('../../models/employee');
const AttendanceRecord = require('../../models/attendanceRecord');
const RosterEntry = require('../../models/rosterEntry');
const Holiday = require('../../models/holiday');
const Shift = require('../../models/shift');
const User = require('../../models/user');
const { httpError, isId, paging, pageMeta } = require('./util');

const MIN_MS = 60 * 1000;
const CORRECTION_WINDOW_MIN = 12 * 60; // corrected times must be within ±12 h of the planned shift

// Employees who still work here (old rows may have only isActive).
const ACTIVE_OR = [
  { status: { $in: Employee.ACTIVE_STATUSES } },
  { status: { $exists: false }, isActive: { $ne: false } },
];

// ---------------------------------------------------------------- formatting

const fullName = (e) => `${(e && e.firstName) || ''} ${(e && e.lastName) || ''}`.trim();

/** "9:58 am" in shop time. */
function clock(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + T.OFFSET_MS);
  const h = t.getUTCHours();
  return `${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

/** 24 -> "24 min", 455 -> "7 h 35 m", 60 -> "1 h". */
function duration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  if (!h) return `${m} min`;
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
}

const userNameOf = async (userId) => {
  if (!isId(userId)) return '';
  const u = await User.findById(userId).select('firstName lastName email').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '' : '';
};

/** Day key or 400. */
function dayKeyOf(v, label = 'date') {
  const s = String(v || '').trim();
  if (!T.isDayKey(s)) throw httpError(400, `Invalid ${label} (use YYYY-MM-DD)`);
  return s;
}

function monthOf(v) {
  const s = String(v || '').trim() || T.monthKey(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw httpError(400, 'Month must be YYYY-MM');
  return s;
}

// ---------------------------------------------------------------- board

const planOut = (plan) => ({
  type: plan.type,
  source: plan.source,
  shiftName: plan.shiftName || '',
  shiftCode: plan.shiftCode || '',
  color: plan.color || '',
  start: plan.start || null,
  end: plan.end || null,
  breakMinutes: plan.breakMinutes || 0,
  leaveType: plan.leaveType || null,
  holidayName: plan.holidayName || '',
});

const employeeOut = (e) => ({
  _id: String(e._id),
  name: fullName(e),
  code: e.employeeCode || '',
  designation: e.designation || '',
  photo: e.photo || null,
});

const punchOut = (p) => ({ at: p.at, kind: p.kind, source: p.source, photo: p.photo || null, note: p.note || '' });

/**
 * Payroll approval writes LOCKED placeholder records ("Payroll lock") on days
 * that had none, so nothing can be punched in a paid month. They carry no
 * times: show the day's normal status (absent / off ...) with a lock.
 */
const isPlaceholder = (r) => !!(r && r.locked && !r.checkIn && !r.checkOut && !(r.punches || []).length);
const PLACEHOLDER_FILTER = { $nor: [{ locked: true, checkIn: null, checkOut: null, punches: { $size: 0 } }] };

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/**
 * Where a check-in / check-out time came from: 'device' (fingerprint),
 * 'corrected' (a manager's correction) or the old 'kiosk' / 'manual' punches.
 */
function sourceOf(record, field) {
  const value = record && record[field];
  if (!value) return null;
  const fixes = (record.corrections || []).filter((c) => c.field === field);
  const fix = fixes[fixes.length - 1];
  if (fix && sameTime(fix.to, value)) return 'corrected';
  const punch = (record.punches || []).filter((p) => sameTime(p.at, value)).pop();
  if (punch) return punch.source || 'device';
  return fixes.length ? 'corrected' : null;
}

/** "Corrected by X: reason" for the latest time correction of the day. */
function lastTimeCorrection(record) {
  const fix = ((record && record.corrections) || []).filter((c) => c.field === 'checkIn' || c.field === 'checkOut').pop();
  return fix ? { at: fix.at, byName: fix.byName || '', reason: fix.reason, field: fix.field } : null;
}

/** Shared by the board, records and day detail. */
function dayFields(r) {
  return {
    inSource: sourceOf(r, 'checkIn'),
    outSource: sourceOf(r, 'checkOut'),
    lastCorrection: lastTimeCorrection(r),
  };
}

function boardRow({ employee, plan, record, eval: ev }) {
  const r = record || {};
  const punches = (r.punches || []).map(punchOut);
  return {
    employee: employeeOut(employee),
    plan: planOut(plan),
    recordId: record ? String(record._id) : null,
    checkIn: r.checkIn || null,
    checkOut: r.checkOut || null,
    ...dayFields(r),
    inNow: !!(r.checkIn && !r.checkOut && ev.status !== 'missing_out'),
    status: ev.status,
    lateMinutes: ev.lateMinutes,
    earlyLeaveMinutes: ev.earlyLeaveMinutes,
    workedMinutes: ev.workedMinutes,
    overtimeMinutes: ev.overtimeMinutes,
    overtimeApproved: ev.overtimeApproved,
    locked: !!r.locked,
    payrollLock: isPlaceholder(record),
    punches,
    photos: punches.filter((p) => p.photo).map((p) => ({ url: p.photo, at: p.at, kind: p.kind })),
    corrections: (r.corrections || []).length,
    note: r.note || '',
  };
}

/** Employees for a day's board: everyone active + anyone with a record that day. */
async function boardEmployees(dateKey) {
  const withRecord = await AttendanceRecord.distinct('employee', { date: dateKey });
  return Employee.find({ isDeleted: { $ne: true }, $or: [...ACTIVE_OR, { _id: { $in: withRecord } }] })
    .select(core.EMP_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();
}

/** The "who's in" board for one shop day (default today). */
async function board(query = {}, { now = new Date() } = {}) {
  const dateKey = query.date ? dayKeyOf(query.date) : T.dayKey(now);
  const list = await boardEmployees(dateKey);
  const views = list.length ? await core.dayView({ dateKey, employees: list, now }) : [];
  const rows = views
    .filter((v) => (v.record && !isPlaceholder(v.record)) || (v.plan && v.plan.source !== 'not_employed'))
    .map(boardRow);

  const count = (fn) => rows.filter(fn).length;
  const counts = {
    total: rows.length,
    scheduled: count((r) => r.plan.type === 'shift'),
    inNow: count((r) => r.inNow),
    checkedIn: count((r) => !!r.checkIn),
    late: count((r) => r.lateMinutes > 0),
    halfDay: count((r) => r.status === 'half_day'),
    notInYet: count((r) => r.status === 'pending'),
    absent: count((r) => r.status === 'absent'),
    missingOut: count((r) => r.status === 'missing_out'),
    onLeave: count((r) => r.status === 'leave'),
    off: count((r) => r.status === 'off'),
    holiday: count((r) => r.status === 'holiday'),
    overtimePending: count((r) => r.overtimeMinutes > 0 && r.overtimeApproved === null),
  };
  const holiday = await Holiday.findOne({ date: dateKey }).select('name shopClosed').lean();
  return { date: dateKey, today: T.dayKey(now), isToday: dateKey === T.dayKey(now), holiday: holiday || null, counts, rows };
}

// ---------------------------------------------------------------- records

/**
 * Days whose check-out never came keep a "present" status until something
 * re-evaluates them; settle them so the saved list (and its filters) is right.
 */
async function settleOpenDays({ now = new Date(), limit = 300 } = {}) {
  const open = await AttendanceRecord.find({
    date: { $lte: T.dayKey(now) },
    checkIn: { $ne: null },
    checkOut: null,
    status: { $in: ['present', 'late', 'pending'] },
    locked: { $ne: true },
  })
    .select('employee date')
    .limit(limit)
    .lean();
  for (const r of open) await core.recomputeDay(r.employee, r.date, { now });
  return open.length;
}

const recordOut = (r) => ({
  _id: String(r._id),
  date: r.date,
  employee: r.employee && r.employee._id ? employeeOut(r.employee) : { _id: String(r.employee), name: '', code: '', designation: '', photo: null },
  planned: r.planned || null,
  checkIn: r.checkIn || null,
  checkOut: r.checkOut || null,
  ...dayFields(r),
  status: r.status,
  lateMinutes: r.lateMinutes || 0,
  earlyLeaveMinutes: r.earlyLeaveMinutes || 0,
  workedMinutes: r.workedMinutes || 0,
  overtimeMinutes: r.overtimeMinutes || 0,
  overtimeApproved: r.overtimeApproved === undefined ? null : r.overtimeApproved,
  locked: !!r.locked,
  punches: (r.punches || []).map(punchOut),
  corrections: r.corrections || [],
  note: r.note || '',
});

/** Saved attendance days, newest first: ?from&to&employeeId&status&page&limit. */
async function listRecords(query = {}, { now = new Date() } = {}) {
  const p = paging(query);
  const match = {};
  if (query.from || query.to) {
    match.date = {};
    if (query.from) match.date.$gte = dayKeyOf(query.from, 'from date');
    if (query.to) match.date.$lte = dayKeyOf(query.to, 'to date');
  }
  if (query.employeeId) {
    if (!isId(query.employeeId)) throw httpError(400, 'Invalid employee');
    match.employee = query.employeeId;
  }
  if (query.status) {
    const list = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.some((s) => !AttendanceRecord.STATUSES.includes(s))) throw httpError(400, 'Invalid status');
    match.status = { $in: list };
  }
  Object.assign(match, PLACEHOLDER_FILTER); // payroll-lock placeholders are not saved punches
  await settleOpenDays({ now });
  const [rows, total] = await Promise.all([
    AttendanceRecord.find(match)
      .sort({ date: -1, checkIn: -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .populate('employee', 'firstName lastName employeeCode designation photo')
      .lean(),
    AttendanceRecord.countDocuments(match),
  ]);
  return { data: rows.map(recordOut), meta: pageMeta(p, total) };
}

/** Is this employee's month closed by an approved payroll (any locked day)? */
async function monthLocked(employeeId, dateKey) {
  const month = dateKey.slice(0, 7);
  return !!(await AttendanceRecord.exists({ employee: employeeId, date: { $gte: `${month}-01`, $lte: `${month}-31` }, locked: true }));
}

/** One employee's day in full: plan, punches, corrections, evaluation. */
async function dayDetail(query = {}, { now = new Date() } = {}) {
  const employee = await core.loadEmployee(query.employeeId);
  const date = dayKeyOf(query.date);
  const [plan, policy, record] = await Promise.all([
    schedule.planForDay(employee, date),
    policies.policyFor(employee),
    AttendanceRecord.findOne({ employee: employee._id, date }).populate('punches.by', 'firstName lastName').lean(),
  ]);
  const ev = core.evaluate(plan, record, policy, now);
  const out = boardRow({ employee, plan, record, eval: ev });
  out.date = date;
  out.policyName = policy.name;
  out.punches = ((record && record.punches) || []).map((p) => ({ ...punchOut(p), by: p.by && p.by._id ? fullName(p.by) : '' }));
  out.correctionLog = (record && record.corrections) || [];
  out.locked = !!(record && record.locked) || (await monthLocked(employee._id, date));
  out.notEmployed = plan.source === 'not_employed';
  return out;
}

// ---------------------------------------------------------------- corrections

/** ISO time / "HH:mm" (shop time on `date`) / null (clear). undefined = not sent. */
function readTime(v, date, label, after = null) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v).trim();
  let d;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    d = new Date(T.dayStart(date).getTime() + Shift.toMin(s) * MIN_MS);
    if (after && d <= after) d = new Date(d.getTime() + T.DAY_MS); // e.g. out 02:00 after a night shift
  } else {
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) throw httpError(400, `Invalid ${label} time`);
  return d;
}

/**
 * Set / clear check-in and check-out of one shop day (creates the day when it
 * had none, e.g. an "absent" who really worked), log who changed what and why,
 * then let the rules engine re-evaluate the day.
 */
async function correctDay(body = {}, { userId, now = new Date() } = {}) {
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (!reason) throw httpError(400, 'Write the reason for this correction', 'REASON_REQUIRED');
  const employee = await core.loadEmployee(body.employeeId);
  const date = dayKeyOf(body.date);
  if (date > T.dayKey(now)) throw httpError(400, 'You cannot correct a day that has not come yet');

  const plan = await schedule.planForDay(employee, date);
  if (plan.source === 'not_employed') throw httpError(400, `${fullName(employee)} was not working here on ${date}`);

  let rec = await AttendanceRecord.findOne({ employee: employee._id, date });
  if (rec && rec.locked) throw httpError(409, 'This day is locked by an approved payroll', 'ATTENDANCE_LOCKED');
  if (!rec && (await monthLocked(employee._id, date))) throw httpError(409, "This month's payroll is approved — attendance is locked", 'ATTENDANCE_LOCKED');

  const inSent = readTime(body.checkIn, date, 'check-in');
  const curIn = inSent !== undefined ? inSent : rec ? rec.checkIn : null;
  const outSent = readTime(body.checkOut, date, 'check-out', curIn);
  const nextIn = curIn;
  const nextOut = outSent !== undefined ? outSent : rec ? rec.checkOut : null;

  if (nextOut && !nextIn) throw httpError(400, 'A check-out needs a check-in time too');
  if (nextIn && nextOut && nextOut <= nextIn) throw httpError(400, 'Check-out must be after check-in');
  // Sensible window: within 12 h of the planned shift (or the day itself + 12 h).
  const from = plan.type === 'shift' ? new Date(new Date(plan.start).getTime() - CORRECTION_WINDOW_MIN * MIN_MS) : T.dayStart(date);
  const to = plan.type === 'shift'
    ? new Date(new Date(plan.end).getTime() + CORRECTION_WINDOW_MIN * MIN_MS)
    : new Date(T.dayStart(date).getTime() + T.DAY_MS + CORRECTION_WINDOW_MIN * MIN_MS);
  const where = plan.type === 'shift' ? `within 12 hours of the ${clock(plan.start)} – ${clock(plan.end)} shift` : 'on that day';
  for (const [t, label] of [[nextIn, 'Check-in'], [nextOut, 'Check-out']]) {
    if (!t) continue;
    if (t < from || t > to) throw httpError(400, `${label} must be ${where}`);
    if (t - now > MIN_MS) throw httpError(400, `${label} cannot be in the future`);
  }

  const changes = [];
  if (!sameTime(rec ? rec.checkIn : null, nextIn)) changes.push({ field: 'checkIn', from: rec ? rec.checkIn : null, to: nextIn });
  if (!sameTime(rec ? rec.checkOut : null, nextOut)) changes.push({ field: 'checkOut', from: rec ? rec.checkOut : null, to: nextOut });
  if (!changes.length) throw httpError(400, 'Nothing changed');

  if (!rec) {
    rec = await AttendanceRecord.findOneAndUpdate(
      { employee: employee._id, date },
      { $setOnInsert: { employee: employee._id, date } },
      { upsert: true, new: true }
    );
    if (rec.locked) throw httpError(409, 'This day is locked by an approved payroll', 'ATTENDANCE_LOCKED');
  }
  const byName = await userNameOf(userId);
  rec.checkIn = nextIn;
  rec.checkOut = nextOut;
  for (const c of changes) rec.corrections.push({ at: now, by: isId(userId) ? userId : null, byName, field: c.field, from: c.from, to: c.to, reason });
  await rec.save();
  await core.recomputeDay(employee._id, date, { now });
  return dayDetail({ employeeId: employee._id, date }, { now });
}

/** Approve or reject overtime on one or more days (logged, then re-evaluated). */
async function decideOvertime(body = {}, { userId, now = new Date() } = {}) {
  const ids = [...new Set((Array.isArray(body.recordIds) ? body.recordIds : body.recordId ? [body.recordId] : []).map(String))];
  if (!ids.length) throw httpError(400, 'Pick at least one day with overtime');
  if (ids.length > 200) throw httpError(400, 'At most 200 days at a time');
  if (ids.some((id) => !isId(id))) throw httpError(400, 'Invalid attendance day');
  if (typeof body.approved !== 'boolean') throw httpError(400, 'Say approve (true) or reject (false)');
  const approved = body.approved;
  const reason = String(body.reason || '').trim().slice(0, 300) || (approved ? 'Overtime approved' : 'Overtime rejected');

  const recs = await AttendanceRecord.find({ _id: { $in: ids } });
  if (recs.length !== ids.length) throw httpError(404, 'Some attendance days were not found');
  if (recs.some((r) => r.locked)) throw httpError(409, 'Some of these days are locked by an approved payroll', 'ATTENDANCE_LOCKED');

  const byName = await userNameOf(userId);
  const updated = [];
  let skipped = 0;
  for (const rec of recs) {
    if (!rec.overtimeMinutes) {
      skipped += 1;
      continue;
    }
    if (rec.overtimeApproved !== approved) {
      rec.corrections.push({ at: now, by: isId(userId) ? userId : null, byName, field: 'overtime', from: rec.overtimeApproved, to: approved, reason });
    }
    rec.overtimeApproved = approved;
    rec.overtimeDecidedBy = isId(userId) ? userId : null;
    await rec.save();
    const after = await core.recomputeDay(rec.employee, rec.date, { now });
    updated.push({ _id: String(rec._id), date: rec.date, employeeId: String(rec.employee), overtimeMinutes: after.overtimeMinutes, overtimeApproved: after.overtimeApproved });
  }
  return { approved, updated, skipped };
}

// ---------------------------------------------------------------- month sheet

const CODES = {
  present: 'P',
  late: 'L',
  half_day: 'H',
  absent: 'A',
  missing_out: 'M',
  off: 'O',
  holiday: 'HO',
  leave: 'LV',
  upcoming: '·',
  pending: '·',
  not_employed: '',
};
const LEGEND = [
  { code: 'P', status: 'present', label: 'Present' },
  { code: 'L', status: 'late', label: 'Late' },
  { code: 'H', status: 'half_day', label: 'Half day' },
  { code: 'A', status: 'absent', label: 'Absent' },
  { code: 'M', status: 'missing_out', label: 'Missing check-out' },
  { code: 'O', status: 'off', label: 'Day off' },
  { code: 'HO', status: 'holiday', label: 'Holiday' },
  { code: 'LV', status: 'leave', label: 'Leave' },
  { code: '·', status: 'upcoming', label: 'Not yet' },
];
const WEEKDAY_SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

/** Employees for a month: everyone active + anyone with a record in that month. */
async function monthEmployees(month, employeeId) {
  if (employeeId) {
    if (!isId(employeeId)) throw httpError(400, 'Invalid employee');
    return Employee.find({ _id: employeeId, isDeleted: { $ne: true } }).select(core.EMP_FIELDS).lean();
  }
  const withRecord = await AttendanceRecord.distinct('employee', { date: { $gte: `${month}-01`, $lte: `${month}-31` } });
  return Employee.find({ isDeleted: { $ne: true }, $or: [...ACTIVE_OR, { _id: { $in: withRecord } }] })
    .select(core.EMP_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();
}

const cellOf = (d) => ({
  date: d.date,
  code: d.status === 'present' && (d.planned === 'off' || d.planned === 'holiday') ? 'P' : CODES[d.status] ?? '',
  status: d.status,
  planned: d.planned || null,
  shiftName: d.shiftName || '',
  leaveType: d.leaveType || null,
  holidayName: d.holidayName || '',
  checkIn: d.checkIn || null,
  checkOut: d.checkOut || null,
  lateMinutes: d.lateMinutes || 0,
  earlyLeaveMinutes: d.earlyLeaveMinutes || 0,
  workedMinutes: d.workedMinutes || 0,
  overtimeMinutes: d.overtimeMinutes || 0,
  overtimeApproved: d.overtimeApproved === undefined ? null : d.overtimeApproved,
  extra: d.status !== 'off' && (d.planned === 'off' || d.planned === 'holiday'), // worked on a day off / holiday
});

const totalsOf = (s) => ({
  scheduled: s.scheduledDays,
  scheduledInMonth: s.scheduledDaysInMonth,
  present: s.presentDays,
  late: s.lateCount,
  lateMinutes: s.lateMinutes,
  halfDays: s.halfDays,
  absent: s.absentDays,
  missingOut: s.missingOutDays,
  earlyLeaves: s.earlyLeaveCount,
  offDays: s.offDays,
  holidays: s.holidayDays,
  offDaysWorked: s.offDaysWorked,
  leave: s.leave.paid + s.leave.sick + s.leave.unpaid,
  leavePaid: s.leave.paid,
  leaveSick: s.leave.sick,
  leaveUnpaid: s.leave.unpaidTotal,
  workedMinutes: s.workedMinutes,
  overtimeApprovedMinutes: s.overtimeMinutesApproved,
  overtimePendingMinutes: s.overtimeMinutesPending,
  daysWorked: s.daysWorked,
  cuts: s.cuts,
});

/** Month grid (employees × days) with codes and totals. No pay amounts. */
async function sheet(query = {}, { now = new Date() } = {}) {
  const month = monthOf(query.month);
  const list = await monthEmployees(month, query.employeeId);
  const sum = list.length
    ? await core.monthSummary(month, { employeeIds: list.map((e) => e._id), includeDays: true, now })
    : { month, from: `${month}-01`, to: `${month}-${String(T.daysInMonth(month)).padStart(2, '0')}`, daysInMonth: T.daysInMonth(month), employees: [] };
  const [holidays, lockedRecs] = await Promise.all([
    Holiday.find({ date: { $gte: sum.from, $lte: sum.to } }).select('date name').lean(),
    AttendanceRecord.find({ employee: { $in: list.map((e) => e._id) }, date: { $gte: sum.from, $lte: sum.to }, locked: true }).select('employee date').lean(),
  ]);
  const holidayBy = new Map(holidays.map((h) => [h.date, h.name]));
  const lockedDay = new Set(lockedRecs.map((r) => `${r.employee}|${r.date}`));
  const days = T.listDays(sum.from, sum.to).map((date) => ({
    date,
    day: Number(date.slice(8)),
    weekday: WEEKDAY_SHORT[schedule.weekdayOf(date)],
    holidayName: holidayBy.get(date) || '',
  }));
  const byId = new Map(list.map((e) => [String(e._id), e]));
  const employees = sum.employees
    .filter((s) => s.notEmployedDays < sum.daysInMonth)
    .map((s) => {
      const e = byId.get(s.employeeId) || {};
      return {
        employeeId: s.employeeId,
        name: s.name,
        code: s.code,
        designation: s.designation,
        photo: e.photo || null,
        policyName: s.policyName,
        // Paid month: payroll locked its days (real days and placeholders alike).
        locked: (s.days || []).some((d) => lockedDay.has(`${s.employeeId}|${d.date}`)),
        cells: (s.days || []).map((d) => ({ ...cellOf(d), locked: lockedDay.has(`${s.employeeId}|${d.date}`) })),
        totals: totalsOf(s),
      };
    });
  return { month, from: sum.from, to: sum.to, daysInMonth: sum.daysInMonth, today: T.dayKey(now), days, legend: LEGEND, employees };
}

const hours = (min) => Math.round(((Number(min) || 0) / 60) * 100) / 100;

/** CSV columns + rows of the month sheet (analytics/csv.sendCsv format). */
async function sheetCsv(query = {}, opts = {}) {
  const s = await sheet(query, opts);
  const columns = [
    { label: 'Employee', value: (r) => r.name },
    { label: 'Code', value: (r) => r.code },
    { label: 'Designation', value: (r) => r.designation },
    ...s.days.map((d, i) => ({ label: `${d.day} ${d.weekday}`, value: (r) => (r.cells[i] ? r.cells[i].code : '') })),
    { label: 'Scheduled days', value: (r) => r.totals.scheduled },
    { label: 'Present', value: (r) => r.totals.present },
    { label: 'Late', value: (r) => r.totals.late },
    { label: 'Half days', value: (r) => r.totals.halfDays },
    { label: 'Absent', value: (r) => r.totals.absent },
    { label: 'Missing check-out', value: (r) => r.totals.missingOut },
    { label: 'Leave', value: (r) => r.totals.leave },
    { label: 'Unpaid leave', value: (r) => r.totals.leaveUnpaid },
    { label: 'Days off', value: (r) => r.totals.offDays },
    { label: 'Holidays', value: (r) => r.totals.holidays },
    { label: 'Worked on off days', value: (r) => r.totals.offDaysWorked },
    { label: 'Worked hours', value: (r) => hours(r.totals.workedMinutes) },
    { label: 'Overtime approved (h)', value: (r) => hours(r.totals.overtimeApprovedMinutes) },
    { label: 'Overtime waiting (h)', value: (r) => hours(r.totals.overtimePendingMinutes) },
  ];
  return { filename: `attendance-${s.month}`, columns, rows: s.employees };
}

// ---------------------------------------------------------------- exceptions

const hasLegacyTimes = (e) => !!(e.shift && Shift.HHMM.test(e.shift.start || '') && Shift.HHMM.test(e.shift.end || ''));

/**
 * The desktop app's fingerprint model (models/employeeFingerprint.js, field
 * `employee`), or null while that module is not installed yet.
 */
function fingerprintModel() {
  if (mongoose.models.EmployeeFingerprint) return mongoose.models.EmployeeFingerprint;
  try {
    return require('../../models/employeeFingerprint'); // eslint-disable-line global-require
  } catch {
    return null;
  }
}

/** Set of employee ids that have at least one fingerprint enrolled (null = unknown). */
async function enrolledEmployees(ids) {
  const Model = fingerprintModel();
  if (!Model || !Model.schema || !Model.schema.path('employee')) return null;
  const match = { employee: { $in: ids } };
  // Removed fingers keep their row with deletedAt set — they do not count.
  if (Model.schema.path('deletedAt')) match.deletedAt = null;
  if (Model.schema.path('isActive')) match.isActive = { $ne: false };
  if (Model.schema.path('isDeleted')) match.isDeleted = { $ne: true };
  const list = await Model.distinct('employee', match);
  return new Set(list.map(String));
}

/**
 * What to fix before payroll for a month: missing check-outs, absences on
 * scheduled days (no leave), overtime waiting for approval, employees with no
 * fingerprint enrolled or without any schedule. Each item carries the action.
 */
async function exceptions(query = {}, { now = new Date() } = {}) {
  const month = monthOf(query.month);
  const list = await monthEmployees(month);
  const items = [];
  if (list.length) {
    const ids = list.map((e) => e._id);
    const [sum, recs, rosterShifts, enrolled] = await Promise.all([
      core.monthSummary(month, { employeeIds: ids, includeDays: true, now }),
      AttendanceRecord.find({ employee: { $in: ids }, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).select('employee date locked').lean(),
      RosterEntry.distinct('employee', { employee: { $in: ids }, date: { $gte: `${month}-01`, $lte: `${month}-31` }, type: 'shift' }),
      enrolledEmployees(ids),
    ]);
    const recBy = new Map(recs.map((r) => [`${r.employee}|${r.date}`, r]));
    const lockedEmp = new Set(recs.filter((r) => r.locked).map((r) => String(r.employee)));
    const byId = new Map(list.map((e) => [String(e._id), e]));
    const withRoster = new Set(rosterShifts.map(String));

    for (const s of sum.employees) {
      const e = byId.get(s.employeeId);
      const who = { employeeId: s.employeeId, name: s.name, designation: s.designation, photo: (e && e.photo) || null };
      const active = e && e.isActive !== false && (!e.status || Employee.ACTIVE_STATUSES.includes(e.status));
      if (active && enrolled && !enrolled.has(s.employeeId)) {
        items.push({
          type: 'no_fingerprint',
          ...who,
          date: null,
          detail: 'No fingerprint enrolled — cannot clock in on the attendance desktop app',
          actions: [{ kind: 'desktop', label: 'Enroll on the desktop app' }],
        });
      }
      if (active && !e.defaultShift && !hasLegacyTimes(e) && !withRoster.has(s.employeeId)) {
        items.push({
          type: 'no_schedule',
          ...who,
          date: null,
          detail: 'No default shift and nothing on the roster — late / absent cannot be worked out',
          actions: [
            { kind: 'link', label: 'Set default shift', href: `/admin/hr/employees/${s.employeeId}` },
            { kind: 'link', label: 'Open roster', href: '/admin/hr/roster' },
          ],
        });
      }
      if (lockedEmp.has(s.employeeId)) continue; // month already paid: nothing to fix

      for (const d of s.days || []) {
        const rec = recBy.get(`${s.employeeId}|${d.date}`);
        const recordId = rec ? String(rec._id) : null;
        const base = { ...who, date: d.date, recordId, shiftName: d.shiftName || '', checkIn: d.checkIn || null, checkOut: d.checkOut || null };
        if (d.status === 'missing_out') {
          items.push({ type: 'missing_out', ...base, detail: `Clocked in ${clock(d.checkIn)}, never clocked out`, actions: [{ kind: 'correct', label: 'Add check-out' }] });
        } else if (d.status === 'absent' && d.planned === 'shift') {
          items.push({
            type: 'absent',
            ...base,
            detail: `Absent on a ${d.shiftName || 'shift'} day, no leave on the roster`,
            actions: [
              { kind: 'correct', label: 'They worked — add times' },
              { kind: 'link', label: 'Mark leave on roster', href: `/admin/hr/roster?employeeId=${s.employeeId}&date=${d.date}` },
            ],
          });
        }
        if (d.overtimeMinutes > 0 && d.overtimeApproved === null && recordId) {
          items.push({ type: 'overtime', ...base, overtimeMinutes: d.overtimeMinutes, detail: `${duration(d.overtimeMinutes)} overtime waiting for approval`, actions: [{ kind: 'overtime', label: 'Approve / reject' }] });
        }
      }
    }
  }
  const ORDER = { missing_out: 1, absent: 2, overtime: 3, no_fingerprint: 4, no_schedule: 5 };
  items.sort((a, b) => ORDER[a.type] - ORDER[b.type] || String(a.date || '').localeCompare(String(b.date || '')) || a.name.localeCompare(b.name));
  const counts = { missingOut: 0, absent: 0, overtime: 0, noFingerprint: 0, noSchedule: 0 };
  const KEY = { missing_out: 'missingOut', absent: 'absent', overtime: 'overtime', no_fingerprint: 'noFingerprint', no_schedule: 'noSchedule' };
  for (const it of items) counts[KEY[it.type]] += 1;
  return { month, today: T.dayKey(now), fingerprintCheck: !!fingerprintModel(), counts: { ...counts, total: items.length }, items };
}

module.exports = {
  board,
  listRecords,
  dayDetail,
  correctDay,
  decideOvertime,
  sheet,
  sheetCsv,
  exceptions,
  settleOpenDays,
  // helpers (tests / other screens)
  clock,
  duration,
  sourceOf,
};
