// Asset register: categories, assets, depreciation, maintenance, disposal,
// per-category summary and CSV export. Branch scoped like every module (doc §3).
const Asset = require('../../models/asset');
const AssetCategory = require('../../models/assetCategory');
const Employee = require('../../models/employee');
const Vendor = require('../../models/vendor');
const { depreciate } = require('./depreciation');
const u = require('./util');

const { httpError, round2 } = u;

const STATUSES = ['active', 'maintenance', 'sold', 'disposed'];
const IN_USE = ['active', 'maintenance'];
const GONE = ['sold', 'disposed'];

const DEFAULT_CATEGORIES = [
  { code: 'FUR', name: 'Furniture & Fixtures', description: 'Racks, shelves, counters, display stands, chairs', usefulLifeYears: 10, sortOrder: 10 },
  { code: 'IT', name: 'Electronics & IT', description: 'POS computers, receipt and label printers, barcode scanners, cash drawers, routers', usefulLifeYears: 3, sortOrder: 20 },
  { code: 'MCH', name: 'Machinery & Equipment', description: 'Air conditioners, generator, UPS and batteries, fans, water dispenser', usefulLifeYears: 5, sortOrder: 30 },
  { code: 'VEH', name: 'Vehicles', description: 'Delivery van, loader rickshaw, motorcycle', usefulLifeYears: 5, sortOrder: 40 },
  { code: 'BLD', name: 'Building & Renovation', description: 'Shop fit-out, flooring, ceiling, lighting, signboards', usefulLifeYears: 10, sortOrder: 50 },
  { code: 'SEC', name: 'Security', description: 'CCTV cameras, DVR / NVR, alarm, safe', usefulLifeYears: 5, sortOrder: 60 },
  { code: 'SW', name: 'Software & Licences', description: 'POS software, Windows and antivirus licences', usefulLifeYears: 3, sortOrder: 70 },
  { code: 'OTH', name: 'Other', description: 'Anything else the shop owns', usefulLifeYears: 5, sortOrder: 80 },
].map((c) => ({ ...c, depreciationMethod: 'straight_line', isActive: true }));

const POPULATE = [
  { path: 'category', select: 'name code depreciationMethod usefulLifeYears isActive' },
  { path: 'branch', select: 'name code' },
  { path: 'assignedTo', select: 'firstName lastName employeeCode designation' },
  { path: 'vendorRef', select: 'name phone' },
];

// ---------- categories ----------

let ensured = null;
/**
 * Default categories on first use (only when the collection has never had any),
 * and old assets (only `type`) get the matching category. Runs once per process.
 */
function ensureCategories() {
  if (!ensured) {
    ensured = (async () => {
      const total = await AssetCategory.countDocuments({}).setOptions({ withDeleted: true });
      if (total === 0) {
        await AssetCategory.bulkWrite(
          DEFAULT_CATEGORIES.map((c) => ({
            updateOne: { filter: { code: c.code }, update: { $setOnInsert: { ...c, isDeleted: false } }, upsert: true },
          }))
        );
      }
      const cats = await AssetCategory.find({ code: { $in: Object.values(Asset.LEGACY_TYPE_TO_CODE) } }).select('code').lean();
      const byCode = Object.fromEntries(cats.map((c) => [c.code, c._id]));
      for (const [type, code] of Object.entries(Asset.LEGACY_TYPE_TO_CODE)) {
        if (byCode[code]) await Asset.updateMany({ category: null, type }, { $set: { category: byCode[code] } });
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

function readCategoryBody(body = {}, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('name')) {
    out.name = u.str(body.name, 80);
    if (!out.name) throw httpError(400, 'Category name is required');
  }
  if (has('description')) out.description = u.str(body.description, 300) || '';
  if (has('depreciationMethod')) {
    if (!['straight_line', 'none'].includes(body.depreciationMethod)) throw httpError(400, 'Depreciation must be straight_line or none');
    out.depreciationMethod = body.depreciationMethod;
  }
  if (has('usefulLifeYears')) out.usefulLifeYears = lifeYears(body.usefulLifeYears) ?? 0;
  if (has('sortOrder')) out.sortOrder = Number(body.sortOrder) || 100;
  if (has('isActive')) out.isActive = body.isActive !== false && body.isActive !== 'false';
  return out;
}

function lifeYears(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'Useful life must be between 0 and 100 years');
  return round2(n);
}

// "Kitchen Items" -> KITI, "Generators" -> GEN.
const codeFromName = (name) => {
  const words = String(name).match(/[A-Za-z0-9]+/g) || ['CAT'];
  return (words[0].slice(0, 3) + words.slice(1).map((w) => w[0]).join('')).toUpperCase().slice(0, 4).padEnd(3, 'X');
};

async function listCategories(req) {
  await ensureCategories();
  const filter = req.query?.active === 'true' ? { isActive: true } : {};
  const [cats, counts] = await Promise.all([
    AssetCategory.find(filter).sort({ sortOrder: 1, name: 1 }).lean(),
    Asset.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
  return cats.map((c) => ({ ...c, assetCount: byId[String(c._id)] || 0 }));
}

async function createCategory(req) {
  await ensureCategories();
  const fields = readCategoryBody(req.body, { partial: false });
  let code = (u.str(req.body?.code, 10) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code) {
    code = codeFromName(fields.name);
    for (let i = 2; await AssetCategory.exists({ code }); i += 1) code = `${codeFromName(fields.name).slice(0, 3)}${i}`;
  }
  if (await AssetCategory.exists({ code })) throw httpError(409, `Category code ${code} is already used`);
  if (await AssetCategory.exists({ name: new RegExp(`^${u.containsRe(fields.name).source}$`, 'i') })) {
    throw httpError(409, 'A category with this name already exists');
  }
  const cat = await AssetCategory.create({ depreciationMethod: 'straight_line', usefulLifeYears: 5, ...fields, code, createdBy: req.access.userId });
  return cat.toObject();
}

async function updateCategory(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Category not found');
  const cat = await AssetCategory.findById(id);
  if (!cat) throw httpError(404, 'Category not found');
  const fields = readCategoryBody(req.body, { partial: true });
  if (fields.name && fields.name.toLowerCase() !== cat.name.toLowerCase()) {
    const dup = await AssetCategory.exists({ _id: { $ne: cat._id }, name: new RegExp(`^${u.containsRe(fields.name).source}$`, 'i') });
    if (dup) throw httpError(409, 'A category with this name already exists');
  }
  cat.set(fields); // the code never changes (old screens map `type` by code)
  await cat.save();
  return cat.toObject();
}

async function removeCategory(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Category not found');
  const used = await Asset.countDocuments({ category: id, isDeleted: { $ne: true } });
  if (used) throw httpError(409, `${used} asset(s) are in this category. Move them first or mark the category inactive.`, 'CATEGORY_IN_USE');
  const cat = await AssetCategory.softDeleteById(id, req.access.userId);
  if (!cat) throw httpError(404, 'Category not found');
  return { _id: cat._id, deleted: true };
}

// ---------- assets: output ----------

/** Lean asset (category populated) + computed money fields. */
function serialize(a, asOf = new Date()) {
  const cat = a.category && a.category._id ? a.category : null;
  const qty = Math.max(1, Number(a.quantity) || 1);
  const method = a.depreciationMethod || cat?.depreciationMethod || 'none';
  const life = a.usefulLifeYears ?? cat?.usefulLifeYears ?? null;
  const totalCost = round2((Number(a.purchasePrice) || 0) * qty);
  const salvageTotal = round2((Number(a.salvageValue) || 0) * qty);
  const gone = GONE.includes(a.status);
  const valueDate = gone && a.disposal?.date ? a.disposal.date : asOf;
  const dep = depreciate({ cost: totalCost, salvage: salvageTotal, lifeYears: life, method, purchaseDate: a.purchaseDate, asOf: valueDate });
  const maintenanceCost = round2((a.maintenanceLog || []).reduce((s, m) => s + (Number(m.cost) || 0), 0));
  const o = { ...a };
  delete o.__v;
  return {
    ...o,
    quantity: qty,
    totalCost,
    salvageTotal,
    effectiveMethod: dep.method,
    effectiveLifeYears: dep.method === 'none' ? null : life,
    monthsUsed: dep.monthsUsed,
    monthlyDepreciation: dep.monthly,
    accumulatedDepreciation: dep.accumulated,
    currentValue: dep.currentValue,
    fullyDepreciated: dep.fullyDepreciated,
    manualValue: a.currentValue ?? null,
    maintenanceCost,
    gainOnDisposal: gone && a.disposal?.amount != null ? round2(a.disposal.amount - dep.currentValue) : null,
    warrantyActive: !!(a.warrantyUntil && new Date(a.warrantyUntil) >= asOf),
  };
}

// ---------- assets: input ----------

async function readAssetBody(req, body = {}, { partial, current = null }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const text = (k, max = 300) => {
    if (has(k)) out[k] = u.str(body[k], max) || '';
  };

  if (!partial || has('name')) {
    out.name = u.str(body.name, 150);
    if (!out.name) throw httpError(400, 'Asset name is required');
  }
  if (!partial || has('category')) {
    if (!u.isId(body.category)) throw httpError(400, 'Choose a category');
    const cat = await AssetCategory.findById(body.category).select('code').lean();
    if (!cat) throw httpError(400, 'Category not found');
    out.category = cat._id;
    out.type = Asset.CODE_TO_LEGACY_TYPE[cat.code] || 'other';
  }
  if (!partial || has('purchasePrice')) out.purchasePrice = u.money(body.purchasePrice, 'Purchase price', { allowNull: false });
  if (!partial || has('purchaseDate')) {
    out.purchaseDate = u.date(body.purchaseDate, 'purchase date');
    if (!out.purchaseDate) throw httpError(400, 'Purchase date is required');
  }
  if (has('quantity')) {
    const q = Number(body.quantity);
    if (!Number.isInteger(q) || q < 1) throw httpError(400, 'Quantity must be a whole number of 1 or more');
    out.quantity = q;
  }
  text('description', 1000);
  text('location', 120);
  text('serialNumber', 120);
  text('invoiceNo', 80);
  text('notes', 2000);
  text('vendor', 150);
  if (has('vendorRef')) {
    if (!body.vendorRef) out.vendorRef = null;
    else {
      if (!u.isId(body.vendorRef)) throw httpError(400, 'Invalid vendor');
      const v = await Vendor.findOne({ _id: body.vendorRef, isDeleted: { $ne: true } }).select('name').lean();
      if (!v) throw httpError(400, 'Vendor not found');
      out.vendorRef = v._id;
      if (!out.vendor && !(current && current.vendor && !has('vendor'))) out.vendor = v.name;
    }
  }
  if (has('warrantyUntil')) out.warrantyUntil = u.date(body.warrantyUntil, 'warranty date');
  if (has('usefulLifeYears')) out.usefulLifeYears = lifeYears(body.usefulLifeYears);
  if (has('depreciationMethod')) {
    const m = body.depreciationMethod || null;
    if (m !== null && !['straight_line', 'none'].includes(m)) throw httpError(400, 'Depreciation must be straight_line, none or empty (use category)');
    out.depreciationMethod = m;
  }
  if (has('salvageValue')) out.salvageValue = u.money(body.salvageValue, 'Salvage value') || 0;
  const price = out.purchasePrice ?? current?.purchasePrice ?? 0;
  const salvage = out.salvageValue ?? current?.salvageValue ?? 0;
  if (salvage > price) throw httpError(400, 'Salvage value cannot be more than the purchase price');

  if (has('assignedTo')) {
    if (!body.assignedTo) out.assignedTo = null;
    else {
      if (!u.isId(body.assignedTo)) throw httpError(400, 'Invalid employee');
      const emp = await Employee.findOne({ _id: body.assignedTo, isDeleted: { $ne: true } }).select('_id').lean();
      if (!emp) throw httpError(400, 'Employee not found');
      out.assignedTo = emp._id;
    }
  }
  if (!partial && has('status')) {
    if (!IN_USE.includes(body.status)) throw httpError(400, 'New assets are active or in maintenance');
    out.status = body.status;
  }
  return out;
}

async function load(req, id) {
  if (!u.isId(id)) throw httpError(404, 'Asset not found');
  const asset = await Asset.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!asset) throw httpError(404, 'Asset not found');
  return asset;
}

async function fresh(id) {
  return serialize(await Asset.findById(id).populate(POPULATE).lean());
}

// ---------- assets: queries ----------

async function buildFilter(req) {
  const q = req.query || {};
  const and = [{ isDeleted: { $ne: true } }];
  if (q.category === 'none') and.push({ category: null });
  else if (u.isId(q.category)) and.push({ category: q.category });
  const statuses = String(q.status || '').split(',').map((s) => s.trim());
  if (statuses.includes('in_use')) and.push({ status: { $in: IN_USE } });
  else if (statuses.some((s) => STATUSES.includes(s))) and.push({ status: { $in: statuses.filter((s) => STATUSES.includes(s)) } });
  if (u.isId(q.assignedTo)) and.push({ assignedTo: q.assignedTo });
  const words = String(q.search || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const re = u.containsRe(w);
    and.push({ $or: [{ name: re }, { assetCode: re }, { serialNumber: re }, { location: re }, { vendor: re }, { invoiceNo: re }, { description: re }] });
  }
  return { $and: and };
}

const SORTABLE = { createdAt: 'createdAt', name: 'name', purchaseDate: 'purchaseDate', purchasePrice: 'purchasePrice', code: 'assetCode', status: 'status' };

async function list(req) {
  await ensureCategories();
  const filter = await buildFilter(req);
  const p = u.paging(req.query || {});
  const sort = u.sortOf(req.query?.sort, SORTABLE, { createdAt: -1, _id: -1 });
  const [rows, total] = await Promise.all([
    Asset.find(filter).select('-history').sort(sort).skip(p.skip).limit(p.limit).populate(POPULATE).lean(),
    Asset.countDocuments(filter),
  ]);
  const now = new Date();
  return { data: rows.map((r) => serialize(r, now)), meta: u.pageMeta(p, total) };
}

async function get(req, id) {
  await load(req, id);
  return fresh(id);
}

/** Per category: in-use count / quantity / cost / current value, plus sold & disposed totals. */
async function summary(req) {
  await ensureCategories();
  const [cats, rows] = await Promise.all([
    AssetCategory.find({}).sort({ sortOrder: 1, name: 1 }).lean(),
    Asset.find({ isDeleted: { $ne: true } })
      .select('category quantity purchasePrice salvageValue purchaseDate depreciationMethod usefulLifeYears status disposal maintenanceLog.cost')
      .populate({ path: 'category', select: 'name code depreciationMethod usefulLifeYears' })
      .lean(),
  ]);
  const blank = () => ({ count: 0, quantity: 0, cost: 0, currentValue: 0, accumulatedDepreciation: 0, maintenanceCost: 0 });
  const groups = new Map(cats.map((c) => [String(c._id), { categoryId: c._id, name: c.name, code: c.code, isActive: c.isActive, ...blank() }]));
  const totals = blank();
  const gone = { count: 0, cost: 0, received: 0 };
  const now = new Date();

  for (const r of rows) {
    const a = serialize(r, now);
    if (GONE.includes(a.status)) {
      gone.count += 1;
      gone.cost += a.totalCost;
      gone.received += Number(a.disposal?.amount) || 0;
      continue;
    }
    const key = a.category?._id ? String(a.category._id) : 'none';
    if (!groups.has(key)) groups.set(key, { categoryId: null, name: 'Uncategorised', code: '', isActive: true, ...blank() });
    for (const g of [groups.get(key), totals]) {
      g.count += 1;
      g.quantity += a.quantity;
      g.cost += a.totalCost;
      g.currentValue += a.currentValue;
      g.accumulatedDepreciation += a.accumulatedDepreciation;
      g.maintenanceCost += a.maintenanceCost;
    }
  }
  const fix = (g) => {
    for (const k of ['cost', 'currentValue', 'accumulatedDepreciation', 'maintenanceCost', 'received']) if (k in g) g[k] = round2(g[k]);
    return g;
  };
  return {
    categories: [...groups.values()].filter((g) => g.isActive !== false || g.count > 0).map(fix),
    totals: fix(totals),
    soldOrDisposed: fix(gone),
    asOf: now,
  };
}

async function exportCsv(req) {
  await ensureCategories();
  const filter = await buildFilter(req);
  const rows = await Asset.find(filter).select('-history').sort({ assetCode: 1 }).limit(10000).populate(POPULATE).lean();
  const now = new Date();
  const header = ['Asset code', 'Name', 'Category', 'Branch', 'Location', 'Assigned to', 'Quantity', 'Unit price (Rs)', 'Total cost (Rs)',
    'Purchase date', 'Vendor', 'Invoice no', 'Serial no', 'Warranty until', 'Depreciation', 'Useful life (years)',
    'Accumulated depreciation (Rs)', 'Current value (Rs)', 'Maintenance cost (Rs)', 'Status', 'Disposed on', 'Disposal amount (Rs)'];
  const lines = rows.map((r) => {
    const a = serialize(r, now);
    return [
      a.assetCode || '', a.name, a.category?.name || '', a.branch?.name || '', a.location || '',
      a.assignedTo ? `${a.assignedTo.firstName} ${a.assignedTo.lastName || ''}`.trim() : '',
      a.quantity, a.purchasePrice, a.totalCost, a.purchaseDate ? new Date(a.purchaseDate) : '', a.vendor || a.vendorRef?.name || '',
      a.invoiceNo || '', a.serialNumber || '', a.warrantyUntil ? new Date(a.warrantyUntil) : '',
      a.effectiveMethod === 'straight_line' ? 'Straight line' : 'None', a.effectiveLifeYears ?? '',
      a.accumulatedDepreciation, a.currentValue, a.maintenanceCost, a.status,
      a.disposal?.date ? new Date(a.disposal.date) : '', a.disposal?.amount ?? '',
    ];
  });
  return u.toCsv(header, lines);
}

// ---------- assets: writes ----------

async function create(req) {
  await ensureCategories();
  const body = req.body || {};
  const fields = await readAssetBody(req, body, { partial: false });
  const branch = await u.shopBranch(req);
  const asset = await Asset.create({
    ...fields,
    branch,
    createdBy: req.access.userId,
    updatedBy: req.access.userId,
    history: [{ by: req.access.userId, action: 'created' }],
  });
  return fresh(asset._id);
}

async function update(req, id) {
  const asset = await load(req, id);
  const body = req.body || {};
  const fields = await readAssetBody(req, body, { partial: true, current: asset });
  // Photos: the list sent is the list to KEEP (new photos go through /photos).
  if (Array.isArray(body.photos)) fields.photos = asset.photos.filter((p) => body.photos.includes(p));
  asset.set(fields);
  asset.updatedBy = req.access.userId;
  asset.history.push({ by: req.access.userId, action: 'updated' });
  await asset.save();
  return fresh(asset._id);
}

async function addPhotos(req, id, urls) {
  const asset = await load(req, id);
  if (!urls.length) throw httpError(400, 'Choose at least one photo');
  asset.photos = [...asset.photos, ...urls].slice(-10);
  asset.updatedBy = req.access.userId;
  await asset.save();
  return fresh(asset._id);
}

/** Add a repair/service entry. Optional `status` puts it in (or back from) maintenance. */
async function addMaintenance(req, id) {
  const asset = await load(req, id);
  const body = req.body || {};
  const note = u.str(body.note, 500);
  const cost = u.money(body.cost, 'Cost') || 0;
  if (!note && !cost) throw httpError(400, 'Write what was done (and the cost, if any)');
  if (GONE.includes(asset.status)) throw httpError(409, 'This asset is sold or disposed');
  asset.maintenanceLog.push({ date: u.date(body.date, 'date') || new Date(), cost, note: note || '', by: req.access.userId });
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    if (!IN_USE.includes(body.status)) throw httpError(400, 'Status must be active or maintenance');
    asset.status = body.status;
  }
  asset.history.push({ by: req.access.userId, action: 'maintenance', note: note || `Rs ${cost}` });
  asset.updatedBy = req.access.userId;
  await asset.save();
  return fresh(asset._id);
}

/** Sold or scrapped: freezes the book value on that date. */
async function dispose(req, id) {
  const asset = await load(req, id);
  const body = req.body || {};
  const status = body.type || body.status || 'disposed';
  if (!GONE.includes(status)) throw httpError(400, 'Type must be sold or disposed');
  if (GONE.includes(asset.status)) throw httpError(409, 'This asset is already sold or disposed');
  const when = u.date(body.date, 'date') || new Date();
  if (asset.purchaseDate && when < asset.purchaseDate) throw httpError(400, 'Disposal date is before the purchase date');
  const amount = u.money(body.amount, 'Amount') || 0;
  await asset.populate({ path: 'category', select: 'depreciationMethod usefulLifeYears' });
  const book = serialize({ ...asset.toObject(), status: 'active' }, when).currentValue;
  asset.depopulate('category');
  asset.status = status;
  asset.disposal = { date: when, amount, note: u.str(body.note, 500) || '', bookValue: book, by: req.access.userId };
  asset.history.push({ by: req.access.userId, action: status, note: `Rs ${amount} (book value Rs ${book})` });
  asset.updatedBy = req.access.userId;
  await asset.save();
  return fresh(asset._id);
}

/** active <-> maintenance; also undoes a sale / disposal (back to active). */
async function setStatus(req, id) {
  const asset = await load(req, id);
  const { status, note } = req.body || {};
  if (!IN_USE.includes(status)) throw httpError(400, 'Status must be active or maintenance (use dispose to sell or scrap)');
  const from = asset.status;
  if (GONE.includes(from)) asset.disposal = { date: null, amount: null, note: '', bookValue: null, by: null };
  asset.status = status;
  asset.history.push({ by: req.access.userId, action: `status:${from}->${status}`, note: u.str(note, 300) || '' });
  asset.updatedBy = req.access.userId;
  await asset.save();
  return fresh(asset._id);
}

async function remove(req, id) {
  const asset = await load(req, id);
  asset.isDeleted = true;
  asset.deletedAt = new Date();
  asset.deletedBy = req.access.userId;
  await asset.save({ validateBeforeSave: false });
  return { _id: asset._id, deleted: true };
}

module.exports = {
  DEFAULT_CATEGORIES,
  ensureCategories,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  serialize,
  list,
  get,
  summary,
  exportCsv,
  create,
  update,
  addPhotos,
  addMaintenance,
  dispose,
  setStatus,
  remove,
};
