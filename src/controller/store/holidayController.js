// Shop holidays (/api/holidays). Fixed-date Pakistan public holidays can be
// added in one go; Eid / Ashura / 12 Rabi ul-Awwal follow the moon and are
// added by hand once announced. Each change re-checks that day's attendance.
const Holiday = require('../../models/holiday');
const AttendanceRecord = require('../../models/attendanceRecord');
const T = require('../../services/analytics/time');
const core = require('../../services/hr/attendanceCore');
const schedule = require('../../services/hr/scheduleService');
const { httpError, isId } = require('../../services/hr/rosterService');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

// Fixed-date public holidays (month-day).
const PAKISTAN_FIXED = [
  ['02-05', 'Kashmir Day'],
  ['03-23', 'Pakistan Day'],
  ['05-01', 'Labour Day'],
  ['08-14', 'Independence Day'],
  ['11-09', 'Iqbal Day'],
  ['12-25', 'Quaid-e-Azam Day'],
];

const out = (h) => ({
  _id: String(h._id),
  date: h.date,
  weekday: schedule.weekdayOf(h.date),
  name: h.name,
  shopClosed: h.shopClosed !== false,
  createdAt: h.createdAt,
});

const readYear = (v) => {
  const y = v === undefined || v === '' ? Number(T.dayKey().slice(0, 4)) : Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw httpError(400, 'Year must be between 2000 and 2100');
  return y;
};

async function load(id) {
  if (!isId(id)) throw httpError(404, 'Holiday not found');
  const h = await Holiday.findById(id);
  if (!h) throw httpError(404, 'Holiday not found');
  return h;
}

/** 409 when that day is in an approved payroll. */
async function assertDayOpen(date) {
  if (await AttendanceRecord.exists({ date, locked: true })) {
    throw httpError(409, `${date} is in an approved payroll, so its holiday cannot change`, 'ATTENDANCE_LOCKED');
  }
}

async function assertFree(date, selfId = null) {
  const dup = await Holiday.findOne({ date, ...(selfId ? { _id: { $ne: selfId } } : {}) }).lean();
  if (dup) throw httpError(409, `${date} is already a holiday: ${dup.name}`, 'DUPLICATE_DATE');
}

const readName = (v) => {
  const name = String(v || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Give the holiday a name, e.g. Eid ul-Fitr');
  return name;
};
const readDate = (v) => {
  if (!T.isDayKey(v)) throw httpError(400, 'Pick a date (YYYY-MM-DD)', 'INVALID_DATE');
  return v;
};

const recompute = (...dates) => Promise.all([...new Set(dates)].map((d) => core.recomputeRange(null, d, d)));

module.exports = {
  /** GET /holidays?year=2026 */
  async list(req, res) {
    const year = readYear(req.query.year);
    const rows = await Holiday.find({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).sort({ date: 1 }).lean();
    ok(res, rows.map(out), 200, { year, total: rows.length });
  },

  async create(req, res) {
    const b = req.body || {};
    const date = readDate(b.date);
    const name = readName(b.name);
    await assertFree(date);
    await assertDayOpen(date);
    const h = await Holiday.create({ date, name, shopClosed: b.shopClosed !== false, createdBy: req.access.userId });
    await recompute(date);
    ok(res, out(h), 201);
  },

  async update(req, res) {
    const h = await load(req.params.id);
    const b = req.body || {};
    const before = h.date;
    if (b.date !== undefined) {
      h.date = readDate(b.date);
      if (h.date !== before) await assertFree(h.date, h._id);
    }
    if (b.name !== undefined) h.name = readName(b.name);
    if (b.shopClosed !== undefined) h.shopClosed = b.shopClosed !== false;
    await assertDayOpen(before);
    if (h.date !== before) await assertDayOpen(h.date);
    await h.save();
    await recompute(before, h.date);
    ok(res, out(h));
  },

  async remove(req, res) {
    const h = await load(req.params.id);
    await assertDayOpen(h.date);
    await h.deleteOne();
    await recompute(h.date);
    ok(res, { _id: String(h._id), deleted: true });
  },

  /** POST /holidays/pakistan { year } — adds the fixed-date public holidays, skipping days already set. */
  async addPakistan(req, res) {
    const year = readYear((req.body || {}).year);
    const wanted = PAKISTAN_FIXED.map(([md, name]) => ({ date: `${year}-${md}`, name }));
    const existing = await Holiday.find({ date: { $in: wanted.map((w) => w.date) } }).lean();
    const taken = new Set(existing.map((e) => e.date));
    const locked = new Set(await AttendanceRecord.distinct('date', { date: { $in: wanted.map((w) => w.date) }, locked: true }));
    const toAdd = wanted.filter((w) => !taken.has(w.date) && !locked.has(w.date));
    const added = [];
    for (const w of toAdd) {
      try {
        added.push(await Holiday.create({ ...w, shopClosed: true, createdBy: req.access.userId }));
      } catch (err) {
        if (err.code !== 11000) throw err; // added at the same moment by someone else
      }
    }
    await recompute(...added.map((a) => a.date));
    ok(res, {
      year,
      added: added.map(out),
      skipped: wanted.filter((w) => !added.some((a) => a.date === w.date)).map((w) => ({ ...w, reason: locked.has(w.date) ? 'payroll approved' : 'already a holiday' })),
    }, added.length ? 201 : 200);
  },

  PAKISTAN_FIXED,
};
