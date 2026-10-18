// src/services/hr/scheduleService.js
// Who should work when (shop time, Asia/Karachi).
//
// Plan of one employee for one shop day, in this order:
//   1. not employed yet / already left        -> 'none'  (source 'not_employed')
//   2. roster cell (models/rosterEntry.js)     -> 'shift' | 'off' | 'leave'
//   3. shop holiday (models/holiday.js)        -> 'holiday'
//   4. weekly off day (employee.weeklyOff)     -> 'off'
//   5. employee.defaultShift                   -> 'shift'
//   6. old employee.shift { start, end } times -> 'shift' (source 'legacy')
//   7. otherwise                               -> 'none'  (no schedule)
// A shift whose end is not after its start ends the next day (night shift);
// its `date` is the day it STARTS.
const T = require('../analytics/time');
const Shift = require('../../models/shift');
const Holiday = require('../../models/holiday');
const RosterEntry = require('../../models/rosterEntry');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** 'monday'... for a 'YYYY-MM-DD' shop day. */
const weekdayOf = (key) => WEEKDAYS[new Date(T.dayStart(key).getTime() + T.OFFSET_MS).getUTCDay()];

/** Shift times on a shop day -> { start: Date, end: Date, workMinutes }. */
function windowFor(key, shift) {
  const start = new Date(T.dayStart(key).getTime() + Shift.toMin(shift.start) * 60000);
  const span = Shift.spanMinutes(shift.start, shift.end);
  const end = new Date(start.getTime() + span * 60000);
  return { start, end, workMinutes: Math.max(0, span - (Number(shift.breakMinutes) || 0)) };
}

const dayKeyOf = (d) => (d ? T.dayKey(new Date(d)) : null);

function shiftPlan(key, shift, source, extra = {}) {
  const w = windowFor(key, shift);
  return {
    date: key,
    type: 'shift',
    source,
    shiftId: shift._id ? String(shift._id) : null,
    shiftName: shift.name || 'Shift',
    shiftCode: shift.code || '',
    color: shift.color || '#FFD60A',
    start: w.start,
    end: w.end,
    breakMinutes: Number(shift.breakMinutes) || 0,
    workMinutes: w.workMinutes,
    leaveType: null,
    holidayName: '',
    ...extra,
  };
}

const plain = (key, type, source, extra = {}) => ({
  date: key,
  type,
  source,
  shiftId: null,
  shiftName: '',
  shiftCode: '',
  color: '',
  start: null,
  end: null,
  breakMinutes: 0,
  workMinutes: 0,
  leaveType: null,
  holidayName: '',
  ...extra,
});

/**
 * Plans for many employees over shop days fromKey..toKey (inclusive).
 * `employees`: plain employees with _id, defaultShift, weeklyOff, shift,
 * joiningDate / hireDate, exitDate.
 * @returns Map employeeId -> [plan per day, in date order]
 */
async function planFor(employees, fromKey, toKey) {
  const list = (employees || []).filter(Boolean);
  const days = T.listDays(fromKey, toKey);
  const out = new Map();
  if (!list.length || !days.length) return out;

  const ids = list.map((e) => e._id);
  const [holidays, entries] = await Promise.all([
    Holiday.find({ date: { $gte: fromKey, $lte: toKey } }).lean(),
    RosterEntry.find({ employee: { $in: ids }, date: { $gte: fromKey, $lte: toKey } }).lean(),
  ]);
  const holidayByDay = new Map(holidays.map((h) => [h.date, h]));
  const entryBy = new Map(entries.map((r) => [`${r.employee}|${r.date}`, r]));

  const shiftIds = new Set();
  for (const e of list) if (e.defaultShift) shiftIds.add(String(e.defaultShift._id || e.defaultShift));
  for (const r of entries) if (r.shift) shiftIds.add(String(r.shift));
  const shifts = shiftIds.size
    ? await Shift.find({ _id: { $in: [...shiftIds] } }).setOptions({ withDeleted: true }).lean()
    : [];
  const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

  for (const e of list) {
    const joined = dayKeyOf(e.joiningDate || e.hireDate);
    const left = dayKeyOf(e.exitDate);
    const offs = new Set((e.weeklyOff || []).map((d) => String(d).toLowerCase()));
    const def = e.defaultShift ? shiftById.get(String(e.defaultShift._id || e.defaultShift)) : null;
    const legacy = e.shift && Shift.HHMM.test(e.shift.start || '') && Shift.HHMM.test(e.shift.end || '')
      ? { name: 'Shift', start: e.shift.start, end: e.shift.end, breakMinutes: 0 }
      : null;

    const plans = days.map((key) => {
      if ((joined && key < joined) || (left && key > left)) return plain(key, 'none', 'not_employed');
      const holiday = holidayByDay.get(key);
      const holidayName = holiday ? holiday.name : '';
      const entry = entryBy.get(`${e._id}|${key}`);
      if (entry) {
        if (entry.type === 'shift') {
          const s = entry.shift ? shiftById.get(String(entry.shift)) : null;
          return s ? shiftPlan(key, s, 'roster', { holidayName, rosterNote: entry.note || '' }) : plain(key, 'none', 'roster');
        }
        if (entry.type === 'leave') return plain(key, 'leave', 'roster', { leaveType: entry.leaveType || 'paid', holidayName, rosterNote: entry.note || '' });
        return plain(key, 'off', 'roster', { holidayName, rosterNote: entry.note || '' });
      }
      if (holiday) return plain(key, 'holiday', 'holiday', { holidayName });
      if (offs.has(weekdayOf(key))) return plain(key, 'off', 'weekly_off');
      if (def) return shiftPlan(key, def, 'default');
      if (legacy) return shiftPlan(key, legacy, 'legacy');
      return plain(key, 'none', 'none');
    });
    out.set(String(e._id), plans);
  }
  return out;
}

/** Plan of one employee on one shop day. */
async function planForDay(employee, key) {
  const map = await planFor([employee], key, key);
  return (map.get(String(employee._id)) || [])[0] || plain(key, 'none', 'none');
}

module.exports = { planFor, planForDay, weekdayOf, windowFor, WEEKDAYS };
