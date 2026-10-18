// src/controller/store/counterController.js
// Sale counters (/api/counters): CRUD + the cut-off check run by the cron.
// OWNER: Cash & Notifications module.
const mongoose = require('mongoose');
const SaleCounter = require('../../models/saleCounter');
const CashSession = require('../../models/cashSession');
const User = require('../../models/user');
const tillService = require('../../services/tillService');
const whatsapp = require('../../services/whatsapp');
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function nextCode(branchId) {
  const existing = await SaleCounter.find({ branch: branchId }).setOptions({ withDeleted: true }).select('code').lean();
  const used = new Set(existing.map((c) => c.code));
  let n = existing.length + 1;
  while (used.has(`C${n}`)) n += 1;
  return `C${n}`;
}

/** Validated subset of the body (only the fields that were sent). */
async function cleanInput(body) {
  const out = {};
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Counter name is required');
    out.name = name.slice(0, 60);
  }
  if (body.code !== undefined) out.code = String(body.code || '').trim().toUpperCase().slice(0, 20);
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === 'true';
  for (const key of ['openCutoff', 'closeCutoff']) {
    if (body[key] === undefined) continue;
    const v = String(body[key] || '').trim();
    if (v && !SaleCounter.HHMM.test(v)) throw httpError(400, `${key === 'openCutoff' ? 'Open' : 'Close'} cut-off must be HH:mm, e.g. 10:00`);
    out[key] = v;
  }
  if (body.defaultFloat !== undefined) {
    const f = Number(body.defaultFloat || 0);
    if (!Number.isFinite(f) || f < 0) throw httpError(400, 'Default float must be 0 or more');
    out.defaultFloat = round2(f);
  }
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim().slice(0, 300);
  if (body.assignedUsers !== undefined) {
    const ids = [...new Set((Array.isArray(body.assignedUsers) ? body.assignedUsers : []).map(String))].filter(isId);
    if (ids.length) {
      const users = await User.find({ _id: { $in: ids }, staffRole: { $ne: null } }).select('_id').lean();
      if (users.length !== ids.length) throw httpError(400, 'Some selected users are not staff logins.');
    }
    out.assignedUsers = ids;
  }
  return out;
}

function checkCutoffOrder(counter) {
  const open = tillService.hhmmToMinutes(counter.openCutoff);
  const close = tillService.hhmmToMinutes(counter.closeCutoff);
  if (open !== null && close !== null && close <= open) {
    throw httpError(400, 'Close cut-off must be later than the open cut-off (same day).');
  }
}

const duplicateCode = (err) => err && err.code === 11000;

async function withOpenSessions(rows) {
  if (!rows.length) return rows;
  const open = await CashSession.find({ counter: { $in: rows.map((r) => r._id) }, status: 'open' })
    .select('counter cashierName openedAt sessionNo')
    .lean();
  const byCounter = new Map(open.map((s) => [String(s.counter), s]));
  return rows.map((r) => {
    const s = byCounter.get(String(r._id));
    return { ...r, openSession: s ? { _id: s._id, sessionNo: s.sessionNo, cashierName: s.cashierName, openedAt: s.openedAt } : null };
  });
}

const counterController = {
  // GET /api/counters?search=&isActive=&page=&limit=
  async list(req, res) {
    const filter = { ...branchFilter(req) };
    if (req.query.isActive === 'true') filter.isActive = true;
    if (req.query.isActive === 'false') filter.isActive = false;
    const search = String(req.query.search || '').trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: rx }, { code: rx }];
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const [total, rows] = await Promise.all([
      SaleCounter.countDocuments(filter),
      SaleCounter.find(filter)
        .populate('assignedUsers', 'firstName lastName email')
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    res.json({
      success: true,
      data: await withOpenSessions(rows),
      meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  },

  // GET /api/counters/staff-options — staff logins, for "assigned users".
  async staffOptions(req, res) {
    const users = await User.find({ staffRole: { $ne: null }, isActive: { $ne: false } })
      .select('firstName lastName email')
      .sort({ firstName: 1 })
      .limit(500)
      .lean();
    res.json({
      success: true,
      data: users.map((u) => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email, email: u.email })),
    });
  },

  // POST /api/counters
  async create(req, res) {
    const branchId = String(await resolveWriteBranch(req));
    const input = await cleanInput({ ...req.body, name: req.body.name ?? '' });
    const doc = new SaleCounter({
      name: input.name,
      code: input.code || (await nextCode(branchId)),
      branch: branchId,
      isActive: input.isActive ?? true,
      openCutoff: input.openCutoff || '',
      closeCutoff: input.closeCutoff || '',
      defaultFloat: input.defaultFloat || 0,
      assignedUsers: input.assignedUsers || [],
      notes: input.notes || '',
      createdBy: req.access.userId,
      updatedBy: req.access.userId,
    });
    checkCutoffOrder(doc);
    try {
      await doc.save();
    } catch (err) {
      if (duplicateCode(err)) throw httpError(409, `Code ${doc.code} is already used.`);
      throw err;
    }
    res.status(201).json({ success: true, data: doc.toObject(), message: 'Counter added' });
  },

  // PUT /api/counters/:id
  async update(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Counter not found');
    const doc = await SaleCounter.findOne({ _id: req.params.id, ...branchFilter(req) });
    if (!doc) throw httpError(404, 'Counter not found');
    const { branch, ...body } = req.body || {}; // eslint-disable-line no-unused-vars
    const input = await cleanInput(body);
    if (input.code === '') delete input.code; // blank code = keep
    doc.set({ ...input, updatedBy: req.access.userId });
    checkCutoffOrder(doc);
    try {
      await doc.save();
    } catch (err) {
      if (duplicateCode(err)) throw httpError(409, `Code ${doc.code} is already used.`);
      throw err;
    }
    res.json({ success: true, data: doc.toObject(), message: 'Counter saved' });
  },

  // DELETE /api/counters/:id (soft delete; not while a till is open on it)
  async remove(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Counter not found');
    const doc = await SaleCounter.findOne({ _id: req.params.id, ...branchFilter(req) });
    if (!doc) throw httpError(404, 'Counter not found');
    const open = await CashSession.exists({ counter: doc._id, status: 'open' });
    if (open) throw httpError(409, 'A till is open on this counter. Close it first.');
    await doc.softDelete(req.access.userId);
    res.json({ success: true, message: 'Counter deleted' });
  },

  // GET /api/counters/check-cutoffs — Vercel cron (or "Check now"): cut-off
  // notifications + retry failed WhatsApp slips.
  async runCutoffs(req, res) {
    const cutoffs = await tillService.checkCutoffs(new Date());
    const retries = await whatsapp.retryFailed({ limit: 10, budgetMs: 8000 });
    res.json({ success: true, data: { cutoffs, whatsapp: retries } });
  },
};

module.exports = counterController;
