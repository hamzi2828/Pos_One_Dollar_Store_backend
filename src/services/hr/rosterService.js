// src/services/hr/rosterService.js
// The weekly roster (who works which shift on which shop day) and the small
// helpers the shifts / holidays / HR policy / time-settings controllers share.
//
//   grid({ from, days })                    employees x days with plans (default or roster override)
//   saveCells(cells, { userId })            bulk set / clear roster cells ('default' = remove the override)
//   copyWeek({ fromWeekStart, toWeekStart, overwrite, userId })
//   recomputeDays(pairs) / recomputeMonthFor(ids) / recomputeShift(id)
//                                           re-check saved attendance after a change
//
// Plans always come from scheduleService.planFor (roster > holiday > weekly off
// > default shift). Attendance is only re-evaluated through attendanceCore.
const mongoose = require('mongoose');
const T = require('../analytics/time');
const Employee = require('../../models/employee');
const Shift = require('../../models/shift');
const Holiday = require('../../models/holiday');
const RosterEntry = require('../../models/rosterEntry');
const AttendanceRecord = require('../../models/attendanceRecord');
const schedule = require('./scheduleService');
const core = require('./attendanceCore');

const httpError = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code }, extra);
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const fullName = (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim();

const CELL_TYPES = ['shift', 'off', 'leave', 'default'];
const MAX_CELLS = 600;
const MAX_DAYS = 31;
const EMPLOYED = ['active', 'on_leave'];
const EMP_FIELDS = 'firstName lastName employeeCode designation photo status isActive defaultShift weeklyOff shift joiningDate hireDate exitDate';

/** Current staff (active / on leave). Old rows may have no status, only isActive. */
const currentFilter = (extra = {}) => ({
  isDeleted: { $ne: true },
  $or: [{ status: { $in: EMPLOYED } }, { status: { $exists: false }, isActive: { $ne: false } }],
  ...extra,
});

/** 'HH:mm' shop time of an instant. */
const hhmm = (d) => (d ? new Date(new Date(d).getTime() + T.OFFSET_MS).toISOString().slice(11, 16) : null);
const todayKey = () => T.dayKey(new Date());

/** Shift as the API sends it (with hours and the night-shift flag). */
function shiftOut(s) {
  if (!s) return null;
  const span = Shift.spanMinutes(s.start, s.end);
  return {
    _id: String(s._id),
    name: s.name,
    code: s.code || '',
    start: s.start,
    end: s.end,
    breakMinutes: Number(s.breakMinutes) || 0,
    color: s.color || '#FFD60A',
    isActive: s.isActive !== false,
    sortOrder: Number(s.sortOrder) || 0,
    spanMinutes: span,
    workMinutes: Shift.workMinutes(s),
    overnight: Shift.toMin(s.end) <= Shift.toMin(s.start),
  };
}

// ---------- re-checking attendance after a change ----------

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Re-evaluate the saved, unlocked attendance records matching `match`. Returns how many. */
async function recomputeWhere(match) {
  const recs = await AttendanceRecord.find({ ...match, locked: { $ne: true } }).select('employee date').lean();
  await eachLimit(recs, 6, (r) => core.recomputeDay(r.employee, r.date));
  return recs.length;
}

/** Re-check given employee days (future days have no records yet, so they are skipped). */
async function recomputeDays(pairs) {
  const today = todayKey();
  const keep = (pairs || []).filter((p) => p && p.date <= today);
  if (!keep.length) return 0;
  return recomputeWhere({ $or: keep.map((p) => ({ employee: p.employee, date: p.date })) });
}

/** Re-check this month (1st .. today) for some employees. `null` = everyone; [] = no one. */
async function recomputeMonthFor(employeeIds) {
  if (Array.isArray(employeeIds) && !employeeIds.length) return 0;
  const today = todayKey();
  const match = { date: { $gte: `${today.slice(0, 7)}-01`, $lte: today } };
  if (employeeIds) match.employee = { $in: employeeIds };
  return recomputeWhere(match);
}

/** After a shift's times change: this month's days planned on that shift. */
async function recomputeShift(shiftId) {
  const today = todayKey();
  return recomputeWhere({ 'planned.shift': shiftId, date: { $gte: `${today.slice(0, 7)}-01`, $lte: today } });
}

/** 409 when any of these employee days is locked by an approved payroll. */
async function assertNotLocked(pairs) {
  if (!pairs.length) return;
  const locked = await AttendanceRecord.find({ locked: true, $or: pairs.map((p) => ({ employee: p.employee, date: p.date })) })
    .select('employee date')
    .lean();
  if (!locked.length) return;
  const emps = await Employee.find({ _id: { $in: locked.map((l) => l.employee) } }).select('firstName lastName').lean();
  const nameOf = new Map(emps.map((e) => [String(e._id), fullName(e)]));
  const list = locked.slice(0, 3).map((l) => `${nameOf.get(String(l.employee)) || 'Employee'} on ${l.date}`).join(', ');
  throw httpError(409, `These days are in an approved payroll and cannot change: ${list}${locked.length > 3 ? ` and ${locked.length - 3} more` : ''}`, 'ATTENDANCE_LOCKED', {
    available: locked.map((l) => ({ employeeId: String(l.employee), date: l.date })),
  });
}

// ---------- roster grid ----------

const employedOn = (e, key) => {
  const joined = e.joiningDate || e.hireDate ? T.dayKey(new Date(e.joiningDate || e.hireDate)) : null;
  const left = e.exitDate ? T.dayKey(new Date(e.exitDate)) : null;
  return !((joined && key < joined) || (left && key > left));
};

/**
 * The roster for `days` shop days from `from` (default: this week's Monday).
 * @returns { from, to, today, days: [...], employees: [{ ..., cells: [...] }], shifts }
 */
async function grid({ from, days } = {}) {
  const today = todayKey();
  const start = from ? String(from) : T.weekStartKey(today);
  if (!T.isDayKey(start)) throw httpError(400, 'from must be a date like 2026-10-12', 'INVALID_DATE');
  const count = Math.min(MAX_DAYS, Math.max(1, parseInt(days, 10) || 7));
  const end = T.addDays(start, count - 1);
  const keys = T.listDays(start, end);

  const employees = await Employee.find(currentFilter())
    .select(EMP_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  const ids = employees.map((e) => e._id);
  const [plans, holidays, locked, shifts] = await Promise.all([
    schedule.planFor(employees, start, end),
    Holiday.find({ date: { $gte: start, $lte: end } }).lean(),
    AttendanceRecord.find({ employee: { $in: ids }, date: { $gte: start, $lte: end }, locked: true }).select('employee date').lean(),
    Shift.find({}).setOptions({ withDeleted: true }).lean(),
  ]);
  const holidayBy = new Map(holidays.map((h) => [h.date, h]));
  const lockedSet = new Set(locked.map((l) => `${l.employee}|${l.date}`));
  const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

  const dayTotals = new Map(keys.map((k) => [k, { minutes: 0, working: 0 }]));
  const rows = employees.map((e) => {
    const id = String(e._id);
    let plannedMinutes = 0;
    let workingDays = 0;
    const cells = (plans.get(id) || []).map((p) => {
      const isShift = p.type === 'shift';
      if (isShift) {
        plannedMinutes += p.workMinutes;
        workingDays += 1;
        const t = dayTotals.get(p.date);
        t.minutes += p.workMinutes;
        t.working += 1;
      }
      return {
        date: p.date,
        type: p.type, // shift | off | leave | holiday | none
        source: p.source, // roster | default | weekly_off | holiday | legacy | none | not_employed
        isOverride: p.source === 'roster',
        shiftId: p.shiftId,
        shiftName: p.shiftName,
        shiftCode: p.shiftCode,
        color: p.color,
        start: isShift ? hhmm(p.start) : null,
        end: isShift ? hhmm(p.end) : null,
        workMinutes: p.workMinutes || 0,
        leaveType: p.leaveType,
        holidayName: p.holidayName,
        note: p.rosterNote || '',
        locked: lockedSet.has(`${id}|${p.date}`),
        employed: p.source !== 'not_employed',
      };
    });
    const def = e.defaultShift ? shiftById.get(String(e.defaultShift)) : null;
    return {
      _id: id,
      name: fullName(e),
      code: e.employeeCode || '',
      designation: e.designation || '',
      photo: e.photo || null,
      status: e.status || 'active',
      defaultShift: def ? shiftOut(def) : null,
      weeklyOff: e.weeklyOff || [],
      plannedMinutes,
      workingDays,
      cells,
    };
  });

  return {
    from: start,
    to: end,
    today,
    days: keys.map((k) => {
      const h = holidayBy.get(k);
      const t = dayTotals.get(k);
      return {
        date: k,
        weekday: schedule.weekdayOf(k),
        isToday: k === today,
        holiday: h ? { _id: String(h._id), name: h.name, shopClosed: h.shopClosed !== false } : null,
        plannedMinutes: t.minutes,
        working: t.working,
      };
    }),
    employees: rows,
    shifts: shifts.filter((s) => s.isActive !== false && !s.isDeleted).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)).map(shiftOut),
  };
}

// ---------- saving cells ----------

/** Validate the request body -> clean cells (last one wins per employee + day). */
async function readCells(input) {
  if (!Array.isArray(input) || !input.length) throw httpError(400, 'Send at least one roster cell');
  if (input.length > MAX_CELLS) throw httpError(400, `At most ${MAX_CELLS} cells at a time`);

  const byKey = new Map();
  for (const raw of input) {
    const c = raw || {};
    if (!isId(c.employeeId)) throw httpError(400, 'Each cell needs a valid employeeId');
    if (!T.isDayKey(c.date)) throw httpError(400, `Invalid date "${c.date}" (use YYYY-MM-DD)`, 'INVALID_DATE');
    if (!CELL_TYPES.includes(c.type)) throw httpError(400, 'Cell type must be shift, off, leave or default');
    const cell = { employee: String(c.employeeId), date: c.date, type: c.type, shift: null, leaveType: null, note: '' };
    if (c.type === 'shift') {
      if (!isId(c.shiftId)) throw httpError(400, 'Pick a shift for a shift cell');
      cell.shift = String(c.shiftId);
    }
    if (c.type === 'leave') {
      const lt = c.leaveType || 'paid';
      if (!RosterEntry.LEAVE_TYPES.includes(lt)) throw httpError(400, 'Leave type must be paid, unpaid or sick');
      cell.leaveType = lt;
    }
    if (c.type !== 'default') cell.note = String(c.note || '').trim().slice(0, 200);
    byKey.set(`${cell.employee}|${cell.date}`, cell);
  }
  const cells = [...byKey.values()];

  // Shifts must exist and be switched on; employees must exist.
  const shiftIds = [...new Set(cells.filter((c) => c.shift).map((c) => c.shift))];
  if (shiftIds.length) {
    const found = await Shift.find({ _id: { $in: shiftIds } }).select('name isActive').lean();
    if (found.length !== shiftIds.length) throw httpError(400, 'Shift not found (it may have been deleted)');
    const off = found.find((s) => s.isActive === false);
    if (off) throw httpError(400, `The shift "${off.name}" is switched off. Switch it on in the Shifts tab first.`);
  }
  const empIds = [...new Set(cells.map((c) => c.employee))];
  const emps = await Employee.find({ _id: { $in: empIds }, isDeleted: { $ne: true } }).select('joiningDate hireDate exitDate').lean();
  if (emps.length !== empIds.length) throw httpError(404, 'Employee not found');
  const empBy = new Map(emps.map((e) => [String(e._id), e]));
  return { cells, empBy };
}

/**
 * Save roster cells. Days before joining / after leaving are skipped.
 * @returns { saved, cleared, skipped, recomputed }
 */
async function saveCells(input, { userId = null } = {}) {
  const { cells: all, empBy } = await readCells(input);
  const cells = all.filter((c) => employedOn(empBy.get(c.employee), c.date));
  await assertNotLocked(cells);

  const ops = cells.map((c) =>
    c.type === 'default'
      ? { deleteOne: { filter: { employee: c.employee, date: c.date } } }
      : {
          updateOne: {
            filter: { employee: c.employee, date: c.date },
            update: {
              $set: { type: c.type, shift: c.shift, leaveType: c.leaveType, note: c.note },
              $setOnInsert: { employee: c.employee, date: c.date, createdBy: userId || null },
            },
            upsert: true,
          },
        }
  );
  if (ops.length) await RosterEntry.bulkWrite(ops, { ordered: false });
  const recomputed = await recomputeDays(cells);
  return {
    saved: cells.filter((c) => c.type !== 'default').length,
    cleared: cells.filter((c) => c.type === 'default').length,
    skipped: all.length - cells.length,
    recomputed,
  };
}

// ---------- copy a week ----------

/**
 * Copy the roster changes of one week onto another (both normalised to Monday).
 *   overwrite false: cells already changed in the target week are kept.
 *   overwrite true : the target week becomes an exact copy (its own changes are removed).
 * Only current employees, only days they are employed, only shifts that still exist.
 * @returns { fromWeekStart, toWeekStart, copied, removed, skipped, recomputed }
 */
async function copyWeek({ fromWeekStart, toWeekStart, overwrite = false, userId = null } = {}) {
  if (!T.isDayKey(fromWeekStart) || !T.isDayKey(toWeekStart)) throw httpError(400, 'Pick both weeks (YYYY-MM-DD)', 'INVALID_DATE');
  const src = T.weekStartKey(fromWeekStart);
  const dst = T.weekStartKey(toWeekStart);
  if (src === dst) throw httpError(400, 'Pick two different weeks');
  const shiftBy = T.daysBetween(src, dst);
  const srcEnd = T.addDays(src, 6);
  const dstEnd = T.addDays(dst, 6);

  const employees = await Employee.find(currentFilter()).select('joiningDate hireDate exitDate').lean();
  const empBy = new Map(employees.map((e) => [String(e._id), e]));
  const ids = employees.map((e) => e._id);
  const [source, target, shifts] = await Promise.all([
    RosterEntry.find({ employee: { $in: ids }, date: { $gte: src, $lte: srcEnd } }).lean(),
    RosterEntry.find({ employee: { $in: ids }, date: { $gte: dst, $lte: dstEnd } }).lean(),
    Shift.find({ isActive: true }).select('_id').lean(),
  ]);
  const liveShift = new Set(shifts.map((s) => String(s._id)));
  const targetBy = new Map(target.map((t) => [`${t.employee}|${t.date}`, t]));

  let skipped = 0;
  const writes = [];
  const copiedKeys = new Set();
  for (const r of source) {
    const date = T.addDays(r.date, shiftBy);
    const key = `${r.employee}|${date}`;
    const emp = empBy.get(String(r.employee));
    if (!emp || !employedOn(emp, date) || (r.type === 'shift' && !liveShift.has(String(r.shift)))) {
      skipped += 1;
      continue;
    }
    copiedKeys.add(key);
    const existing = targetBy.get(key);
    if (existing && !overwrite) {
      skipped += 1;
      continue;
    }
    const same = existing && existing.type === r.type && String(existing.shift || '') === String(r.shift || '') && (existing.leaveType || null) === (r.leaveType || null);
    if (same) continue;
    writes.push({ employee: String(r.employee), date, type: r.type, shift: r.shift || null, leaveType: r.leaveType || null, note: r.note || '' });
  }
  // Overwrite: changes in the target week that the source week does not have go back to default.
  const removals = overwrite ? target.filter((t) => !copiedKeys.has(`${t.employee}|${t.date}`)).map((t) => ({ employee: String(t.employee), date: t.date })) : [];

  await assertNotLocked([...writes, ...removals]);
  const ops = [
    ...writes.map((c) => ({
      updateOne: {
        filter: { employee: c.employee, date: c.date },
        update: { $set: { type: c.type, shift: c.shift, leaveType: c.leaveType, note: c.note }, $setOnInsert: { employee: c.employee, date: c.date, createdBy: userId || null } },
        upsert: true,
      },
    })),
    ...removals.map((c) => ({ deleteOne: { filter: { employee: c.employee, date: c.date } } })),
  ];
  if (ops.length) await RosterEntry.bulkWrite(ops, { ordered: false });
  const recomputed = await recomputeDays([...writes, ...removals]);
  return { fromWeekStart: src, toWeekStart: dst, sourceCells: source.length, copied: writes.length, removed: removals.length, skipped, recomputed };
}

module.exports = {
  grid,
  saveCells,
  copyWeek,
  shiftOut,
  recomputeDays,
  recomputeMonthFor,
  recomputeShift,
  recomputeWhere,
  assertNotLocked,
  httpError,
  isId,
  fullName,
  todayKey,
  currentFilter,
  EMPLOYED,
};
