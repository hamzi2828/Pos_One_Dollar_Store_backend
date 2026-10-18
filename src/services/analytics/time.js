// src/services/analytics/time.js
// Dates for reports are Pakistan time (Asia/Karachi) while the server runs in UTC.
// PKT is UTC+5 all year (no daylight saving since 2009), so day/month
// boundaries can be computed with a fixed offset in JS; Mongo stages use the
// named zone (`timezone: TZ`) so both agree.
//
//   dayKey(date)            -> 'YYYY-MM-DD' (PKT calendar day of an instant)
//   dayStart('2026-10-18')  -> Date of 18 Oct 00:00 PKT (= 17 Oct 19:00 UTC)
//   parseRange(query)       -> { from, to, start, end (exclusive), days }
const TZ = 'Asia/Karachi';
const OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const badRequest = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_DATE' });

/** PKT calendar day of an instant: 'YYYY-MM-DD'. */
const dayKey = (date = new Date()) => new Date(new Date(date).getTime() + OFFSET_MS).toISOString().slice(0, 10);
/** PKT calendar month of an instant: 'YYYY-MM'. */
const monthKey = (date = new Date()) => dayKey(date).slice(0, 7);

const isDayKey = (s) => {
  const m = DAY_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** 00:00 PKT of a 'YYYY-MM-DD' day as a Date. */
function dayStart(key) {
  if (!isDayKey(key)) throw badRequest(`Invalid date "${key}" (use YYYY-MM-DD)`);
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MS);
}

/** 'YYYY-MM-DD' + n days. */
const addDays = (key, n) => new Date(dayStart(key).getTime() + OFFSET_MS + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days between two day keys (b - a). */
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS);

/** 00:00 PKT on the 1st of a 'YYYY-MM' month. */
function monthStart(key) {
  const m = MONTH_RE.exec(String(key || ''));
  if (!m) throw badRequest(`Invalid month "${key}" (use YYYY-MM)`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, 1) - OFFSET_MS);
}

/** 'YYYY-MM' + n months. */
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const daysInMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Monday of the PKT week that contains the day key. */
function weekStartKey(key) {
  const dow = new Date(dayStart(key).getTime() + OFFSET_MS).getUTCDay(); // 0 = Sunday
  return addDays(key, -((dow + 6) % 7));
}

/** Every day key from `from` to `to` (inclusive). */
function listDays(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

/** `count` month keys ending with `lastKey` (oldest first). */
const listMonths = (lastKey, count) => Array.from({ length: count }, (_, i) => addMonths(lastKey, i - count + 1));

const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

/**
 * Report window from ?from=YYYY-MM-DD&to=YYYY-MM-DD (PKT days, inclusive).
 * Missing values: `defaultFrom` ('month' = 1st of this month, or a number of
 * days back) to today. Returns { from, to, start, end, days } where `end` is
 * EXCLUSIVE (00:00 PKT of the day after `to`).
 */
function parseRange(query = {}, { defaultFrom = 'month', maxDays = 731 } = {}) {
  const today = dayKey();
  const to = query.to ? String(query.to) : today;
  let from = query.from ? String(query.from) : null;
  if (!from) from = defaultFrom === 'month' ? `${to.slice(0, 7)}-01` : addDays(to, -(Number(defaultFrom) - 1));
  const start = dayStart(from);
  const end = new Date(dayStart(to).getTime() + DAY_MS);
  if (start >= end) throw badRequest('"from" must be on or before "to"');
  const days = Math.round((end - start) / DAY_MS);
  if (days > maxDays) throw badRequest(`Pick at most ${maxDays} days`);
  return { from, to, start, end, days };
}

/** Whole days from `a` to `b` (instants), floored, never negative. */
const daysSince = (a, b = new Date()) => (a ? Math.max(0, Math.floor((new Date(b) - new Date(a)) / DAY_MS)) : null);

module.exports = {
  TZ,
  OFFSET_MS,
  DAY_MS,
  MONTH_NAMES,
  dayKey,
  monthKey,
  isDayKey,
  dayStart,
  addDays,
  daysBetween,
  monthStart,
  addMonths,
  daysInMonth,
  weekStartKey,
  listDays,
  listMonths,
  monthLabel,
  parseRange,
  daysSince,
};
