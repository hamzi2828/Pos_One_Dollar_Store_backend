// Employees: complete HR record, documents, status changes.
// Salary, bank details and CNIC (incl. CNIC scans) are only returned to users
// who may EDIT employees; view-only users get the rest (see serialize()).
const Employee = require('../../models/employee');
const User = require('../../models/user');
const staffService = require('../staffService');
const u = require('./util');

const { httpError } = u;

const POPULATE = [
  { path: 'branch', select: 'name code address phone' },
  { path: 'user', select: 'firstName lastName email isActive staffRole', populate: { path: 'staffRole', select: 'name' } },
];

const canSeeSensitive = (req) => !!req.access?.can('employees', 'edit');
const fullName = (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim();

// ---------- output ----------

const SENSITIVE = ['salary', 'salaryBreakdown', 'salaryPayDay', 'salaryPaymentMethod', 'dailyRate', 'bankDetails', 'cnic', 'cnicExpiry'];
const CNIC_DOCS = ['cnic_front', 'cnic_back'];

/** Plain object for the API; strips salary / bank / CNIC for view-only users. */
function serialize(doc, { sensitive }) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  delete o.id;
  delete o.__v;
  o.name = fullName(o);
  if (o.user && typeof o.user === 'object' && o.user.staffRole !== undefined) {
    // Linked staff login: role as id + name.
    const role = o.user.staffRole;
    o.user = { ...o.user, staffRole: role && role._id ? role._id : role || null, roleName: (role && role.name) || null };
  }
  if (!o.status) o.status = o.isActive === false ? 'terminated' : 'active'; // old rows (lean reads skip defaults)
  if (!sensitive) {
    for (const k of SENSITIVE) delete o[k];
    if (o.guarantor) {
      o.guarantor = { ...o.guarantor };
      delete o.guarantor.cnic;
    }
    o.documents = (o.documents || []).filter((d) => !CNIC_DOCS.includes(d.type));
    o.contractsIssued = (o.contractsIssued || []).map((c) => {
      const copy = { ...c };
      delete copy.salary;
      return copy;
    });
  }
  o.sensitiveHidden = !sensitive;
  return o;
}

// ---------- input ----------

const pickEnum = (v, list, label) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!list.includes(v)) throw httpError(400, `Invalid ${label}`);
  return v;
};

/**
 * Body -> $set-able fields (only the keys that were sent). Throws 400 on bad
 * values. `partial` = update (missing keys are left alone).
 */
function readBody(body = {}, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const set = (k, fn) => {
    if (has(k)) out[k] = fn(body[k]);
  };

  set('firstName', (v) => u.str(v, 80));
  set('lastName', (v) => u.str(v, 80) || '');
  if (!partial || has('firstName')) {
    if (!out.firstName) throw httpError(400, 'First name is required');
  }

  // Personal
  set('phone', (v) => u.str(v, 40));
  set('email', (v) => {
    const s = u.str(v, 120);
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw httpError(400, 'Invalid email address');
    return s ? s.toLowerCase() : null;
  });
  set('cnic', (v) => u.cnic(v));
  set('cnicExpiry', (v) => u.date(v, 'CNIC expiry date'));
  set('fatherHusbandName', (v) => u.str(v, 120));
  set('dateOfBirth', (v) => u.date(v, 'date of birth'));
  set('gender', (v) => pickEnum(v, ['male', 'female', 'other'], 'gender'));
  set('maritalStatus', (v) => pickEnum(v, Employee.MARITAL_STATUSES, 'marital status'));
  set('qualification', (v) => u.str(v, 200));
  set('experience', (v) => u.str(v, 500));
  set('previousEmployer', (v) => u.str(v, 200));
  if (has('address')) {
    const a = body.address || {};
    out.address = {
      street: u.str(a.street, 300),
      city: u.str(a.city, 80),
      state: u.str(a.state, 80),
      zipCode: u.str(a.zipCode, 20),
      country: u.str(a.country, 80) || 'Pakistan',
    };
  }

  // Job
  set('designation', (v) => u.str(v, 120));
  if (!has('designation') && has('position')) out.designation = u.str(body.position, 120);
  if (out.designation !== undefined) out.position = out.designation; // legacy mirror
  set('department', (v) => u.str(v, 120));
  set('employmentType', (v) => pickEnum(v, Employee.EMPLOYMENT_TYPES, 'employment type') || 'permanent');
  set('joiningDate', (v) => u.date(v, 'joining date'));
  if (!has('joiningDate') && has('hireDate')) out.joiningDate = u.date(body.hireDate, 'joining date');
  set('probationEndDate', (v) => u.date(v, 'probation end date'));
  set('contractStartDate', (v) => u.date(v, 'contract start date'));
  set('contractEndDate', (v) => u.date(v, 'contract end date'));
  if (out.contractStartDate && out.contractEndDate && out.contractEndDate < out.contractStartDate) {
    throw httpError(400, 'Contract end date is before the start date');
  }
  if (has('shift')) {
    const s = body.shift || {};
    out.shift = { start: u.time(s.start, 'shift start'), end: u.time(s.end, 'shift end') };
  }
  set('weeklyOff', (v) => {
    const list = (Array.isArray(v) ? v : v ? [v] : []).map((d) => String(d).toLowerCase());
    if (list.some((d) => !Employee.DAYS.includes(d))) throw httpError(400, 'Invalid weekly off day');
    return [...new Set(list)];
  });

  // Salary
  if (has('salaryBreakdown')) {
    const b = body.salaryBreakdown || {};
    const allowances = (Array.isArray(b.allowances) ? b.allowances : [])
      .filter((a) => a && (u.str(a.name) || Number(a.amount)))
      .map((a) => {
        const name = u.str(a.name, 60);
        if (!name) throw httpError(400, 'Each allowance needs a name');
        return { name, amount: u.money(a.amount, `Allowance "${name}"`) || 0 };
      });
    out.salaryBreakdown = { basic: u.money(b.basic, 'Basic salary') || 0, allowances };
  }
  set('salary', (v) => u.money(v, 'Salary') || 0);
  set('salaryPayDay', (v) => {
    if (v === null || v === '') return 7;
    const n = parseInt(v, 10);
    if (!(n >= 1 && n <= 28)) throw httpError(400, 'Salary pay day must be between 1 and 28');
    return n;
  });
  set('salaryPaymentMethod', (v) => pickEnum(v, ['cash', 'bank_transfer', 'cheque'], 'salary payment method') || 'cash');
  if (has('bankDetails')) {
    const b = body.bankDetails || {};
    out.bankDetails = {
      accountTitle: u.str(b.accountTitle, 120),
      accountNumber: u.str(b.accountNumber, 40),
      bankName: u.str(b.bankName, 120),
      iban: u.str(b.iban, 40) ? u.str(b.iban, 40).replace(/\s+/g, '').toUpperCase() : null,
    };
  }

  // Guarantor & emergency
  if (has('guarantor')) {
    const g = body.guarantor || {};
    out.guarantor = {
      name: u.str(g.name, 120),
      cnic: u.cnic(g.cnic, 'Guarantor CNIC'),
      phone: u.str(g.phone, 40),
      relation: u.str(g.relation, 60),
      address: u.str(g.address, 300),
    };
  }
  if (has('emergencyContact')) {
    const e = body.emergencyContact || {};
    out.emergencyContact = {
      name: u.str(e.name, 120),
      phone: u.str(e.phone, 40),
      relationship: u.str(e.relationship ?? e.relation, 60),
    };
  }

  set('notes', (v) => u.str(v, 3000));
  return out;
}

/** The linked login must be a staff user that is not linked to someone else. */
async function checkUserLink(userId, selfId = null) {
  if (userId === undefined) return undefined;
  if (!userId) return null;
  if (!u.isId(userId)) throw httpError(400, 'Invalid staff login');
  const user = await User.findById(userId).select('role').lean();
  if (!user || user.role !== 'admin') throw httpError(400, 'Staff login not found');
  const taken = await Employee.findOne({ user: userId, isDeleted: { $ne: true }, ...(selfId ? { _id: { $ne: selfId } } : {}) })
    .select('firstName lastName employeeCode')
    .lean();
  if (taken) throw httpError(409, `That staff login is already linked to ${fullName(taken)} (${taken.employeeCode})`);
  return userId;
}

async function checkCnicUnique(cnicValue, selfId = null) {
  if (!cnicValue) return;
  const dup = await Employee.findOne({ cnic: cnicValue, isDeleted: { $ne: true }, ...(selfId ? { _id: { $ne: selfId } } : {}) })
    .select('firstName lastName employeeCode')
    .lean();
  if (dup) throw httpError(409, `Another employee already has this CNIC: ${fullName(dup)} (${dup.employeeCode || 'no code'})`, 'DUPLICATE_CNIC');
}

// ---------- queries ----------

/** Load one employee the caller may see (404 otherwise). */
async function load(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Employee not found');
  const emp = await Employee.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!emp) throw httpError(404, 'Employee not found');
  return emp;
}

async function list(req) {
  const q = req.query || {};
  const sensitive = canSeeSensitive(req);
  const and = [{ isDeleted: { $ne: true } }];

  const statuses = String(q.status || '').split(',').map((s) => s.trim()).filter((s) => Employee.STATUSES.includes(s));
  if (statuses.length) {
    // Old rows have no status, only isActive.
    const or = [{ status: { $in: statuses } }];
    if (statuses.includes('active')) or.push({ status: { $exists: false }, isActive: { $ne: false } });
    if (statuses.includes('terminated')) or.push({ status: { $exists: false }, isActive: false });
    and.push({ $or: or });
  }
  if (q.isActive === 'true' || q.isActive === 'false') and.push({ isActive: q.isActive === 'true' });
  if (q.department) and.push({ department: u.containsRe(q.department) });
  if (Employee.EMPLOYMENT_TYPES.includes(q.employmentType)) and.push({ employmentType: q.employmentType });

  // Every word must match a name / code / phone / designation (or CNIC for editors).
  const words = String(q.search || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const re = u.containsRe(w);
    const or = [{ firstName: re }, { lastName: re }, { employeeCode: re }, { phone: re }, { designation: re }, { department: re }];
    if (sensitive) {
      or.push({ cnic: re });
      const digits = w.replace(/-/g, '');
      if (/^\d{13}$/.test(digits)) or.push({ cnic: u.cnic(digits) });
    }
    and.push({ $or: or });
  }

  const filter = { $and: and };
  const p = u.paging(q);
  const sortable = { createdAt: 'createdAt', name: 'firstName', joiningDate: 'joiningDate', code: 'employeeCode', status: 'status' };
  if (sensitive) sortable.salary = 'salary';
  const sort = u.sortOf(q.sort, sortable, { createdAt: -1, _id: -1 });

  const [rows, total, departments] = await Promise.all([
    Employee.find(filter).select('-history').sort(sort).skip(p.skip).limit(p.limit).populate(POPULATE).lean(),
    Employee.countDocuments(filter),
    Employee.distinct('department', { isDeleted: { $ne: true } }),
  ]);
  return {
    data: rows.map((r) => serialize(r, { sensitive })),
    meta: { ...u.pageMeta(p, total), departments: departments.filter(Boolean).sort(), canSeeSensitive: sensitive },
  };
}

async function get(req, id) {
  const emp = await load(req, id);
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

async function create(req) {
  const body = req.body || {};
  const fields = readBody(body, { partial: false });
  const branch = await u.shopBranch(req);
  await checkCnicUnique(fields.cnic);
  const user = await checkUserLink(body.user);

  const emp = new Employee({
    ...fields,
    branch,
    user: user || null,
    joiningDate: fields.joiningDate || new Date(),
    createdBy: req.access.userId,
    updatedBy: req.access.userId,
    history: [{ by: req.access.userId, action: 'created', note: '' }],
  });
  if (body.status && Employee.STATUSES.includes(body.status)) emp.status = body.status;
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

async function update(req, id) {
  const emp = await load(req, id);
  const body = req.body || {};
  const fields = readBody(body, { partial: true });
  if (fields.cnic !== undefined) await checkCnicUnique(fields.cnic, emp._id);

  const user = await checkUserLink(body.user, emp._id);
  if (user !== undefined) emp.user = user;

  // (A breakdown with basic 0 and no allowances keeps `salary` as the gross.)
  emp.set(fields);
  emp.updatedBy = req.access.userId;
  emp.history.push({ by: req.access.userId, action: 'updated', note: '' });
  if (emp.history.length > 200) emp.history = emp.history.slice(-200);
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

/** active | on_leave | resigned | terminated, with exit date / reason when leaving. */
async function setStatus(req, id) {
  const emp = await load(req, id);
  const { status, date, reason, note } = req.body || {};
  if (!Employee.STATUSES.includes(status)) throw httpError(400, 'Status must be active, on_leave, resigned or terminated');
  const leaving = status === 'resigned' || status === 'terminated';
  if (leaving) {
    emp.exitDate = u.date(date, 'exit date') || new Date();
    emp.exitReason = u.str(reason, 500);
  } else {
    emp.exitDate = null;
    emp.exitReason = null;
  }
  const from = emp.status;
  emp.status = status;
  emp.updatedBy = req.access.userId;
  emp.history.push({ by: req.access.userId, action: `status:${from}->${status}`, note: u.str(note || reason, 500) || '' });
  await emp.save();
  await emp.populate(POPULATE);
  const out = serialize(emp, { sensitive: canSeeSensitive(req) });
  // Reminder for the UI: the staff login is managed on the Staff Logins page.
  out.linkedLoginStillActive = leaving && !!(emp.user && emp.user.isActive !== false);
  return out;
}

async function remove(req, id) {
  const emp = await load(req, id);
  emp.isDeleted = true;
  emp.deletedAt = new Date();
  emp.deletedBy = req.access.userId;
  emp.history.push({ by: req.access.userId, action: 'deleted', note: '' });
  await emp.save({ validateBeforeSave: false });
  return { _id: emp._id, deleted: true };
}

// ---------- files ----------

async function setPhoto(req, id, urls) {
  const emp = await load(req, id);
  if (!urls.length) throw httpError(400, 'Choose a photo to upload');
  emp.photo = urls[0];
  emp.documents.push({ type: 'photo', name: 'Photo', url: urls[0], uploadedBy: req.access.userId });
  emp.updatedBy = req.access.userId;
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

async function addDocuments(req, id, urls) {
  const emp = await load(req, id);
  if (!urls.length) throw httpError(400, 'Choose at least one file to upload');
  const type = Employee.DOCUMENT_TYPES.includes(req.body?.type) ? req.body.type : 'other';
  const name = u.str(req.body?.name, 120) || '';
  for (const url of urls) emp.documents.push({ type, name, url, uploadedBy: req.access.userId });
  const firstImage = urls.find((x) => !/\.pdf($|\?)/i.test(x));
  if (type === 'photo' && !emp.photo && firstImage) emp.photo = firstImage;
  emp.updatedBy = req.access.userId;
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

async function removeDocument(req, id, docId) {
  const emp = await load(req, id);
  const doc = emp.documents.id(docId);
  if (!doc) throw httpError(404, 'Document not found');
  if (emp.photo === doc.url) emp.photo = null;
  doc.deleteOne();
  emp.updatedBy = req.access.userId;
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

// ---------- staff login ----------

/**
 * POST /employees/:id/login { email, password, roleId } — create a staff login
 * (same rules as /admin/staff, services/staffService.js) and link it.
 * 409 when the employee already has a login or the e-mail is taken.
 */
async function createLogin(req, id) {
  const emp = await load(req, id);
  if (emp.user) throw httpError(409, 'This employee already has a staff login', 'LOGIN_EXISTS');
  const body = req.body || {};
  const user = await staffService.createStaffUser(req.access, {
    firstName: emp.firstName,
    lastName: emp.lastName,
    email: body.email,
    password: body.password,
    phone: emp.phone,
    staffRole: body.roleId,
  });
  // Link only if nobody linked a login meanwhile (two clicks at once).
  const linked = await Employee.updateOne(
    { _id: emp._id, user: null },
    {
      $set: { user: user._id, updatedBy: req.access.userId },
      $push: { history: { $each: [{ by: req.access.userId, action: 'login_created', note: user.email }], $slice: -200 } },
    }
  );
  if (!linked.modifiedCount) {
    await User.deleteOne({ _id: user._id });
    await staffService.syncRoleUserCount([user.staffRole]);
    throw httpError(409, 'This employee already has a staff login', 'LOGIN_EXISTS');
  }
  return get(req, emp._id);
}

/** DELETE /employees/:id/login — unlink the staff login (the login itself stays). */
async function removeLogin(req, id) {
  const emp = await load(req, id);
  if (!emp.user) throw httpError(400, 'This employee has no staff login');
  emp.user = null;
  emp.updatedBy = req.access.userId;
  emp.history.push({ by: req.access.userId, action: 'login_unlinked', note: '' });
  await emp.save();
  await emp.populate(POPULATE);
  return serialize(emp, { sensitive: canSeeSensitive(req) });
}

/** Staff logins that can be linked (not linked to another employee). */
async function linkableUsers(req) {
  const q = req.query || {};
  // Real staff logins only (a permission role, not the super admin).
  const and = [{ role: 'admin', staffRole: { $ne: null }, isActive: { $ne: false }, isSuperAdmin: { $ne: true } }];
  const words = String(q.search || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
  for (const w of words) {
    const re = u.containsRe(w);
    and.push({ $or: [{ firstName: re }, { lastName: re }, { email: re }] });
  }
  const linked = await Employee.distinct('user', {
    isDeleted: { $ne: true },
    user: { $ne: null },
    ...(u.isId(q.employeeId) ? { _id: { $ne: q.employeeId } } : {}),
  });
  and.push({ _id: { $nin: linked } });
  const users = await User.find({ $and: and }).select('firstName lastName email').sort({ firstName: 1 }).limit(50).lean();
  return users.map((x) => ({ _id: x._id, name: u.userName(x), email: x.email }));
}

module.exports = {
  serialize,
  canSeeSensitive,
  load,
  list,
  get,
  create,
  update,
  setStatus,
  remove,
  setPhoto,
  addDocuments,
  removeDocument,
  createLogin,
  removeLogin,
  linkableUsers,
};
