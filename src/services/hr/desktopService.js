// src/services/hr/desktopService.js
// The desktop attendance app (pos_desktop) — the ONLY way staff mark attendance:
// a DigitalPersona fingerprint reader on the counter PC. OWNER: Desktop attendance module.
//
//   sessionInfo(access)            who is signed in on the desk and what it may do
//   renewToken(access)             a fresh 7-day token, so the desk stays signed in
//   listEmployees({ now })         names / photos / fingers on file / in-out state (no private data)
//   listTemplates({ updatedSince }) every active employee's templates for local 1:N matching
//   enroll(employeeId, body, ctx)  save (or replace) one finger's template, max 2 per employee
//   removeFinger(employeeId, finger, ctx)
//   punch(body, ctx)               fingerprint clock in / out (attendanceCore decides in / out / late)
//   board({ date, now })           the counter's "who's in today" list
//
// Fingerprints are matched on the PC: the server never sees a scan, only
// "employee X put a finger on the reader". In / out, late, overtime and the day's
// status are decided by attendanceCore.punch — never here.
const jwt = require('jsonwebtoken');
const T = require('../analytics/time');
const core = require('./attendanceCore');
const Employee = require('../../models/employee');
const AttendanceRecord = require('../../models/attendanceRecord');
const Holiday = require('../../models/holiday');
const EmployeeFingerprint = require('../../models/employeeFingerprint');
const { loadUserAccess } = require('../../middleware/access');
const { httpError, isId } = require('./util');

const { DesktopPunch, FINGERS, MAX_PER_EMPLOYEE } = EmployeeFingerprint;

const MIN_MS = 60 * 1000;
const TOKEN_DAYS = 7;
// A punch whose time is closer than this to "now" is live: the server clock is used.
const LIVE_PUNCH_MS = 2 * MIN_MS;
// Punches saved offline on the desk are accepted up to this age; older ones are
// a manager correction (HR -> Attendance).
const OFFLINE_MAX_AGE_MS = 48 * 60 * MIN_MS;
// Incremental template sync looks back a little before the desk's last sync,
// so a write that landed while the previous sync was running is not missed.
const SYNC_OVERLAP_MS = 60 * 1000;
// A clientId still "pending" after this long belonged to a request that died.
const STALE_PENDING_MS = 2 * MIN_MS;
const TEMPLATE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Employees who still work here (old rows may have only isActive).
const activeFilter = () => ({
  isDeleted: { $ne: true },
  $or: [{ status: { $in: Employee.ACTIVE_STATUSES } }, { status: { $exists: false }, isActive: { $ne: false } }],
});

const fullName = (e) => `${(e && e.firstName) || ''} ${(e && e.lastName) || ''}`.trim();
const fingerLabel = (f) => {
  const s = String(f || '').replace('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ---------------------------------------------------------------- wording

/** "9:58 am" in shop time (PKT), whatever the server's clock zone. */
function clock(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + T.OFFSET_MS);
  const h = t.getUTCHours();
  return `${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

/** 12 -> "12 min", 455 -> "7 h 35 m", 60 -> "1 h". */
function duration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  if (!h) return `${m} min`;
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
}

/** The sentence the desk shows (and says) after a punch. Same wording as the web clock-in screen. */
function punchMessage({ kind, duplicate, at, record, plan }) {
  const time = clock(at);
  if (duplicate) return kind === 'in' ? `Already clocked in at ${time}` : `Already clocked out at ${time}`;
  if (kind === 'in') {
    if (plan.type === 'shift') return `Clocked in ${time} — ${record.lateMinutes ? `${duration(record.lateMinutes)} late` : 'on time'}`;
    if (plan.type === 'off') return `Clocked in ${time} — working on your day off`;
    if (plan.type === 'holiday') return `Clocked in ${time} — working on a holiday`;
    if (plan.type === 'leave') return `Clocked in ${time} — you are on leave today`;
    return `Clocked in ${time}`;
  }
  let msg = `Clocked out ${time} — worked ${duration(record.workedMinutes)}`;
  if (record.earlyLeaveMinutes) msg += ` · left ${duration(record.earlyLeaveMinutes)} early`;
  if (record.overtimeMinutes) msg += ` · ${duration(record.overtimeMinutes)} overtime${record.overtimeApproved === null ? ' (manager will approve)' : ''}`;
  return msg;
}

/** attendanceCore.punch result -> what the desk gets back (no salary / CNIC / phone). */
function describePunch(result, employee, { offline = false } = {}) {
  const r = result.record;
  const last = r.punches && r.punches.length ? r.punches[r.punches.length - 1] : null;
  const at = result.duplicate && last ? last.at : result.kind === 'in' ? r.checkIn : r.checkOut;
  return {
    kind: result.kind,
    at,
    date: result.date,
    employeeId: String(employee._id),
    name: fullName(employee),
    designation: employee.designation || '',
    status: r.status,
    lateMinutes: r.lateMinutes || 0,
    earlyLeaveMinutes: r.earlyLeaveMinutes || 0,
    workedMinutes: r.workedMinutes || 0,
    overtimeMinutes: r.overtimeMinutes || 0,
    overtimeApproved: r.overtimeApproved,
    duplicate: !!result.duplicate,
    offline: !!offline,
    shiftName: (result.plan && result.plan.shiftName) || '',
    recordId: String(r._id),
    message: punchMessage({ kind: result.kind, duplicate: result.duplicate, at, record: r, plan: result.plan || {} }),
  };
}

// ---------------------------------------------------------------- session

/** Who is signed in on the desk, and which parts of the app it may use. */
async function sessionInfo(access, { now = new Date() } = {}) {
  const info = await loadUserAccess(access.userId);
  const u = (info && info.user) || {};
  return {
    user: { id: String(access.userId), name: fullName(u) || u.email || '', email: u.email || '' },
    roleName: access.roleName || null,
    isSuperAdmin: !!access.isSuperAdmin,
    canView: access.can('attendance_kiosk', 'view'),
    canPunch: access.can('attendance_kiosk', 'create'),
    canEnroll: access.can('employees', 'edit') || access.can('attendance', 'edit'),
    serverTime: now,
    timezone: T.TZ || 'Asia/Karachi',
  };
}

/**
 * A fresh token with the same payload as POST /user/login, so a desk that is
 * used every day stays signed in. Only an active account gets one (loadAccess
 * already refused a disabled account before this runs).
 */
async function renewToken(access, { now = new Date() } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw httpError(500, 'Server misconfiguration: missing JWT secret');
  const info = await loadUserAccess(access.userId);
  if (!info || !info.user) throw httpError(401, 'User not found');
  const u = info.user;
  const payload = { id: u._id, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role, isSuperAdmin: !!access.isSuperAdmin };
  const token = jwt.sign(payload, secret, { expiresIn: `${TOKEN_DAYS}d` });
  return { token, expiresAt: new Date(now.getTime() + TOKEN_DAYS * 24 * 60 * MIN_MS) };
}

// ---------------------------------------------------------------- employees

/** Fingers on file per employee: Map id -> [{ finger, quality, enrolledAt, deviceName }]. */
async function fingersByEmployee(employeeIds) {
  const rows = await EmployeeFingerprint.find({ employee: { $in: employeeIds }, deletedAt: null })
    .select('employee finger quality enrolledAt deviceName')
    .sort({ enrolledAt: 1 })
    .lean();
  const by = new Map();
  for (const f of rows) {
    const key = String(f.employee);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ finger: f.finger, label: fingerLabel(f.finger), quality: f.quality, enrolledAt: f.enrolledAt, deviceName: f.deviceName || '' });
  }
  return by;
}

/** Right-now state of one day's record: not in / in since / out. */
const stateOf = (rec) => {
  if (!rec || !rec.checkIn) return { kind: 'not_in', since: null, outAt: null, date: rec ? rec.date : null };
  if (!rec.checkOut) return { kind: 'in', since: rec.checkIn, outAt: null, date: rec.date };
  return { kind: 'out', since: rec.checkIn, outAt: rec.checkOut, date: rec.date };
};

/**
 * Active employees for the desk: names and photos after a match, the
 * enrolment picker, and who is in right now. Nothing private.
 */
async function listEmployees({ now = new Date() } = {}) {
  const list = await Employee.find(activeFilter()).select(core.EMP_FIELDS).sort({ firstName: 1, lastName: 1 }).lean();
  if (!list.length) return [];
  const ids = list.map((e) => e._id);
  const today = T.dayKey(now);
  const yesterday = T.addDays(today, -1);
  const [recs, fingers] = await Promise.all([
    AttendanceRecord.find({ employee: { $in: ids }, date: { $in: [today, yesterday] } })
      .select('employee date checkIn checkOut')
      .lean(),
    fingersByEmployee(ids),
  ]);
  const recBy = new Map(recs.map((r) => [`${r.employee}|${r.date}`, r]));

  const out = [];
  for (const e of list) {
    const id = String(e._id);
    let rec = recBy.get(`${id}|${today}`) || null;
    const yRec = recBy.get(`${id}|${yesterday}`);
    // A night shift from yesterday that is still open owns the next punch.
    if (yRec && yRec.checkIn && !yRec.checkOut && (await core.shopDayFor(e, now)) === yesterday) rec = yRec;
    const enrolled = fingers.get(id) || [];
    out.push({
      _id: id,
      name: fullName(e),
      code: e.employeeCode || '',
      designation: e.designation || '',
      photo: e.photo || null,
      fingers: enrolled.length,
      enrolled,
      state: stateOf(rec),
    });
  }
  return out;
}

// ---------------------------------------------------------------- templates

/**
 * Templates for local 1:N matching. Without updatedSince: every finger of every
 * active employee. With it: only fingers saved since then, plus the fingers
 * removed since then. `employeeIds` always lists every active employee who has
 * a finger on file, so the desk can drop anyone who left or was deactivated.
 */
async function listTemplates({ updatedSince = null, now = new Date() } = {}) {
  let since = null;
  if (updatedSince !== null && updatedSince !== undefined && String(updatedSince).trim() !== '') {
    since = new Date(String(updatedSince));
    if (Number.isNaN(since.getTime())) throw httpError(400, 'updatedSince must be a date and time (ISO)', 'BAD_DATE');
  }
  const from = since ? new Date(since.getTime() - SYNC_OVERLAP_MS) : null;

  const active = await Employee.find(activeFilter()).select('_id').lean();
  const activeIds = active.map((e) => e._id);
  const filter = { employee: { $in: activeIds }, deletedAt: null, template: { $nin: [null, ''] } };
  if (from) filter.updatedAt = { $gte: from };

  const [rows, removed, withFingers] = await Promise.all([
    EmployeeFingerprint.find(filter).select('+template employee finger quality updatedAt').lean(),
    from ? EmployeeFingerprint.find({ deletedAt: { $gte: from } }).select('employee finger').lean() : [],
    EmployeeFingerprint.distinct('employee', { employee: { $in: activeIds }, deletedAt: null }),
  ]);

  return {
    serverTime: now,
    full: !from,
    templates: rows.map((f) => ({
      employeeId: String(f.employee),
      finger: f.finger,
      template: f.template,
      quality: f.quality,
      updatedAt: f.updatedAt,
    })),
    removed: removed.map((f) => ({ employeeId: String(f.employee), finger: f.finger })),
    employeeIds: withFingers.map(String),
  };
}

// ---------------------------------------------------------------- enrolment

function fingerOf(v) {
  const f = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!FINGERS.includes(f)) throw httpError(400, `Finger must be one of: ${FINGERS.join(', ')}`, 'BAD_FINGER');
  return f;
}

function templateOf(v) {
  const s = String(v || '').replace(/\s+/g, '');
  if (s.length < 64 || s.length > 65536 || s.length % 4 !== 0 || !TEMPLATE_RE.test(s)) {
    throw httpError(400, 'The fingerprint template is missing or not valid', 'BAD_TEMPLATE');
  }
  return s;
}

function qualityOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'Quality must be a number from 0 to 100', 'BAD_QUALITY');
  return Math.round(n);
}

const deviceOf = (v) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);

async function activeEmployeeOrThrow(employeeId) {
  if (!isId(employeeId)) throw httpError(400, 'Invalid employee', 'INVALID_EMPLOYEE');
  const e = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } })
    .select('firstName lastName designation status isActive')
    .lean();
  if (!e) throw httpError(404, 'Employee not found');
  if (e.isActive === false) throw httpError(400, 'This employee is not active');
  return e;
}

/**
 * Save one finger's template (a re-scan of a finger already on file replaces it).
 * @returns { created, data, message }
 */
async function enroll(employeeId, body = {}, { userId = null, now = new Date() } = {}) {
  const finger = fingerOf(body.finger);
  const template = templateOf(body.template);
  const quality = qualityOf(body.quality);
  const deviceName = deviceOf(body.deviceName);
  const employee = await activeEmployeeOrThrow(employeeId);

  const existing = await EmployeeFingerprint.findOne({ employee: employee._id, finger }).select('deletedAt').lean();
  const replacing = !!(existing && !existing.deletedAt);
  const tooMany = () =>
    httpError(409, `${fullName(employee)} already has ${MAX_PER_EMPLOYEE} fingers on file. Remove one before adding another.`, 'MAX_FINGERS');
  if (!replacing) {
    const others = await EmployeeFingerprint.countDocuments({ employee: employee._id, deletedAt: null, finger: { $ne: finger } });
    if (others >= MAX_PER_EMPLOYEE) throw tooMany();
  }

  const saved = await EmployeeFingerprint.findOneAndUpdate(
    { employee: employee._id, finger },
    { $set: { template, quality, deviceName, enrolledBy: userId || null, enrolledAt: now, deletedAt: null, deletedBy: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  // Two desks adding different fingers at the same moment: the later one gives way.
  if (!replacing) {
    const count = await EmployeeFingerprint.countDocuments({ employee: employee._id, deletedAt: null });
    if (count > MAX_PER_EMPLOYEE) {
      await EmployeeFingerprint.updateOne({ _id: saved._id }, { $set: { deletedAt: now, deletedBy: userId || null, template: null } });
      throw tooMany();
    }
  }

  return {
    created: !replacing,
    data: {
      employeeId: String(employee._id),
      name: fullName(employee),
      finger,
      label: fingerLabel(finger),
      quality: saved.quality,
      enrolledAt: saved.enrolledAt,
      deviceName: saved.deviceName || '',
      replaced: replacing,
    },
    message: `${fingerLabel(finger)} ${replacing ? 'replaced' : 'saved'} for ${fullName(employee)}`,
  };
}

/** Take one finger off file (the row stays, without its template, for incremental sync). */
async function removeFinger(employeeId, fingerRaw, { userId = null, now = new Date() } = {}) {
  if (!isId(employeeId)) throw httpError(400, 'Invalid employee', 'INVALID_EMPLOYEE');
  const finger = fingerOf(fingerRaw);
  const row = await EmployeeFingerprint.findOneAndUpdate(
    { employee: employeeId, finger, deletedAt: null },
    { $set: { deletedAt: now, deletedBy: userId || null, template: null } },
    { new: true }
  ).lean();
  if (!row) throw httpError(404, 'That finger is not on file for this employee');
  const e = await Employee.findById(employeeId).select('firstName lastName').lean();
  return {
    data: { employeeId: String(employeeId), finger, label: fingerLabel(finger), removed: true },
    message: `${fingerLabel(finger)} removed${e ? ` for ${fullName(e)}` : ''}`,
  };
}

// ---------------------------------------------------------------- punch

/**
 * When the punch happened. Live punches use the server clock. A punch saved
 * offline on the desk (offline: true) keeps its own time, up to 48 h old; when
 * the desk also sends `sentAt` (its clock when sending) the age is measured on
 * the desk's clock, so a PC whose clock is wrong still files the right time.
 */
function punchTime(body, { offline, now }) {
  if (!offline || body.at === undefined || body.at === null || body.at === '') return now;
  const at = new Date(body.at);
  if (Number.isNaN(at.getTime())) throw httpError(400, 'Invalid punch time', 'BAD_TIME');
  let ageMs = now - at;
  if (body.sentAt) {
    const sent = new Date(body.sentAt);
    if (!Number.isNaN(sent.getTime())) ageMs = sent - at;
  }
  if (ageMs < LIVE_PUNCH_MS) return now;
  if (ageMs > OFFLINE_MAX_AGE_MS) {
    throw httpError(
      400,
      'This punch is more than 48 hours old, so it was not recorded. A manager can add it under HR → Attendance (Correct times).',
      'PUNCH_TOO_OLD'
    );
  }
  return new Date(now.getTime() - ageMs);
}

let punchIndexes = null;
const ensurePunchIndexes = () => {
  if (!punchIndexes) punchIndexes = DesktopPunch.init().catch((err) => {
    punchIndexes = null;
    throw err;
  });
  return punchIndexes;
};

/**
 * A fingerprint punch from the desk. `clientId` (one per scan, chosen by the
 * desk) makes retries safe: the same clientId always returns the first result.
 * @returns describePunch(...) + { repeated }
 */
async function punch(body = {}, { userId = null, now = new Date() } = {}, attempt = 0) {
  const employeeId = String(body.employeeId || '').trim();
  if (!isId(employeeId)) throw httpError(400, 'Invalid employee', 'INVALID_EMPLOYEE');
  const method = String(body.method || 'fingerprint').trim();
  if (method !== 'fingerprint') throw httpError(400, 'Attendance is marked by fingerprint only', 'BAD_METHOD');
  const clientId = String(body.clientId || '').trim();
  if (!CLIENT_ID_RE.test(clientId)) throw httpError(400, 'clientId is required (8-64 letters, digits, - or _)', 'BAD_CLIENT_ID');
  const offline = body.offline === true || body.offline === 'true';
  const deviceName = deviceOf(body.deviceName);
  const at = punchTime(body, { offline, now });

  await ensurePunchIndexes();
  let receipt;
  try {
    receipt = await DesktopPunch.create({ clientId, employee: employeeId });
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    const prev = await DesktopPunch.findOne({ clientId }).lean();
    if (!prev && attempt < 1) return punch(body, { userId, now }, attempt + 1);
    if (!prev) throw httpError(409, 'Please try again', 'PUNCH_RETRY');
    if (String(prev.employee) !== employeeId) throw httpError(409, 'This clientId was already used for another employee', 'CLIENT_ID_REUSED');
    if (prev.status === 'done' && prev.result) return { ...prev.result, repeated: true };
    // A request that died half way (server restart): free its clientId once.
    if (attempt < 1 && now - new Date(prev.createdAt) > STALE_PENDING_MS) {
      await DesktopPunch.deleteOne({ _id: prev._id, status: 'pending' });
      return punch(body, { userId, now }, attempt + 1);
    }
    throw httpError(409, 'This punch is still being saved — try again in a moment', 'PUNCH_IN_PROGRESS');
  }

  try {
    const onFile = await EmployeeFingerprint.exists({ employee: employeeId, deletedAt: null });
    if (!onFile) throw httpError(400, 'No fingerprint on file for this employee', 'NO_FINGERPRINT');
    const employee = await core.loadEmployee(employeeId);
    const note = ['fingerprint', deviceName || 'desktop', offline && at < now ? 'saved offline' : null].filter(Boolean).join(' · ');
    const result = await core.punch({ employeeId, at, source: 'device', userId, note });
    const data = describePunch(result, employee, { offline: offline && at < now });
    await DesktopPunch.updateOne({ _id: receipt._id }, { $set: { status: 'done', result: data } });
    return { ...data, repeated: false };
  } catch (err) {
    // Nothing was recorded: let a retry try again.
    await DesktopPunch.deleteOne({ _id: receipt._id }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- board

const STATE_ORDER = { in: 0, not_in: 1, missing_out: 2, out: 3, absent: 4, leave: 5, off: 6, holiday: 7 };
// On a day with no shift (off, holiday, unscheduled) the rules engine reports an
// open check-in as missing_out at once; the counter still shows that person as
// "in" for this long after clocking in. Display only — pay is not affected.
const OPEN_UNSCHEDULED_MS = 16 * 60 * MIN_MS;

/** What the counter shows for one person today. */
function rowState(record, status, plan, now) {
  if (record && record.checkIn && !record.checkOut) {
    if (status !== 'missing_out') return 'in';
    const unscheduled = !plan || plan.type !== 'shift';
    return unscheduled && now - new Date(record.checkIn) < OPEN_UNSCHEDULED_MS ? 'in' : 'missing_out';
  }
  if (record && record.checkOut) return 'out';
  if (status === 'pending') return 'not_in';
  if (status === 'absent' || status === 'leave' || status === 'holiday') return status;
  return 'off';
}

/**
 * The counter's "who's in today": names, designation, planned shift, in / out
 * times, status and late minutes — nothing about pay, CNIC or phone.
 */
async function board({ date = null, now = new Date() } = {}) {
  let dateKey = T.dayKey(now);
  if (date !== null && date !== undefined && String(date).trim() !== '') {
    dateKey = String(date).trim();
    if (!T.isDayKey(dateKey)) throw httpError(400, 'Invalid date (use YYYY-MM-DD)', 'INVALID_DATE');
  }
  const [views, holiday] = await Promise.all([
    core.dayView({ dateKey, now }),
    Holiday.findOne({ date: dateKey }).select('name').lean(),
  ]);

  const rows = views
    .filter((v) => v.record || (v.plan && v.plan.source !== 'not_employed'))
    .map(({ employee, plan, record, eval: ev }) => {
      const p = plan || {};
      const state = rowState(record, ev.status, p, now);
      return {
        employeeId: String(employee._id),
        name: fullName(employee),
        designation: employee.designation || '',
        shift: {
          type: p.type || 'none',
          name: p.shiftName || '',
          start: p.start || null,
          end: p.end || null,
          leaveType: p.leaveType || null,
          holidayName: p.holidayName || '',
        },
        checkIn: (record && record.checkIn) || null,
        checkOut: (record && record.checkOut) || null,
        state,
        status: ev.status,
        lateMinutes: ev.lateMinutes || 0,
      };
    })
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        String(a.checkIn || a.shift.start || '').localeCompare(String(b.checkIn || b.shift.start || '')) ||
        a.name.localeCompare(b.name)
    );

  const count = (fn) => rows.filter(fn).length;
  return {
    date: dateKey,
    today: T.dayKey(now),
    isToday: dateKey === T.dayKey(now),
    serverTime: now,
    holiday: holiday ? holiday.name || 'Holiday' : null,
    counts: {
      total: rows.length,
      scheduled: count((r) => r.shift.type === 'shift'),
      inNow: count((r) => r.state === 'in'),
      out: count((r) => r.state === 'out'),
      late: count((r) => r.lateMinutes > 0),
      notInYet: count((r) => r.state === 'not_in'),
      absent: count((r) => r.state === 'absent'),
      onLeave: count((r) => r.state === 'leave'),
      missingOut: count((r) => r.state === 'missing_out'),
      off: count((r) => r.state === 'off' || r.state === 'holiday'),
    },
    rows,
  };
}

module.exports = {
  sessionInfo,
  renewToken,
  listEmployees,
  listTemplates,
  enroll,
  removeFinger,
  punch,
  board,
  // helpers (tests)
  clock,
  duration,
  punchMessage,
  FINGERS,
  MAX_PER_EMPLOYEE,
  OFFLINE_MAX_AGE_MS,
};
