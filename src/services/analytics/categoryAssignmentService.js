// src/services/analytics/categoryAssignmentService.js
// Category staff: which employees look after which product category, their
// share of its sales and the monthly target. One assignment per category,
// for the whole shop.
const Category = require('../../models/category');
const Employee = require('../../models/employee');
const Product = require('../../models/product');
const CategoryAssignment = require('../../models/categoryAssignment');
const C = require('./common');

const MAX_EMPLOYEES = 20;
const keyOf = (s) => String(s || '').trim().toLowerCase();

/** Name of an employee doc. */
const employeeName = (e) => (e ? `${e.firstName || ''} ${e.lastName || ''}`.trim() || 'Employee' : 'Removed employee');

/**
 * Employees for the picker (reads the Employee model directly; deleted ones
 * never show).
 */
async function listEmployees({ search, includeInactive } = {}) {
  const q = { isDeleted: { $ne: true } };
  if (!includeInactive) q.isActive = { $ne: false };
  if (search && String(search).trim()) {
    const rx = new RegExp(C.escapeRegex(String(search).trim()), 'i');
    q.$or = [{ firstName: rx }, { lastName: rx }, { phone: rx }, { position: rx }, { department: rx }];
  }
  const rows = await Employee.find(q)
    .select('firstName lastName phone position department role isActive status')
    .sort({ firstName: 1, lastName: 1 })
    .limit(1000)
    .lean();
  return rows.map((e) => ({
    _id: String(e._id),
    name: employeeName(e),
    phone: e.phone || '',
    position: e.position || '',
    department: e.department || '',
    role: e.role || '',
    status: e.status || (e.isActive === false ? 'inactive' : 'active'),
    isActive: e.isActive !== false,
  }));
}

/** Category names: the Category list + categories used on products (with product counts). */
async function listCategories() {
  const [cats, used] = await Promise.all([
    Category.find({}).select('name active parentId').lean(),
    Product.aggregate([{ $group: { _id: '$category', products: { $sum: 1 } } }]),
  ]);
  const map = new Map();
  for (const c of cats) {
    if (!c.name) continue;
    map.set(keyOf(c.name), { name: c.name, inCatalog: true, active: c.active !== false, products: 0 });
  }
  for (const u of used) {
    if (!u._id) continue;
    const k = keyOf(u._id);
    const e = map.get(k) || { name: u._id, inCatalog: false, active: true, products: 0 };
    e.products += u.products;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Assignments with employee names: [{ ..., employees: [{ employee, name, sharePct, effectivePct }] }]. */
async function withNames(docs) {
  const ids = docs.flatMap((d) => (d.employees || []).map((e) => String(e.employee)));
  const emps = await Employee.find({ _id: { $in: [...new Set(ids)].map(C.toId) } })
    .select('firstName lastName position isActive isDeleted')
    .lean();
  const byId = new Map(emps.map((e) => [String(e._id), e]));
  return docs.map((d) => {
    const shares = effectiveShares(d.employees || []);
    return {
      ...d,
      employees: (d.employees || []).map((e, i) => {
        const emp = byId.get(String(e.employee));
        return {
          employee: String(e.employee),
          name: employeeName(emp),
          position: emp ? emp.position || '' : '',
          isActive: !!emp && emp.isActive !== false && emp.isDeleted !== true,
          sharePct: e.sharePct ?? null,
          effectivePct: C.round2(shares[i] * 100),
        };
      }),
    };
  });
}

/** Share of each assignee (fractions summing to 1): the set % or an equal split. */
function effectiveShares(employees) {
  const n = employees.length;
  if (!n) return [];
  const set = employees.every((e) => e.sharePct !== null && e.sharePct !== undefined);
  const sum = set ? employees.reduce((s, e) => s + Number(e.sharePct), 0) : 0;
  if (set && sum > 0) return employees.map((e) => Number(e.sharePct) / sum);
  return employees.map(() => 1 / n);
}

async function list(req, query = {}) {
  const filter = {};
  if (query.isActive === 'true') filter.isActive = true;
  if (query.isActive === 'false') filter.isActive = false;
  if (query.search && String(query.search).trim()) filter.category = new RegExp(C.escapeRegex(String(query.search).trim()), 'i');
  if (query.employee && C.isId(query.employee)) filter['employees.employee'] = C.toId(query.employee);
  const { page, limit, skip } = C.pageParams(query, { defaultLimit: 100, maxLimit: 500 });
  const [docs, total] = await Promise.all([
    CategoryAssignment.find(filter).sort({ category: 1 }).skip(skip).limit(limit).select('-history').lean(),
    CategoryAssignment.countDocuments(filter),
  ]);
  return { data: await withNames(docs), meta: C.pageMeta(page, limit, total) };
}

async function load(req, id) {
  const doc = C.isId(id) ? await CategoryAssignment.findById(id).lean() : null;
  if (!doc) throw C.httpError('Category assignment not found', 404);
  return doc;
}

async function get(req, id) {
  const [doc] = await withNames([await load(req, id)]);
  return doc;
}

/** Validated fields from the request body. */
async function clean(req, body = {}, existing = null) {
  // One shop: an assignment covers the whole shop (branch null).
  const out = existing ? {} : { branch: null };

  if (body.category !== undefined || !existing) {
    const category = String(body.category || '').trim();
    if (!category) throw C.httpError('Pick a category');
    if (category.length > 120) throw C.httpError('Category name is too long');
    out.category = category;
    out.categoryKey = keyOf(category);
  }

  if (body.employees !== undefined || !existing) {
    const list = Array.isArray(body.employees) ? body.employees : [];
    if (!list.length) throw C.httpError('Assign at least one employee');
    if (list.length > MAX_EMPLOYEES) throw C.httpError(`At most ${MAX_EMPLOYEES} employees per category`);
    const rows = list.map((e) => {
      const id = C.toId(typeof e === 'string' ? e : e && (e.employee || e._id));
      if (!id) throw C.httpError('Invalid employee');
      const raw = typeof e === 'object' && e ? e.sharePct : null;
      const sharePct = raw === null || raw === undefined || raw === '' ? null : C.numParam(raw, null, { min: 0, max: 100 });
      return { employee: id, sharePct };
    });
    if (new Set(rows.map((r) => String(r.employee))).size !== rows.length) throw C.httpError('An employee is listed twice');
    const withShare = rows.filter((r) => r.sharePct !== null).length;
    if (withShare && withShare !== rows.length) throw C.httpError('Give every employee a share %, or leave all empty for an equal split');
    if (withShare) {
      const sum = rows.reduce((s, r) => s + r.sharePct, 0);
      if (Math.abs(sum - 100) > 0.5) throw C.httpError(`Shares must add up to 100% (now ${C.round2(sum)}%)`);
    }
    const found = await Employee.countDocuments({ _id: { $in: rows.map((r) => r.employee) }, isDeleted: { $ne: true } });
    if (found !== rows.length) throw C.httpError('One of the employees was not found');
    out.employees = rows;
  }

  if (body.monthlyTarget !== undefined) out.monthlyTarget = C.round2(C.numParam(body.monthlyTarget, 0, { min: 0, max: 1e10 }));
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === 'true';
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim().slice(0, 500);
  return out;
}

async function assertUnique(categoryKey, exceptId) {
  const clash = await CategoryAssignment.findOne({ categoryKey, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).lean();
  if (clash) throw C.httpError('This category already has staff assigned — edit it instead', 409, 'DUPLICATE');
}

async function create(req, body) {
  const fields = await clean(req, body);
  await assertUnique(fields.categoryKey);
  const userId = C.toId(req.access.userId);
  const doc = await CategoryAssignment.create({
    ...fields,
    createdBy: userId,
    updatedBy: userId,
    history: [{ at: new Date(), by: userId, action: 'created' }],
  });
  return get(req, doc._id);
}

async function update(req, id, body) {
  const existing = await load(req, id);
  const fields = await clean(req, body, existing);
  const categoryKey = fields.categoryKey || existing.categoryKey;
  await assertUnique(categoryKey, existing._id);
  const userId = C.toId(req.access.userId);
  await CategoryAssignment.updateOne(
    { _id: existing._id },
    { $set: { ...fields, updatedBy: userId }, $push: { history: { $each: [{ at: new Date(), by: userId, action: 'updated' }], $slice: -50 } } }
  );
  return get(req, existing._id);
}

async function remove(req, id) {
  const existing = await load(req, id);
  await CategoryAssignment.softDeleteById(existing._id, C.toId(req.access.userId));
  return { _id: String(existing._id) };
}

module.exports = { listEmployees, listCategories, list, get, create, update, remove, effectiveShares, employeeName, keyOf };
