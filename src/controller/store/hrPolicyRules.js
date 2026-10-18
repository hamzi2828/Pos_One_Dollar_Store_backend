// HR policy fields: friendly labels, validation (ranges come from
// models/hrPolicy.js so there is one source of truth) and the plain-English
// summary shown on the policy cards, e.g.
//   "10 min grace · every 3 lates cut 1 day · absent cuts 1 day (salary ÷ 30) · ..."
const HrPolicy = require('../../models/hrPolicy');
const { httpError } = require('../../services/hr/rosterService');

// Every editable rule (path in the policy -> label used in error messages).
const FIELDS = {
  'attendance.graceMinutes': 'Grace time',
  'attendance.lateRule.type': 'Late rule',
  'attendance.lateRule.latesPerCut': 'Lates per cut',
  'attendance.lateRule.cutDays': 'Days cut for those lates',
  'attendance.earlyLeaveGraceMinutes': 'Early leave grace',
  'attendance.earlyLeaveCountsAsLate': 'Early leave counts as a late',
  'attendance.halfDay.enabled': 'Half day rule',
  'attendance.halfDay.lateAfterMinutes': 'Half day when late by more than',
  'attendance.halfDay.minWorkedPct': 'Half day when worked less than',
  'attendance.missingOutCountsAs': 'No check-out counts as',
  'pay.dayDivisor': 'Day rate',
  'pay.fixedDays': 'Salary divided by',
  'pay.absentCutDays': 'Days cut per absent day',
  'pay.halfDayCut': 'Cut per half day',
  'pay.paidWeeklyOff': 'Weekly off is paid',
  'pay.paidHolidays': 'Holidays are paid',
  'overtime.enabled': 'Overtime pay',
  'overtime.rate': 'Overtime rate',
  'overtime.minMinutes': 'Minimum overtime',
  'overtime.maxMinutesPerDay': 'Most overtime a day',
  'overtime.needsApproval': 'Overtime needs approval',
  'leave.paidPerMonth': 'Paid leave a month',
  'leave.sickPerMonth': 'Sick leave a month',
  'tillShortage.deduct': 'Cut till shortages',
  'tillShortage.needsApproval': 'Till shortage needs approval',
  'tillShortage.maxPerMonth': 'Most till shortage cut a month',
};
const SECTIONS = ['attendance', 'pay', 'overtime', 'leave', 'tillShortage'];
// Fractions allowed here; every other number is whole.
const DECIMAL = new Set(['attendance.lateRule.cutDays', 'pay.absentCutDays', 'pay.halfDayCut', 'overtime.rate', 'tillShortage.maxPerMonth']);
const MONEY_MAX = 10000000;

/** { path: { kind: 'number'|'boolean'|'enum', min, max, options, label, decimal } } from the schema. */
const LIMITS = Object.fromEntries(
  Object.entries(FIELDS).map(([path, label]) => {
    const t = HrPolicy.schema.path(path);
    if (!t) throw new Error(`hrPolicyRules: unknown policy path ${path}`);
    const o = t.options || {};
    if (t.instance === 'Boolean') return [path, { kind: 'boolean', label }];
    if (t.instance === 'String') return [path, { kind: 'enum', options: (o.enum || []).filter(Boolean), label }];
    return [path, { kind: 'number', min: o.min ?? 0, max: o.max ?? MONEY_MAX, decimal: DECIMAL.has(path), label }];
  })
);

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

function readValue(path, v) {
  const lim = LIMITS[path];
  if (lim.kind === 'boolean') {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw httpError(400, `${lim.label}: choose on or off`);
  }
  if (lim.kind === 'enum') {
    if (!lim.options.includes(v)) throw httpError(400, `${lim.label}: choose one of ${lim.options.join(', ')}`);
    return v;
  }
  const n = v === '' || v === null ? NaN : Number(v);
  if (!Number.isFinite(n) || n < lim.min || n > lim.max) throw httpError(400, `${lim.label} must be between ${lim.min} and ${lim.max}`);
  return lim.decimal ? Math.round(n * 100) / 100 : Math.round(n);
}

/** Validated rule values sent in the body: [[path, value], ...] (unknown keys are ignored). */
function readRules(body = {}) {
  const out = [];
  for (const path of Object.keys(FIELDS)) {
    const v = getPath(body, path);
    if (v !== undefined) out.push([path, readValue(path, v)]);
  }
  return out;
}

/** The rule sections of a new policy with the schema defaults (the owner's choices). */
function template() {
  const o = new HrPolicy({ name: 'New policy' }).toObject();
  return Object.fromEntries(SECTIONS.map((s) => [s, o[s]]));
}

// ---------- plain English ----------

const days = (n) => {
  const v = Number(n) || 0;
  if (v === 0.5) return 'half a day';
  if (v === 0.25) return 'a quarter day';
  return `${v} day${v === 1 ? '' : 's'}`;
};

/** Short phrases describing a policy (cards + editor). */
function summaryParts(p) {
  const a = p.attendance || {};
  const lr = a.lateRule || {};
  const pay = p.pay || {};
  const ot = p.overtime || {};
  const lv = p.leave || {};
  const ts = p.tillShortage || {};
  const parts = [];

  parts.push(Number(a.graceMinutes) ? `${a.graceMinutes} min grace` : 'no grace time');
  if (lr.type === 'count' && Number(lr.cutDays) > 0) parts.push(`every ${lr.latesPerCut} lates cut ${days(lr.cutDays)}`);
  else if (lr.type === 'minutes') parts.push('late minutes cut from pay');
  else parts.push('lates only noted (no cut)');

  const divisor = pay.dayDivisor === 'month_days' ? 'days in the month' : pay.dayDivisor === 'working_days' ? 'working days' : String(pay.fixedDays || 30);
  parts.push(Number(pay.absentCutDays) > 0 ? `absent cuts ${days(pay.absentCutDays)} (salary ÷ ${divisor})` : `absent not cut (day = salary ÷ ${divisor})`);

  if (ot.enabled) {
    const rate = Number(ot.rate) || 0;
    parts.push(`overtime ×${rate}${ot.needsApproval ? ' after approval' : ''}${Number(ot.minMinutes) ? ` (min ${ot.minMinutes} min)` : ''}`);
  } else parts.push('no overtime pay');

  const paid = Number(lv.paidPerMonth) || 0;
  const sick = Number(lv.sickPerMonth) || 0;
  parts.push(paid || sick ? `${paid} paid + ${sick} sick leave a month` : 'no paid leave');

  if (ts.deduct) {
    const cap = Number(ts.maxPerMonth) || 0;
    parts.push(`till shortage cut${ts.needsApproval ? ' after approval' : ''}${cap ? ` (max Rs ${cap.toLocaleString('en-PK')} a month)` : ''}`);
  } else parts.push('till shortage not cut');
  return parts;
}

const summarize = (p) => summaryParts(p).join(' · ');

module.exports = { FIELDS, SECTIONS, LIMITS, readRules, template, summaryParts, summarize };
