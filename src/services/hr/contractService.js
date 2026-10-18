// Contract letters: templates, rendering ({{placeholders}} -> safe HTML) and the
// "issued" record on the employee.
//
// Rendering is safe by construction: the template text AND every value are
// HTML-escaped; only our own tags (h2, h3, p, ul, strong, the signature block)
// are added afterwards. The page can show `html` with dangerouslySetInnerHTML.
const ContractTemplate = require('../../models/contractTemplate');
const Settings = require('../../models/settings');
const User = require('../../models/user');
const Branch = require('../../models/branch');
const config = require('../configService');
const employeeService = require('./employeeService');
const { DEFAULT_CONTRACT_NAME, DEFAULT_CONTRACT_BODY } = require('./defaultContract');
const { rupeesInWords } = require('./numberWords');
const u = require('./util');

const { httpError } = u;

const PLACEHOLDERS = [
  { key: 'employee.fullName', label: 'Employee full name' },
  { key: 'employee.firstName', label: 'First name' },
  { key: 'employee.code', label: 'Employee code (EMP-...)' },
  { key: 'employee.cnic', label: 'CNIC number' },
  { key: 'employee.fatherHusbandName', label: 'Father / husband name' },
  { key: 'employee.parentage', label: 'S/O, D/O or W/O + father / husband name' },
  { key: 'employee.address', label: 'Home address' },
  { key: 'employee.phone', label: 'Phone' },
  { key: 'employee.designation', label: 'Designation' },
  { key: 'employee.department', label: 'Department' },
  { key: 'employee.employmentType', label: 'Employment type (permanent, fixed-term contract...)' },
  { key: 'employee.joiningDate', label: 'Joining date' },
  { key: 'employee.probationEndDate', label: 'Probation end date' },
  { key: 'employee.salary', label: 'Gross monthly salary (Rs)' },
  { key: 'employee.salaryInWords', label: 'Gross salary in words' },
  { key: 'employee.basicSalary', label: 'Basic salary (Rs)' },
  { key: 'employee.allowances', label: 'Allowances, e.g. "Conveyance Rs 2,000"' },
  { key: 'employee.salaryPayDay', label: 'Salary pay day, e.g. "7th"' },
  { key: 'employee.salaryPaymentMethod', label: 'How salary is paid ("in cash", "by bank transfer")' },
  { key: 'employee.shift', label: 'Working hours, e.g. "10:00 AM to 10:00 PM"' },
  { key: 'employee.weeklyOff', label: 'Weekly off day(s)' },
  { key: 'contract.startDate', label: 'Contract start date' },
  { key: 'contract.endDate', label: 'Contract end date (or "no fixed end date")' },
  { key: 'contract.term', label: 'Term in words (fixed term / no fixed end date)' },
  { key: 'shop.name', label: 'Shop name' },
  { key: 'shop.address', label: 'Shop address' },
  { key: 'shop.phone', label: 'Shop phone' },
  { key: 'branch.name', label: 'Branch name' },
  { key: 'branch.address', label: 'Branch address' },
  { key: 'probationMonths', label: 'Probation length in months' },
  { key: 'today', label: "Today's date" },
  { key: 'signatures', label: 'Signature boxes (employer, employee, witness)' },
];
const KNOWN = new Set(PLACEHOLDERS.map((p) => p.key));

// ---------- formatting ----------

const TZ = 'Asia/Karachi';
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }) : '';
const fmtRs = (n) => `Rs ${(Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const fmtTime = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const joinList = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

const EMPLOYMENT_LABELS = {
  permanent: 'permanent',
  contract: 'fixed-term contract',
  probation: 'probation',
  part_time: 'part-time',
  daily_wage: 'daily-wage',
};
const PAY_METHOD = { cash: 'in cash', bank_transfer: 'by bank transfer', cheque: 'by cheque' };

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function monthsBetween(from, to) {
  if (!from || !to) return 0;
  const a = new Date(from);
  const b = new Date(to);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return Math.max(0, m);
}
const addMonths = (d, n) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};

// ---------- rendering ----------

/** Signature block (values are escaped here). */
function signaturesHtml(v) {
  const box = (title, lines) =>
    `<div class="sig"><div class="sig-title">${escapeHtml(title)}</div><div class="sig-line"></div>` +
    `<div class="sig-caption">Signature${title === 'Employee' ? ' / thumb impression' : ''}</div>` +
    lines.map(([k, val]) => `<div class="sig-row"><span>${escapeHtml(k)}:</span> ${val ? escapeHtml(val) : '<span class="blank"></span>'}</div>`).join('') +
    '</div>';
  return (
    '<div class="signatures">' +
    box('For the Employer', [['Name', ''], ['Designation', ''], ['On behalf of', v['shop.name']], ['Date', '']]) +
    box('Employee', [['Name', v['employee.fullName']], ['CNIC', v['employee.cnic']], ['Date', '']]) +
    box('Witness', [['Name', ''], ['CNIC', ''], ['Date', '']]) +
    '</div>'
  );
}

/**
 * Template text + values -> { html, missing, unknown }.
 * Markup: "# " heading, "## " sub-heading, "- " list item, **bold**,
 * blank line = new paragraph. `values` are plain strings (escaped here).
 */
function renderBody(body, values) {
  const missing = new Set();
  const unknown = new Set();
  const inline = (escapedLine) =>
    escapedLine
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (all, key) => {
        if (key === 'signatures') return all; // block-level only
        if (!KNOWN.has(key)) {
          unknown.add(key);
          return `<span class="ph-unknown">{{${key}}}</span>`;
        }
        const val = values[key];
        if (val === undefined || val === null || String(val).trim() === '') {
          missing.add(key);
          return '<span class="blank"></span>';
        }
        return escapeHtml(val).replace(/\n/g, '<br>');
      });

  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = [];
  };

  const lines = escapeHtml(String(body || '').replace(/\r\n?/g, '\n')).split('\n');
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushPara();
      flushList();
    } else if (/^\{\{\s*signatures\s*\}\}$/.test(t)) {
      flushPara();
      flushList();
      out.push(signaturesHtml(values));
    } else if (t.startsWith('## ')) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(t.slice(3))}</h3>`);
    } else if (t.startsWith('# ')) {
      flushPara();
      flushList();
      out.push(`<h2>${inline(t.slice(2))}</h2>`);
    } else if (/^[-*] /.test(t)) {
      flushPara();
      list.push(t.slice(2));
    } else {
      flushList();
      para.push(t);
    }
  }
  flushPara();
  flushList();
  return { html: out.join('\n'), missing: [...missing], unknown: [...unknown] };
}

/** Shop + branch details for the letterhead. */
async function letterhead(branchId) {
  const [settings, branch] = await Promise.all([
    Settings.findOne({ isActive: true }).select('siteName address mobileNumber logoUrl').lean(),
    branchId ? Branch.findById(branchId).select('name code address phone').lean() : u.mainBranchId().then((id) => (id ? Branch.findById(id).select('name code address phone').lean() : null)),
  ]);
  return {
    shopName: settings?.siteName || 'Our Shop',
    shopAddress: settings?.address || '',
    shopPhone: settings?.mobileNumber || '',
    logoUrl: settings?.logoUrl || '',
    branchName: branch?.name || '',
    branchCode: branch?.code || '',
    branchAddress: branch?.address || settings?.address || '',
    branchPhone: branch?.phone || settings?.mobileNumber || '',
  };
}

/** All placeholder values for one employee (plain strings). */
async function buildValues(emp, head, { startDate, endDate } = {}) {
  const e = typeof emp.toObject === 'function' ? emp.toObject() : emp;
  const fullName = `${e.firstName || ''} ${e.lastName || ''}`.trim();
  const joining = e.joiningDate || e.hireDate || null;
  const start = startDate || e.contractStartDate || joining;
  const end = endDate || e.contractEndDate || null;

  const defaultProbation = Number(await config.get('hr.probationMonths', 3)) || 3;
  const probationMonths = e.probationEndDate && joining ? Math.max(1, monthsBetween(joining, e.probationEndDate)) : defaultProbation;
  const probationEnd = e.probationEndDate || (joining ? addMonths(joining, probationMonths) : null);

  const b = e.salaryBreakdown || {};
  const allowances = (b.allowances || []).filter((a) => a && a.name);
  const basic = Number(b.basic) || (allowances.length ? 0 : Number(e.salary) || 0);

  const a = e.address || {};
  const address = [a.street, a.city, a.state].filter(Boolean).join(', ');
  const prefix = e.gender === 'female' ? (e.maritalStatus === 'married' || e.maritalStatus === 'widowed' ? 'W/O' : 'D/O') : e.gender === 'male' ? 'S/O' : 'S/O / D/O';
  const shift = e.shift?.start && e.shift?.end ? `${fmtTime(e.shift.start)} to ${fmtTime(e.shift.end)}` : '';
  const off = (e.weeklyOff || []).map(cap);

  return {
    'employee.fullName': fullName,
    'employee.firstName': e.firstName || '',
    'employee.code': e.employeeCode || '',
    'employee.cnic': e.cnic || '',
    'employee.fatherHusbandName': e.fatherHusbandName || '',
    'employee.parentage': e.fatherHusbandName ? `${prefix} ${e.fatherHusbandName}` : '',
    'employee.address': address,
    'employee.phone': e.phone || '',
    'employee.designation': e.designation || e.position || '',
    'employee.department': e.department || '',
    'employee.employmentType': EMPLOYMENT_LABELS[e.employmentType] || 'permanent',
    'employee.joiningDate': fmtDate(joining),
    'employee.probationEndDate': fmtDate(probationEnd),
    'employee.salary': e.salary ? fmtRs(e.salary) : '',
    'employee.salaryInWords': e.salary ? rupeesInWords(e.salary) : '',
    'employee.basicSalary': basic ? fmtRs(basic) : '',
    'employee.allowances': allowances.length ? allowances.map((x) => `${x.name} ${fmtRs(x.amount)}`).join(', ') : 'none',
    'employee.salaryPayDay': ordinal(e.salaryPayDay || 7),
    'employee.salaryPaymentMethod': PAY_METHOD[e.salaryPaymentMethod] || PAY_METHOD.cash,
    'employee.shift': shift,
    'employee.weeklyOff': off.length ? joinList(off) : '',
    'contract.startDate': fmtDate(start),
    'contract.endDate': end ? fmtDate(end) : 'no fixed end date',
    'contract.term': end
      ? `a fixed term from ${fmtDate(start)} to ${fmtDate(end)}`
      : 'no fixed end date; the Contract continues until ended under the termination clause',
    'shop.name': head.shopName,
    'shop.address': head.shopAddress,
    'shop.phone': head.shopPhone,
    'branch.name': head.branchName,
    'branch.address': head.branchAddress,
    probationMonths: String(probationMonths),
    today: fmtDate(new Date()),
  };
}

// ---------- templates ----------

const BUILTIN = { _id: 'builtin', name: DEFAULT_CONTRACT_NAME, body: DEFAULT_CONTRACT_BODY, isDefault: false, builtin: true };

/** templateId: id | 'builtin' | empty (= the default template, else built-in). */
async function resolveTemplate(templateId) {
  if (templateId === 'builtin') return BUILTIN;
  if (templateId) {
    if (!u.isId(templateId)) throw httpError(404, 'Template not found');
    const t = await ContractTemplate.findById(templateId).lean();
    if (!t) throw httpError(404, 'Template not found');
    return t;
  }
  const def = await ContractTemplate.findOne({ isDefault: true }).sort({ updatedAt: -1 }).lean();
  return def || BUILTIN;
}

const requireEditor = (req) => {
  if (!employeeService.canSeeSensitive(req)) {
    throw httpError(403, 'Contract letters show salary and CNIC: you need permission to edit employees');
  }
};

async function render(req, id) {
  requireEditor(req);
  const emp = await employeeService.load(req, id);
  const q = req.query || {};
  const tpl = await resolveTemplate(q.templateId);
  const head = await letterhead(emp.branch);
  const values = await buildValues(emp, head, { startDate: u.date(q.startDate, 'start date'), endDate: u.date(q.endDate, 'end date') });
  const { html, missing, unknown } = renderBody(tpl.body, values);
  const labels = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.label]));
  return {
    html,
    template: { _id: tpl._id, name: tpl.name, builtin: !!tpl.builtin },
    letterhead: head,
    employee: { _id: emp._id, name: values['employee.fullName'], employeeCode: emp.employeeCode },
    missing: missing.map((key) => ({ key, label: labels[key] || key })),
    unknown,
  };
}

async function issue(req, id) {
  requireEditor(req);
  const emp = await employeeService.load(req, id);
  const body = req.body || {};
  const tpl = await resolveTemplate(body.templateId);
  const me = await User.findById(req.access.userId).select('firstName lastName email').lean();
  const startDate = u.date(body.startDate, 'start date') || emp.contractStartDate || emp.joiningDate || null;
  const endDate = u.date(body.endDate, 'end date') || emp.contractEndDate || null;
  emp.contractsIssued.push({
    issuedAt: new Date(),
    templateId: tpl.builtin ? null : tpl._id,
    templateName: tpl.name,
    startDate,
    endDate,
    salary: emp.salary || 0,
    designation: emp.designation || emp.position || '',
    issuedBy: req.access.userId,
    issuedByName: u.userName(me),
    note: u.str(body.note, 500) || '',
  });
  emp.history.push({ by: req.access.userId, action: 'contract_issued', note: tpl.name });
  emp.updatedBy = req.access.userId;
  await emp.save();
  return { contractsIssued: emp.contractsIssued.map((c) => c.toObject()) };
}

function readTemplateBody(body = {}, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = u.str(body.name, 120);
    if (!out.name) throw httpError(400, 'Template name is required');
  }
  if (!partial || body.body !== undefined) {
    out.body = String(body.body || '').replace(/\r\n?/g, '\n');
    if (!out.body.trim()) throw httpError(400, 'Template text is required');
    if (out.body.length > 50000) throw httpError(400, 'Template text is too long (max 50,000 characters)');
  }
  if (body.isDefault !== undefined) out.isDefault = body.isDefault === true || body.isDefault === 'true';
  return out;
}

async function makeOnlyDefault(id) {
  await ContractTemplate.updateMany({ _id: { $ne: id }, isDefault: true }, { $set: { isDefault: false } });
}

async function listTemplates(req) {
  const p = u.paging(req.query || {}, 50);
  const [rows, total] = await Promise.all([
    ContractTemplate.find({}).sort({ isDefault: -1, name: 1 }).skip(p.skip).limit(p.limit).lean(),
    ContractTemplate.countDocuments({}),
  ]);
  return {
    data: rows,
    meta: { ...u.pageMeta(p, total), placeholders: PLACEHOLDERS, builtin: { name: BUILTIN.name, body: BUILTIN.body } },
  };
}

async function getTemplate(id) {
  if (id === 'builtin') return BUILTIN;
  if (!u.isId(id)) throw httpError(404, 'Template not found');
  const t = await ContractTemplate.findById(id).lean();
  if (!t) throw httpError(404, 'Template not found');
  return t;
}

async function createTemplate(req) {
  const fields = readTemplateBody(req.body, { partial: false });
  // The first template becomes the default one.
  if (!(await ContractTemplate.exists({ isDefault: true }))) fields.isDefault = true;
  const t = await ContractTemplate.create({ ...fields, createdBy: req.access.userId, updatedBy: req.access.userId });
  if (t.isDefault) await makeOnlyDefault(t._id);
  return t.toObject();
}

async function updateTemplate(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Template not found');
  const t = await ContractTemplate.findById(id);
  if (!t) throw httpError(404, 'Template not found');
  t.set(readTemplateBody(req.body, { partial: true }));
  t.updatedBy = req.access.userId;
  await t.save();
  if (t.isDefault) await makeOnlyDefault(t._id);
  return t.toObject();
}

async function removeTemplate(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Template not found');
  const t = await ContractTemplate.softDeleteById(id, req.access.userId);
  if (!t) throw httpError(404, 'Template not found');
  return { _id: t._id, deleted: true };
}

module.exports = {
  PLACEHOLDERS,
  renderBody,
  escapeHtml,
  buildValues,
  render,
  issue,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  removeTemplate,
};
