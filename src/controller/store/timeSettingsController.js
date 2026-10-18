// Employee "Time & pay" settings (/api/hr/employees/:id/time-settings):
// default shift, weekly off, pay type / daily rate, HR policy, plus a read-only
// fingerprint status. Attendance is marked only on the DOLLAR & Co Attendance
// desktop app (biometric); fingerprints are enrolled there, never here.
const mongoose = require('mongoose');
const Employee = require('../../models/employee');
const Shift = require('../../models/shift');
const HrPolicy = require('../../models/hrPolicy');
const policies = require('../../services/hr/policyService');
const roster = require('../../services/hr/rosterService');
const rules = require('./hrPolicyRules');

const { httpError, isId, fullName } = roster;
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

async function load(id) {
  if (!isId(id)) throw httpError(404, 'Employee not found');
  const emp = await Employee.findOne({ _id: id, isDeleted: { $ne: true } }); // whole record: it is saved back
  if (!emp) throw httpError(404, 'Employee not found');
  return emp;
}

// The fingerprint model belongs to the desktop-app module. Looked up at request
// time so this module still loads (and answers "not enrolled") without it.
let fingerprintWarned = false;
function fingerprintModel() {
  if (mongoose.models.EmployeeFingerprint) return mongoose.models.EmployeeFingerprint;
  try {
    return require('../../models/employeeFingerprint');
  } catch (err) {
    if (!fingerprintWarned) console.warn('[time-settings] fingerprint model not available yet:', String(err.message).split(/\r?\n/)[0]);
    fingerprintWarned = true;
    return null;
  }
}

/** { enrolled, fingers, lastEnrolledAt } for one employee. */
async function fingerprintOf(employeeId) {
  const Model = fingerprintModel();
  if (!Model) return { enrolled: false, fingers: 0, lastEnrolledAt: null };
  const rows = await Model.find({ employee: employeeId, deletedAt: null }) // removed fingers keep their row with deletedAt.select('finger enrolledAt createdAt').lean();
  const fingers = new Set(rows.map((r, i) => (r.finger !== undefined && r.finger !== null ? String(r.finger) : `#${i}`))).size;
  const times = rows.map((r) => new Date(r.enrolledAt || r.createdAt || 0).getTime()).filter((t) => t > 0);
  return { enrolled: fingers > 0, fingers, lastEnrolledAt: times.length ? new Date(Math.max(...times)) : null };
}

const policyOption = (p) => ({ _id: String(p._id), name: p.name, isDefault: !!p.isDefault, summary: rules.summarize(p) });

/** The settings card: current values + the shift / policy choices. Pay rate only for editors. */
async function view(req, emp) {
  const [shifts, policyRows, current, effective, fingerprint] = await Promise.all([
    Shift.find({}).sort({ isActive: -1, sortOrder: 1, name: 1 }).lean(),
    HrPolicy.find({}).sort({ isDefault: -1, name: 1 }).lean(),
    emp.defaultShift ? Shift.findById(emp.defaultShift).setOptions({ withDeleted: true }).lean() : null,
    policies.policyFor(emp),
    fingerprintOf(emp._id),
  ]);
  const own = emp.hrPolicy && policyRows.some((p) => String(p._id) === String(emp.hrPolicy)) ? String(emp.hrPolicy) : null;
  const sensitive = !!req.access?.can('employees', 'edit');
  return {
    employeeId: String(emp._id),
    name: fullName(emp),
    defaultShift: current ? roster.shiftOut(current) : null,
    weeklyOff: emp.weeklyOff || [],
    payType: emp.payType || 'monthly',
    dailyRate: sensitive ? Number(emp.dailyRate) || 0 : null,
    hrPolicy: own, // null = follows the default policy
    policy: policyOption(effective),
    fingerprint, // read-only: enrolled on the Attendance desktop app
    sensitiveHidden: !sensitive,
    options: {
      shifts: shifts.filter((s) => s.isActive !== false || String(s._id) === String(emp.defaultShift || '')).map(roster.shiftOut),
      policies: policyRows.map(policyOption),
    },
  };
}

const history = (emp, req, action) => {
  emp.history.push({ by: req.access.userId, action, note: '' });
  if (emp.history.length > 200) emp.history = emp.history.slice(-200);
};

module.exports = {
  async get(req, res) {
    ok(res, await view(req, await load(req.params.id)));
  },

  /** PUT { defaultShift, weeklyOff[], payType, dailyRate, hrPolicy } — any subset. Re-checks this month. */
  async update(req, res) {
    const emp = await load(req.params.id);
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

    if (has('defaultShift')) {
      if (b.defaultShift === null || b.defaultShift === '') emp.defaultShift = null;
      else {
        if (!isId(b.defaultShift)) throw httpError(400, 'Pick a shift');
        const s = await Shift.findById(b.defaultShift).lean();
        if (!s) throw httpError(400, 'Shift not found (it may have been deleted)');
        if (s.isActive === false && String(emp.defaultShift || '') !== String(s._id)) throw httpError(400, `The shift "${s.name}" is switched off`);
        emp.defaultShift = s._id;
      }
    }
    if (has('weeklyOff')) {
      const list = (Array.isArray(b.weeklyOff) ? b.weeklyOff : []).map((d) => String(d).toLowerCase());
      if (list.some((d) => !Employee.DAYS.includes(d))) throw httpError(400, 'Invalid weekly off day');
      if (list.length > 3) throw httpError(400, 'Pick at most 3 weekly off days');
      emp.weeklyOff = Employee.DAYS.filter((d) => list.includes(d));
    }
    if (has('payType')) {
      if (!['monthly', 'daily'].includes(b.payType)) throw httpError(400, 'Pay type must be monthly or daily');
      emp.payType = b.payType;
    }
    if (has('dailyRate')) {
      const n = b.dailyRate === '' || b.dailyRate === null ? 0 : Number(b.dailyRate);
      if (!Number.isFinite(n) || n < 0 || n > 1000000) throw httpError(400, 'Daily rate must be a number of 0 or more');
      emp.dailyRate = Math.round(n * 100) / 100;
    }
    if (emp.payType === 'daily' && !(Number(emp.dailyRate) > 0)) throw httpError(400, 'Enter the daily rate for a daily-wage employee');
    if (has('hrPolicy')) {
      if (b.hrPolicy === null || b.hrPolicy === '' || b.hrPolicy === 'default') emp.hrPolicy = null;
      else {
        if (!isId(b.hrPolicy)) throw httpError(400, 'Pick a policy');
        const p = await HrPolicy.findOne({ _id: b.hrPolicy, isActive: true }).select('_id').lean();
        if (!p) throw httpError(400, 'Policy not found (it may have been deleted)');
        emp.hrPolicy = p._id;
      }
    }

    if (emp.isModified()) {
      emp.updatedBy = req.access.userId;
      history(emp, req, 'time_settings');
      await emp.save();
      await roster.recomputeMonthFor([emp._id]);
    }
    ok(res, await view(req, emp));
  },
};
