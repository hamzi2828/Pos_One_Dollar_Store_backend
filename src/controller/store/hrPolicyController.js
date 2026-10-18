// HR policies (/api/hr-policies): the attendance & pay rules the shop creates
// and assigns to employees (employee.hrPolicy; none = the default policy).
// Exactly one policy is the default. After any change the policy cache is
// cleared and this month's unlocked attendance of the affected staff is re-checked.
const HrPolicy = require('../../models/hrPolicy');
const Employee = require('../../models/employee');
const { escapeRegex } = require('../../helper/paginate');
const policies = require('../../services/hr/policyService');
const roster = require('../../services/hr/rosterService');
const rules = require('./hrPolicyRules');

const { httpError, isId, fullName } = roster;
const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
const MAX_ASSIGN = 500;

function out(p, extra = {}) {
  const o = p && typeof p.toObject === 'function' ? p.toObject() : { ...p };
  return {
    _id: String(o._id),
    name: o.name,
    description: o.description || '',
    isDefault: !!o.isDefault,
    ...Object.fromEntries(rules.SECTIONS.map((s) => [s, o[s]])),
    summary: rules.summarize(o),
    summaryParts: rules.summaryParts(o),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    ...extra,
  };
}

async function load(id) {
  if (!isId(id)) throw httpError(404, 'Policy not found');
  const p = await HrPolicy.findById(id);
  if (!p) throw httpError(404, 'Policy not found');
  return p;
}

async function assertNameFree(name, selfId = null) {
  const dup = await HrPolicy.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...(selfId ? { _id: { $ne: selfId } } : {}) }).lean();
  if (dup) throw httpError(409, `There is already a policy called "${dup.name}"`, 'DUPLICATE_NAME');
}

const readName = (v) => {
  const name = String(v || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Give the policy a name, e.g. Standard staff');
  return name;
};

/** Name, description and rules from the body onto a policy document. */
async function apply(doc, body, { partial }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('name')) {
    doc.name = readName(body.name);
    await assertNameFree(doc.name, doc.isNew ? null : doc._id);
  }
  if (has('description')) doc.description = String(body.description || '').trim().slice(0, 500);
  for (const [path, value] of rules.readRules(body)) doc.set(path, value);
}

/** Ids of live policies (anything else falls back to the default). */
const livePolicyIds = async () => (await HrPolicy.find({ isActive: true }).select('_id').lean()).map((p) => p._id);

/** Current employees whose rules come from the default policy (none set, or a removed policy). */
async function defaultUsers() {
  const live = await livePolicyIds();
  const defaultId = (await policies.getDefault())._id;
  const rows = await Employee.find(roster.currentFilter({ hrPolicy: { $nin: live.filter((id) => String(id) !== String(defaultId)) } })).select('_id').lean();
  return rows.map((r) => r._id);
}

/** Current employees affected by a change to this policy. */
async function usersOf(p) {
  if (p.isDefault) return defaultUsers();
  return (await Employee.find(roster.currentFilter({ hrPolicy: p._id })).select('_id').lean()).map((r) => r._id);
}

async function afterChange(employeeIds) {
  policies.clearCache();
  return roster.recomputeMonthFor(employeeIds);
}

/** Make this policy the only default (new default first, so there is never none). */
async function makeDefault(p) {
  await HrPolicy.updateOne({ _id: p._id }, { $set: { isDefault: true } });
  await HrPolicy.updateMany({ _id: { $ne: p._id }, isDefault: true }, { $set: { isDefault: false } }).setOptions({ withDeleted: true });
  p.isDefault = true;
  policies.clearCache();
}

/** policyId -> number of current employees (no / removed policy counts for the default). */
async function counts(list, defaultId) {
  const known = new Set(list.map((p) => String(p._id)));
  const rows = await Employee.aggregate([{ $match: roster.currentFilter() }, { $group: { _id: '$hrPolicy', n: { $sum: 1 } } }]);
  const by = new Map();
  for (const r of rows) {
    const key = r._id && known.has(String(r._id)) ? String(r._id) : String(defaultId);
    by.set(key, (by.get(key) || 0) + r.n);
  }
  return by;
}

async function uniqueCopyName(base) {
  for (let i = 1; i < 50; i += 1) {
    const name = `${base} (copy${i > 1 ? ` ${i}` : ''})`.slice(0, 80);
    if (!(await HrPolicy.exists({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }))) return name;
  }
  return `${base} (copy ${Date.now()})`.slice(0, 80);
}

module.exports = {
  /** GET /hr-policies — default first; meta has the new-policy template and the limits for the editor. */
  async list(req, res) {
    const def = await policies.getDefault();
    const rows = await HrPolicy.find({}).sort({ isDefault: -1, name: 1 }).lean();
    const by = await counts(rows, def._id);
    ok(res, rows.map((p) => out(p, { employeeCount: by.get(String(p._id)) || 0 })), 200, {
      page: 1,
      limit: rows.length,
      total: rows.length,
      pages: rows.length ? 1 : 0,
      defaultId: String(def._id),
      template: rules.template(),
      limits: rules.LIMITS,
    });
  },

  /** GET /hr-policies/employees — current staff with the policy each one follows (assign screen). */
  async employees(req, res) {
    const [def, rows, live] = await Promise.all([
      policies.getDefault(),
      Employee.find(roster.currentFilter()).select('firstName lastName employeeCode designation photo hrPolicy').sort({ firstName: 1, lastName: 1 }).lean(),
      HrPolicy.find({}).select('name').lean(),
    ]);
    const nameOf = new Map(live.map((p) => [String(p._id), p.name]));
    ok(
      res,
      rows.map((e) => {
        const own = e.hrPolicy && nameOf.has(String(e.hrPolicy)) ? String(e.hrPolicy) : null;
        return {
          _id: String(e._id),
          name: fullName(e),
          code: e.employeeCode || '',
          designation: e.designation || '',
          photo: e.photo || null,
          hrPolicy: own, // null = follows the default
          policyId: own || String(def._id),
          policyName: own ? nameOf.get(own) : def.name,
        };
      })
    );
  },

  async get(req, res) {
    const p = await load(req.params.id);
    const ids = await usersOf(p);
    const emps = await Employee.find({ _id: { $in: ids } }).select('firstName lastName employeeCode designation').sort({ firstName: 1 }).lean();
    ok(res, out(p, { employeeCount: emps.length, employees: emps.map((e) => ({ _id: String(e._id), name: fullName(e), code: e.employeeCode || '', designation: e.designation || '' })) }));
  },

  async create(req, res) {
    const body = req.body || {};
    await policies.getDefault(); // make sure a default exists before adding others
    const p = new HrPolicy({ isDefault: false, isActive: true, createdBy: req.access.userId, updatedBy: req.access.userId });
    await apply(p, body, { partial: false });
    await p.save();
    let recomputed = 0;
    if (body.isDefault === true) {
      await makeDefault(p);
      recomputed = await afterChange(await defaultUsers());
    }
    ok(res, out(p, { employeeCount: 0, recomputed }), 201);
  },

  async update(req, res) {
    const p = await load(req.params.id);
    const body = req.body || {};
    await apply(p, body, { partial: true });
    p.updatedBy = req.access.userId;
    await p.save();
    if (body.isDefault === true && !p.isDefault) await makeDefault(p);
    const ids = await usersOf(p);
    const recomputed = await afterChange(ids);
    ok(res, out(p, { employeeCount: ids.length, recomputed }));
  },

  async duplicate(req, res) {
    const src = await load(req.params.id);
    const o = src.toObject();
    const p = await HrPolicy.create({
      name: await uniqueCopyName(src.name),
      description: o.description || '',
      ...Object.fromEntries(rules.SECTIONS.map((s) => [s, o[s]])),
      isDefault: false,
      isActive: true,
      createdBy: req.access.userId,
      updatedBy: req.access.userId,
    });
    ok(res, out(p, { employeeCount: 0 }), 201);
  },

  /** POST /hr-policies/:id/default */
  async setDefault(req, res) {
    const p = await load(req.params.id);
    if (!p.isDefault) await makeDefault(p);
    const ids = await defaultUsers();
    const recomputed = await afterChange(ids);
    ok(res, out(p, { employeeCount: ids.length, recomputed }));
  },

  /** DELETE — refused for the default and while current staff use it; former staff go back to the default. */
  async remove(req, res) {
    const p = await load(req.params.id);
    if (p.isDefault) throw httpError(409, 'This is the default policy. Make another policy the default first.', 'POLICY_DEFAULT');
    const inUse = await Employee.countDocuments(roster.currentFilter({ hrPolicy: p._id }));
    if (inUse) {
      throw httpError(409, `${inUse} employee${inUse === 1 ? ' uses' : 's use'} this policy. Assign them another policy first.`, 'POLICY_IN_USE');
    }
    await Employee.updateMany({ hrPolicy: p._id }, { $set: { hrPolicy: null } });
    await p.softDelete(req.access.userId);
    policies.clearCache();
    ok(res, { _id: String(p._id), deleted: true });
  },

  /**
   * POST /hr-policies/:id/assign { employeeIds, exact? }   (:id = "default" or "null" -> back to the default)
   * exact: true also moves staff on this policy who are NOT in the list back to the default.
   */
  async assign(req, res) {
    const body = req.body || {};
    const toDefault = ['default', 'null', 'none'].includes(String(req.params.id));
    const p = toDefault ? null : await load(req.params.id);
    const ids = [...new Set((Array.isArray(body.employeeIds) ? body.employeeIds : []).map(String))];
    if (ids.length > MAX_ASSIGN) throw httpError(400, `At most ${MAX_ASSIGN} employees at a time`);
    if (ids.some((id) => !isId(id))) throw httpError(400, 'Invalid employee id');
    if (!ids.length && !(body.exact && p)) throw httpError(400, 'Pick at least one employee');

    const found = await Employee.find({ _id: { $in: ids }, isDeleted: { $ne: true } }).select('hrPolicy').lean();
    if (found.length !== ids.length) throw httpError(404, 'Employee not found');
    const target = p ? p._id : null;
    const changed = found.filter((e) => String(e.hrPolicy || '') !== String(target || '')).map((e) => e._id);
    const note = p ? p.name : 'default policy';
    if (changed.length) {
      await Employee.updateMany(
        { _id: { $in: changed } },
        { $set: { hrPolicy: target, updatedBy: req.access.userId }, $push: { history: { at: new Date(), by: req.access.userId, action: 'hr_policy', note } } }
      );
    }
    let movedToDefault = [];
    if (body.exact && p) {
      movedToDefault = (await Employee.find({ hrPolicy: p._id, _id: { $nin: ids }, isDeleted: { $ne: true } }).select('_id').lean()).map((e) => e._id);
      if (movedToDefault.length) {
        await Employee.updateMany(
          { _id: { $in: movedToDefault } },
          { $set: { hrPolicy: null, updatedBy: req.access.userId }, $push: { history: { at: new Date(), by: req.access.userId, action: 'hr_policy', note: 'default policy' } } }
        );
      }
    }
    const recomputed = await afterChange([...changed, ...movedToDefault]);
    ok(res, { policyId: p ? String(p._id) : null, assigned: changed.length, unchanged: ids.length - changed.length, movedToDefault: movedToDefault.length, recomputed });
  },
};
