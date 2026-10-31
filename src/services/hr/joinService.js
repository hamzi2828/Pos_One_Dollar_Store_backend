// Public employee "join" link + the applications it collects.
//
// The owner shares https://<frontend>/join/<token>. Anyone with the link can
// send their personal details, photo and documents (no login). The result is an
// EmployeeApplication that waits in HR; approving it creates the Employee
// through employeeService.create (same code, validation and history).
//
// Link settings live in AppConfig key "hr.joinLink" = { token, enabled }.
// Read straight from the DB (no 30 s config cache) so a regenerated / switched
// off link stops working at once on every serverless instance.
const crypto = require('crypto');
const fs = require('fs');
const AppConfig = require('../../models/appConfig');
const Settings = require('../../models/settings');
const User = require('../../models/user');
const Employee = require('../../models/employee');
const EmployeeApplication = require('../../models/employeeApplication');
const config = require('../configService');
const { nextNumber } = require('../sequenceService');
const notificationService = require('../notificationService');
const { saveUploads } = require('../../helper/storeUpload');
const employeeService = require('./employeeService');
const u = require('./util');

const { httpError } = u;

const LINK_KEY = 'hr.joinLink';
const INVALID_LINK = 'This link is not valid any more. Ask the shop for a new one.';

// Personal fields an applicant may send. Everything else is dropped.
const PERSONAL = [
  'firstName', 'lastName', 'fatherHusbandName', 'phone', 'email', 'cnic', 'cnicExpiry', 'dateOfBirth',
  'gender', 'maritalStatus', 'qualification', 'experience', 'previousEmployer',
  'address', 'emergencyContact', 'guarantor', 'bankDetails',
];
const NESTED = ['address', 'emergencyContact', 'guarantor', 'bankDetails'];

// ---------- link settings ----------

const newToken = () => crypto.randomBytes(24).toString('base64url');

// Every "Join link" open makes a fresh link (owner, 2026-10-31); links already
// shared keep working. Stored: { token: newest, tokens: [all working], enabled }.
const MAX_LINKS = 2000;

async function readLink() {
  const doc = await AppConfig.findOne({ key: LINK_KEY }).lean();
  const v = doc && doc.value;
  if (!v || !v.token) return null;
  const tokens = Array.isArray(v.tokens) && v.tokens.length ? v.tokens : [v.token];
  return { token: v.token, tokens, enabled: v.enabled !== false };
}

async function writeLink(value, userId) {
  await config.set(LINK_KEY, { token: value.token, tokens: value.tokens, enabled: value.enabled }, userId);
  return { token: value.token, enabled: value.enabled, activeLinks: value.tokens.length };
}

const shown = (link) => ({ token: link.token, enabled: link.enabled, activeLinks: link.tokens.length });

/** GET /employee-join-link — the newest link (made on first call). */
async function getLink(req) {
  const link = await readLink();
  if (link) return shown(link);
  const token = newToken();
  return writeLink({ token, tokens: [token], enabled: true }, req.access.userId);
}

/**
 * POST /employee-join-link/regenerate — a new link; older links keep working.
 * { blockOld: true } stops every older link (shared with the wrong person).
 */
async function regenerateLink(req) {
  const link = await readLink();
  const token = newToken();
  const blockOld = !!(req.body && req.body.blockOld);
  const tokens = blockOld || !link ? [token] : [...link.tokens, token].slice(-MAX_LINKS);
  return writeLink({ token, tokens, enabled: link ? link.enabled : true }, req.access.userId);
}

async function setEnabled(req) {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
  const link = await readLink();
  if (!link) {
    const token = newToken();
    return writeLink({ token, tokens: [token], enabled }, req.access.userId);
  }
  return writeLink({ token: link.token, tokens: link.tokens, enabled }, req.access.userId);
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** 404 unless `token` is one of the working links and links are switched on. */
async function checkToken(token) {
  const link = await readLink();
  if (!link || !link.enabled || !link.tokens.some((t) => sameToken(token, t))) throw httpError(404, INVALID_LINK, 'INVALID_LINK');
}

async function shopName() {
  const s = await Settings.findOne({ isActive: true }).select('siteName').lean().catch(() => null);
  return (s && s.siteName) || 'DOLLAR & Co';
}

/** GET /public/join/:token */
async function publicInfo(token) {
  await checkToken(token);
  return { shopName: await shopName(), open: true };
}

// ---------- public submit ----------

/** multipart body -> plain payload. `data` (JSON string) wins; dotted names are nested. */
function readPayload(body = {}) {
  if (body.data !== undefined && body.data !== '') {
    let parsed;
    try {
      parsed = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
    } catch {
      throw httpError(400, 'Could not read the form. Please try again.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, 'Could not read the form. Please try again.');
    return { ...parsed, website: parsed.website ?? body.website };
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const dot = k.indexOf('.');
    if (dot > 0) {
      const parent = k.slice(0, dot);
      const child = k.slice(dot + 1);
      if (!out[parent] || typeof out[parent] !== 'object') out[parent] = {};
      out[parent][child] = v;
    } else if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') {
      Object.assign(out[k], v); // bracket names parsed by multer
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Whitelisted + validated personal fields (same rules as the employee form). */
function cleanPersonal(payload) {
  const picked = {};
  for (const k of PERSONAL) {
    if (payload[k] === undefined) continue;
    if (NESTED.includes(k)) picked[k] = payload[k] && typeof payload[k] === 'object' && !Array.isArray(payload[k]) ? payload[k] : {};
    else picked[k] = typeof payload[k] === 'object' && payload[k] !== null ? '' : payload[k];
  }
  if (!u.str(picked.firstName)) throw httpError(400, 'Please enter your name');
  if (!u.str(picked.phone)) throw httpError(400, 'Please enter your phone number');
  const fields = employeeService.readBody(picked, { partial: false });
  // readBody fills job/salary keys only when sent; keep personal ones only.
  const out = {};
  for (const k of PERSONAL) if (fields[k] !== undefined) out[k] = fields[k];
  return out;
}

const uploadedFiles = (req) => {
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return req.file ? [req.file] : [];
};

/** Remove files multer already wrote to /uploads (local mode) when we do not keep them. */
function discardUploads(req) {
  for (const f of uploadedFiles(req)) {
    if (f.path) fs.unlink(f.path, () => {});
  }
}

async function checkCnicFree(cnic) {
  if (!cnic) return;
  const emp = await Employee.findOne({ cnic, isDeleted: { $ne: true }, status: { $in: Employee.ACTIVE_STATUSES } }).select('_id').lean();
  if (emp) throw httpError(409, 'This CNIC is already registered as an employee', 'CNIC_EMPLOYEE');
  const app = await EmployeeApplication.findOne({ cnic, status: 'pending' }).select('_id').lean();
  if (app) throw httpError(409, 'An application with this CNIC is already waiting', 'CNIC_PENDING');
}

const clientIp = (req) => {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || null;
};

/** POST /public/join/:token -> { reference } */
async function submit(req, token) {
  try {
    await checkToken(token);
    const payload = readPayload(req.body || {});

    // Honeypot: bots fill every field. Pretend it worked, keep nothing.
    if (u.str(payload.website)) {
      discardUploads(req);
      return { reference: `APP-${String(Math.floor(1000 + Math.random() * 9000))}` };
    }

    const fields = cleanPersonal(payload);
    const photoFile = (req.files && req.files.photo && req.files.photo[0]) || null;
    if (photoFile && photoFile.mimetype === 'application/pdf') throw httpError(400, 'Your photo must be a picture (JPG or PNG), not a PDF');
    await checkCnicFree(fields.cnic);

    const [photo] = photoFile ? await saveUploads(req, 'hr/applications', 'photo') : [];
    const docFiles = (req.files && req.files.files) || [];
    const docUrls = docFiles.length ? await saveUploads(req, 'hr/applications', 'files') : [];
    const files = docUrls.map((url, i) => ({
      url,
      name: u.str(docFiles[i] && docFiles[i].originalname, 120) || `Document ${i + 1}`,
      type: docFiles[i] && docFiles[i].mimetype === 'application/pdf' ? 'pdf' : 'image',
    }));

    const reference = await nextNumber('APP', { yearly: false, pad: 4 });
    const app = await EmployeeApplication.create({
      ...fields,
      reference,
      status: 'pending',
      photo: photo || null,
      files,
      ip: clientIp(req),
      userAgent: u.str(req.headers['user-agent'], 300),
    });

    // Best effort: tell people who manage employees.
    notificationService
      .notify({
        type: 'employee_application',
        title: 'New job application',
        message: `${`${app.firstName} ${app.lastName || ''}`.trim()} sent an application (${reference}).`,
        link: '/admin/hr/employees?tab=applications',
        audience: 'employees',
        meta: { applicationId: String(app._id), reference },
      })
      .catch(() => {});

    return { reference };
  } catch (err) {
    discardUploads(req);
    throw err;
  }
}

// ---------- admin ----------

const fullName = (o) => `${o.firstName || ''} ${o.lastName || ''}`.trim();

function serialize(doc, { sensitive = true } = {}) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const ec = o.emergencyContact ? { ...o.emergencyContact, relation: o.emergencyContact.relationship ?? null } : null;
  const out = {
    _id: o._id,
    reference: o.reference,
    status: o.status,
    submittedAt: o.createdAt,
    firstName: o.firstName,
    lastName: o.lastName || '',
    name: fullName(o),
    fatherHusbandName: o.fatherHusbandName ?? null,
    phone: o.phone ?? null,
    email: o.email ?? null,
    cnic: o.cnic ?? null,
    cnicExpiry: o.cnicExpiry ?? null,
    dateOfBirth: o.dateOfBirth ?? null,
    gender: o.gender ?? null,
    maritalStatus: o.maritalStatus ?? null,
    qualification: o.qualification ?? null,
    experience: o.experience ?? null,
    previousEmployer: o.previousEmployer ?? null,
    address: o.address ?? null,
    emergencyContact: ec,
    guarantor: o.guarantor ?? null,
    bankDetails: o.bankDetails ?? null,
    photo: o.photo ?? null,
    files: (o.files || []).map((f) => ({ url: f.url, name: f.name, type: f.type })),
    reviewedAt: o.reviewedAt ?? null,
    reviewedByName: o.reviewedByName ?? null,
    rejectReason: o.rejectReason ?? null,
    employee: o.employee ?? null,
  };
  if (!sensitive) {
    // Same rule as employees: CNIC / bank only for users who may edit employees.
    out.cnic = null;
    out.cnicExpiry = null;
    out.bankDetails = null;
    if (out.guarantor) out.guarantor = { ...out.guarantor, cnic: null };
    out.files = [];
  }
  out.sensitiveHidden = !sensitive;
  return out;
}

const canSee = (req) => employeeService.canSeeSensitive(req);

async function list(req) {
  const q = req.query || {};
  const status = String(q.status || 'pending');
  const filter = {};
  if (status !== 'all') {
    if (!EmployeeApplication.STATUSES.includes(status)) throw httpError(400, 'status must be pending, approved, rejected or all');
    filter.status = status;
  }
  const paging = u.paging(q, 25);
  const [rows, total, grouped] = await Promise.all([
    EmployeeApplication.find(filter).select('-ip -userAgent').sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    EmployeeApplication.countDocuments(filter),
    EmployeeApplication.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const g of grouped) if (g._id in counts) counts[g._id] = g.n;
  const sensitive = canSee(req);
  return {
    data: rows.map((r) => serialize(r, { sensitive })),
    meta: { total, page: paging.page, limit: paging.limit, counts },
  };
}

async function load(id) {
  if (!u.isId(id)) throw httpError(404, 'Application not found');
  const app = await EmployeeApplication.findById(id);
  if (!app) throw httpError(404, 'Application not found');
  return app;
}

async function get(req, id) {
  return serialize(await load(id), { sensitive: canSee(req) });
}

async function reviewerName(userId) {
  const user = await User.findById(userId).select('firstName lastName email').lean();
  return u.userName(user) || null;
}

const PAY_TYPES = ['monthly', 'daily'];

/** POST /employee-applications/:id/approve — creates the Employee. */
async function approve(req, id) {
  const app = await load(id);
  if (app.status !== 'pending') throw httpError(409, `This application is already ${app.status}`, 'NOT_PENDING');
  const o = req.body || {};
  if (o.payType !== undefined && o.payType !== null && o.payType !== '' && !PAY_TYPES.includes(o.payType)) {
    throw httpError(400, 'Pay type must be monthly or daily');
  }

  const personal = {};
  for (const k of PERSONAL) if (app[k] !== undefined && app[k] !== null) personal[k] = app[k] && app[k].toObject ? app[k].toObject() : app[k];
  for (const k of ['cnicExpiry', 'dateOfBirth']) if (personal[k] instanceof Date) personal[k] = personal[k].toISOString();

  const body = { ...personal };
  for (const k of ['designation', 'department', 'joiningDate', 'salary', 'employmentType']) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') body[k] = o[k];
  }

  // Same path as "Add employee": code, validation, CNIC check, history.
  const created = await employeeService.create(Object.assign(Object.create(req), { body }));

  // Photo, documents and pay type are set after create (create() takes no files).
  const emp = await Employee.findById(created._id);
  const by = req.access.userId;
  if (app.photo) {
    emp.photo = app.photo;
    emp.documents.push({ type: 'photo', name: 'Photo', url: app.photo, uploadedBy: by });
  }
  // The form asks for CNIC front/back first: keep those as CNIC documents so
  // view-only HR users cannot see them (same rule as the employee screens).
  const DOC_TYPES = ['cnic_front', 'cnic_back'];
  const DOC_NAMES = ['CNIC front', 'CNIC back'];
  app.files.forEach((f, i) => {
    emp.documents.push({ type: DOC_TYPES[i] || 'other', name: DOC_NAMES[i] || `Document ${i + 1}`, url: f.url, uploadedBy: by });
  });
  if (PAY_TYPES.includes(o.payType)) emp.payType = o.payType;
  emp.history.push({ by, action: 'from_application', note: app.reference });
  await emp.save();

  app.status = 'approved';
  app.employee = emp._id;
  app.reviewedAt = new Date();
  app.reviewedBy = by;
  app.reviewedByName = await reviewerName(by);
  await app.save();

  return { application: serialize(app, { sensitive: canSee(req) }), employeeId: emp._id };
}

/** POST /employee-applications/:id/reject { reason } */
async function reject(req, id) {
  const app = await load(id);
  if (app.status !== 'pending') throw httpError(409, `This application is already ${app.status}`, 'NOT_PENDING');
  app.status = 'rejected';
  app.rejectReason = u.str((req.body || {}).reason, 500);
  app.reviewedAt = new Date();
  app.reviewedBy = req.access.userId;
  app.reviewedByName = await reviewerName(req.access.userId);
  await app.save();
  return serialize(app, { sensitive: canSee(req) });
}

module.exports = {
  INVALID_LINK,
  getLink,
  regenerateLink,
  setEnabled,
  publicInfo,
  submit,
  list,
  get,
  approve,
  reject,
  serialize,
  readPayload,
};
