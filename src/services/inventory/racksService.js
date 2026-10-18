// src/services/inventory/racksService.js
// Racks & shelves of a branch (models/rack.js, models/shelf.js).
//
//   Rack  "A1"    zone A, number 1          (code unique per branch)
//   Shelf "A1-S2" rack A1, level 2          (code unique per branch, printed as a barcode)
//
// Everything here works on ONE branch (the caller resolves it). Stock on
// shelves lives in LocationStock and is only changed by locationService.
// A rack / shelf that still holds pieces cannot be deleted or deactivated
// (409) — move the pieces first, so no stock is ever "lost" on a hidden shelf.
const mongoose = require('mongoose');
const Rack = require('../../models/rack');
const Shelf = require('../../models/shelf');
const LocationStock = require('../../models/locationStock');
const { escapeRegex } = require('../../helper/paginate');

const LIMITS = {
  zones: 26,
  racksPerZone: 100,
  shelvesPerRack: 12, // when generating / creating a rack
  maxLevel: 20, // highest shelf level a rack can have
  totalRacks: 1000, // one generate call
  rackNumber: 999,
};
const ZONE_RX = /^[A-Z]{1,2}$/;
// Natural order for codes: "A2-S1" < "A10-S1".
const NATURAL = { locale: 'en', numericOrdering: true };

const httpError = (message, status = 400, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
};

const oid = (v) => {
  const s = v && typeof v === 'object' && v._id ? String(v._id) : String(v ?? '');
  return /^[0-9a-fA-F]{24}$/.test(s) ? new mongoose.Types.ObjectId(s) : null;
};
const requireId = (v, what) => {
  const id = oid(v);
  if (!id) throw httpError(`Invalid ${what} id`);
  return id;
};

const shelfCodeOf = (rackCode, level) => `${rackCode}-S${level}`;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Whole number in [min, max] or a 400 error. Empty -> fallback. */
function intIn(value, min, max, label, fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}

/** "A, B, C" / "A-D" / ['a','b'] -> ['A','B'] (unique, validated). */
function parseZones(input) {
  let parts = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  parts = parts.map((z) => String(z ?? '').trim().toUpperCase()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const range = /^([A-Z])-([A-Z])$/.exec(p);
    if (range) {
      const a = range[1].charCodeAt(0);
      const b = range[2].charCodeAt(0);
      if (b < a) throw httpError(`Zone range ${p} is backwards`);
      for (let c = a; c <= b; c++) out.push(String.fromCharCode(c));
    } else out.push(p);
  }
  const zones = [...new Set(out)];
  if (!zones.length) throw httpError('Enter at least one zone letter, e.g. A, B, C, D');
  const bad = zones.filter((z) => !ZONE_RX.test(z));
  if (bad.length) throw httpError(`Zones must be 1-2 letters (A, B, AA...). Not valid: ${bad.join(', ')}`);
  if (zones.length > LIMITS.zones) throw httpError(`At most ${LIMITS.zones} zones at a time`);
  return zones;
}

function parseZone(value) {
  const z = String(value ?? '').trim().toUpperCase();
  if (!ZONE_RX.test(z)) throw httpError('Zone must be 1-2 letters, e.g. A');
  return z;
}

/** ['Kitchen', 'Toys'] from an array or "Kitchen, Toys". */
function parseCategories(value) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const clean = [...new Set(list.map((c) => str(c, 60)).filter(Boolean))];
  if (clean.length > 30) throw httpError('At most 30 categories per rack');
  return clean;
}

function parseCapacity(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return intIn(value, 0, 1000000, 'Capacity');
}

function parseBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  return undefined;
}

/** insertMany that tolerates duplicate-key races (two people generating at once). */
async function insertManySafe(Model, docs) {
  if (!docs.length) return 0;
  try {
    const res = await Model.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    const writeErrors = err.writeErrors || (err.result && err.result.getWriteErrors && err.result.getWriteErrors()) || [];
    const onlyDuplicates = err.code === 11000 || (writeErrors.length && writeErrors.every((e) => (e.code || e.err?.code) === 11000));
    if (!onlyDuplicates) throw err;
    if (Array.isArray(err.insertedDocs)) return err.insertedDocs.length;
    return Math.max(0, docs.length - writeErrors.length);
  }
}

/** Keep rack.shelfCount = number of active shelves. */
async function syncShelfCounts(rackIds) {
  const ids = [...new Set(rackIds.map(String))].map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return;
  const counts = await Shelf.aggregate([
    { $match: { isDeleted: { $ne: true }, rack: { $in: ids }, isActive: true } },
    { $group: { _id: '$rack', n: { $sum: 1 } } },
  ]);
  const byRack = new Map(counts.map((c) => [String(c._id), c.n]));
  await Rack.bulkWrite(
    ids.map((id) => ({ updateOne: { filter: { _id: id }, update: { $set: { shelfCount: byRack.get(String(id)) || 0 } } } }))
  );
}

/** Map shelfId -> { pieces, products, units } (one aggregation). */
async function shelfStockTotals(branchId, shelfIds = null) {
  const match = { branch: oid(branchId), qty: { $gt: 0 } };
  if (shelfIds) match.shelf = { $in: shelfIds.map((id) => oid(id)).filter(Boolean) };
  const rows = await LocationStock.aggregate([
    { $match: match },
    { $group: { _id: '$shelf', pieces: { $sum: '$qty' }, units: { $sum: 1 }, products: { $addToSet: '$product' } } },
    { $project: { pieces: 1, units: 1, products: { $size: '$products' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { pieces: r.pieces, units: r.units, products: r.products }]));
}

/** 409 when any of these shelves still holds pieces. */
async function assertShelvesEmpty(branchId, shelves, what) {
  if (!shelves.length) return;
  const totals = await shelfStockTotals(branchId, shelves.map((s) => s._id));
  const full = shelves.filter((s) => (totals.get(String(s._id))?.pieces || 0) > 0);
  if (!full.length) return;
  const pieces = full.reduce((sum, s) => sum + totals.get(String(s._id)).pieces, 0);
  throw httpError(
    `${what} still holds ${pieces} piece(s) on ${full.map((s) => s.code).join(', ')}. Move them to another shelf or the warehouse first.`,
    409,
    { code: 'LOCATION_HAS_STOCK' }
  );
}

const shelfView = (s, totals) => {
  const t = totals.get(String(s._id)) || { pieces: 0, products: 0, units: 0 };
  return {
    _id: String(s._id),
    rack: String(s.rack),
    rackCode: s.rackCode,
    code: s.code,
    level: s.level,
    name: s.name || '',
    capacity: s.capacity ?? null,
    isActive: s.isActive !== false,
    pieces: t.pieces,
    products: t.products,
    units: t.units,
  };
};

/** Racks (lean) -> API shape with shelves[] (by level) and stock numbers. */
async function decorateRacks(branchId, racks) {
  if (!racks.length) return [];
  const shelves = await Shelf.find({ rack: { $in: racks.map((r) => r._id) } })
    .sort({ level: 1 })
    .lean();
  const totals = await shelfStockTotals(branchId, shelves.map((s) => s._id));
  const byRack = new Map();
  for (const s of shelves) {
    const key = String(s.rack);
    if (!byRack.has(key)) byRack.set(key, []);
    byRack.get(key).push(shelfView(s, totals));
  }
  return racks.map((r) => {
    const list = byRack.get(String(r._id)) || [];
    return {
      _id: String(r._id),
      branch: String(r.branch),
      zone: r.zone,
      number: r.number,
      code: r.code,
      name: r.name || '',
      description: r.description || '',
      categories: r.categories || [],
      shelfCount: r.shelfCount || 0,
      sortOrder: r.sortOrder || 0,
      isActive: r.isActive !== false,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      shelves: list,
      pieces: list.reduce((s, x) => s + x.pieces, 0),
      products: list.reduce((s, x) => s + x.products, 0),
      usedShelves: list.filter((x) => x.pieces > 0).length,
    };
  });
}

const RACK_SORT = { sortOrder: 1, zone: 1, number: 1 };

async function loadRack(branchId, rackId) {
  const rack = await Rack.findOne({ _id: requireId(rackId, 'rack'), branch: oid(branchId) }).lean();
  if (!rack) throw httpError('Rack not found', 404);
  return rack;
}

async function loadShelfOf(branchId, shelfId) {
  const shelf = await Shelf.findOne({ _id: requireId(shelfId, 'shelf'), branch: oid(branchId) }).lean();
  if (!shelf) throw httpError('Shelf not found', 404);
  return shelf;
}

// ---------------------------------------------------------------------------
// Layout generator
// ---------------------------------------------------------------------------

/**
 * Create racks <zone><1..racksPerZone> with shelves S1..S<shelvesPerRack>.
 * Idempotent: existing racks / shelves are kept as they are (even inactive
 * ones); only missing codes are created. Bulk inserts (80 racks + 320 shelves
 * = 2 inserts).
 */
async function generateLayout({ branchId, zones, racksPerZone, shelvesPerRack, userId = null }) {
  const branch = oid(branchId);
  if (!branch) throw httpError('Choose a branch first');
  const zoneList = parseZones(zones ?? ['A', 'B', 'C', 'D']);
  const perZone = intIn(racksPerZone, 1, LIMITS.racksPerZone, 'Racks per zone', 20);
  const perRack = intIn(shelvesPerRack, 1, LIMITS.shelvesPerRack, 'Shelves per rack', 4);
  if (zoneList.length * perZone > LIMITS.totalRacks) {
    throw httpError(`That is ${zoneList.length * perZone} racks. At most ${LIMITS.totalRacks} racks per run.`);
  }

  const wanted = [];
  zoneList.forEach((zone) => {
    for (let n = 1; n <= perZone; n++) wanted.push({ zone, number: n, code: `${zone}${n}` });
  });
  const codes = wanted.map((w) => w.code);

  const existing = await Rack.find({ branch, code: { $in: codes } }).select('code').lean();
  const have = new Set(existing.map((r) => r.code));
  const newRacks = wanted
    .filter((w) => !have.has(w.code))
    .map((w) => ({ branch, zone: w.zone, number: w.number, code: w.code, shelfCount: 0, isActive: true, isDeleted: false, createdBy: oid(userId) }));
  const racksCreated = await insertManySafe(Rack, newRacks);

  // All wanted racks (re-read: covers a parallel run) -> missing shelf codes.
  const racks = await Rack.find({ branch, code: { $in: codes } }).select('_id code isActive').lean();
  const wantedShelves = [];
  for (const r of racks) {
    for (let level = 1; level <= perRack; level++) wantedShelves.push({ rack: r, level, code: shelfCodeOf(r.code, level) });
  }
  const existingShelves = await Shelf.find({ branch, code: { $in: wantedShelves.map((s) => s.code) } }).select('code').lean();
  const haveShelf = new Set(existingShelves.map((s) => s.code));
  const newShelves = wantedShelves
    .filter((s) => !haveShelf.has(s.code))
    .map((s) => ({
      branch,
      rack: s.rack._id,
      rackCode: s.rack.code,
      level: s.level,
      code: s.code,
      isActive: s.rack.isActive !== false,
      isDeleted: false,
    }));
  const shelvesCreated = await insertManySafe(Shelf, newShelves);
  await syncShelfCounts(racks.map((r) => r._id));

  return {
    zones: zoneList,
    racksPerZone: perZone,
    shelvesPerRack: perRack,
    racksCreated,
    racksSkipped: wanted.length - racksCreated,
    shelvesCreated,
    shelvesSkipped: wantedShelves.length - shelvesCreated,
  };
}

// ---------------------------------------------------------------------------
// Racks
// ---------------------------------------------------------------------------

/**
 * Racks of a branch, natural order (A2 < A10), each with shelves[] + stock.
 * Optional paging (limit); without it all racks are returned (max 2000).
 */
async function listRacks({ branchId, zone, search, isActive, page, limit } = {}) {
  const branch = oid(branchId);
  if (!branch) throw httpError('Choose a branch first');
  const filter = { branch };
  if (zone) filter.zone = String(zone).trim().toUpperCase();
  const active = parseBool(isActive);
  if (active !== undefined) filter.isActive = active;
  const term = String(search ?? '').trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    const or = [{ code: rx }, { name: rx }, { description: rx }, { categories: rx }];
    // "A3-S2" / "a3-s" -> rack A3
    const m = /^([A-Z]{1,2}\d+)-S?\d*$/.exec(term.toUpperCase());
    if (m) or.push({ code: m[1] });
    filter.$or = or;
  }

  const lim = limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 50)) : 2000;
  const pg = limit ? Math.max(1, parseInt(page, 10) || 1) : 1;
  const [racks, total, zoneRows] = await Promise.all([
    Rack.find(filter).sort(RACK_SORT).skip((pg - 1) * lim).limit(lim).lean(),
    Rack.countDocuments(filter),
    Rack.aggregate([
      { $match: { isDeleted: { $ne: true }, branch } },
      { $group: { _id: '$zone', racks: { $sum: 1 }, shelves: { $sum: '$shelfCount' } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  return {
    items: await decorateRacks(branch, racks),
    total,
    page: pg,
    limit: lim,
    zones: zoneRows.map((z) => ({ zone: z._id, racks: z.racks, shelves: z.shelves })),
  };
}

async function getRack({ branchId, rackId }) {
  const rack = await loadRack(branchId, rackId);
  const [view] = await decorateRacks(branchId, [rack]);
  return view;
}

/** One rack (zone + number -> code) with `shelves` levels (default 4). */
async function createRack({ branchId, zone, number, name, description, categories, shelves, sortOrder, userId = null }) {
  const branch = oid(branchId);
  if (!branch) throw httpError('Choose a branch first');
  const z = parseZone(zone);
  const n = intIn(number, 1, LIMITS.rackNumber, 'Rack number');
  const levels = intIn(shelves, 0, LIMITS.shelvesPerRack, 'Shelves', 4);
  const code = `${z}${n}`;
  if (await Rack.exists({ branch, code })) throw httpError(`Rack ${code} already exists`, 409, { code: 'RACK_EXISTS' });

  let rack;
  try {
    rack = await Rack.create({
      branch,
      zone: z,
      number: n,
      code,
      name: str(name, 60),
      description: str(description, 300),
      categories: parseCategories(categories) || [],
      sortOrder: intIn(sortOrder, -100000, 100000, 'Sort order', 0),
      createdBy: oid(userId),
    });
  } catch (err) {
    if (err.code === 11000) throw httpError(`Rack ${code} already exists`, 409, { code: 'RACK_EXISTS' });
    throw err;
  }
  const docs = [];
  for (let level = 1; level <= levels; level++) {
    docs.push({ branch, rack: rack._id, rackCode: code, level, code: shelfCodeOf(code, level), isActive: true, isDeleted: false });
  }
  await insertManySafe(Shelf, docs);
  await syncShelfCounts([rack._id]);
  return getRack({ branchId: branch, rackId: rack._id });
}

/** name, description, categories, sortOrder, isActive. Code / zone never change (printed labels). */
async function updateRack({ branchId, rackId, body = {} }) {
  const rack = await loadRack(branchId, rackId);
  const set = {};
  if (body.name !== undefined) set.name = str(body.name, 60);
  if (body.description !== undefined) set.description = str(body.description, 300);
  if (body.categories !== undefined) set.categories = parseCategories(body.categories);
  if (body.sortOrder !== undefined) set.sortOrder = intIn(body.sortOrder, -100000, 100000, 'Sort order', 0);
  const active = parseBool(body.isActive);
  const shelves = await Shelf.find({ rack: rack._id }).select('_id code isActive').lean();

  if (active === false && rack.isActive !== false) {
    await assertShelvesEmpty(branchId, shelves, `Rack ${rack.code}`);
  }
  if (active !== undefined) set.isActive = active;
  if (Object.keys(set).length) await Rack.updateOne({ _id: rack._id }, { $set: set });
  // Rack on/off switches all of its shelves with it.
  if (active !== undefined && active !== (rack.isActive !== false)) {
    await Shelf.updateMany({ rack: rack._id }, { $set: { isActive: active } });
    await syncShelfCounts([rack._id]);
  }
  return getRack({ branchId, rackId: rack._id });
}

/** Soft delete a rack and its shelves (409 while any shelf holds pieces). */
async function deleteRack({ branchId, rackId, userId = null }) {
  const rack = await loadRack(branchId, rackId);
  const shelves = await Shelf.find({ rack: rack._id }).select('_id code').lean();
  await assertShelvesEmpty(branchId, shelves, `Rack ${rack.code}`);
  const stamp = { isDeleted: true, deletedAt: new Date(), deletedBy: oid(userId) };
  await Shelf.updateMany({ rack: rack._id }, { $set: { ...stamp, isActive: false } });
  await Rack.updateOne({ _id: rack._id }, { $set: { ...stamp, shelfCount: 0 } });
  // Leftover "home shelf" markers (qty 0) pointed at these shelves.
  if (shelves.length) await LocationStock.deleteMany({ shelf: { $in: shelves.map((s) => s._id) }, qty: { $lte: 0 } });
  return { _id: String(rack._id), code: rack.code, shelvesRemoved: shelves.length };
}

// ---------------------------------------------------------------------------
// Shelves
// ---------------------------------------------------------------------------

/** Add the next level to a rack (A1 with S1..S4 -> A1-S5). */
async function addShelf({ branchId, rackId, body = {} }) {
  const rack = await loadRack(branchId, rackId);
  const last = await Shelf.findOne({ rack: rack._id }).sort({ level: -1 }).select('level').lean();
  const level = (last ? last.level : 0) + 1;
  if (level > LIMITS.maxLevel) throw httpError(`A rack can have at most ${LIMITS.maxLevel} shelves`);
  const code = shelfCodeOf(rack.code, level);
  try {
    await Shelf.create({
      branch: rack.branch,
      rack: rack._id,
      rackCode: rack.code,
      level,
      code,
      name: str(body.name, 60),
      capacity: parseCapacity(body.capacity) ?? null,
      isActive: rack.isActive !== false,
    });
  } catch (err) {
    if (err.code === 11000) throw httpError(`Shelf ${code} already exists. Please try again.`, 409, { code: 'SHELF_EXISTS' });
    throw err;
  }
  await syncShelfCounts([rack._id]);
  return getRack({ branchId, rackId: rack._id });
}

/** name, capacity, isActive (cannot switch off while it holds pieces). */
async function updateShelf({ branchId, shelfId, body = {} }) {
  const shelf = await loadShelfOf(branchId, shelfId);
  const set = {};
  if (body.name !== undefined) set.name = str(body.name, 60);
  const capacity = parseCapacity(body.capacity);
  if (capacity !== undefined) set.capacity = capacity;
  if (body.sortOrder !== undefined) set.sortOrder = intIn(body.sortOrder, -100000, 100000, 'Sort order', 0);
  const active = parseBool(body.isActive);
  if (active === false && shelf.isActive !== false) await assertShelvesEmpty(branchId, [shelf], `Shelf ${shelf.code}`);
  if (active === true && shelf.isActive === false) {
    const rack = await Rack.findById(shelf.rack).select('isActive code').lean();
    if (rack && rack.isActive === false) throw httpError(`Rack ${rack.code} is inactive. Activate the rack first.`);
  }
  if (active !== undefined) set.isActive = active;
  if (Object.keys(set).length) await Shelf.updateOne({ _id: shelf._id }, { $set: set });
  if (active !== undefined) await syncShelfCounts([shelf.rack]);
  const fresh = await Shelf.findById(shelf._id).lean();
  const totals = await shelfStockTotals(branchId, [shelf._id]);
  return shelfView(fresh, totals);
}

async function deleteShelf({ branchId, shelfId, userId = null }) {
  const shelf = await loadShelfOf(branchId, shelfId);
  await assertShelvesEmpty(branchId, [shelf], `Shelf ${shelf.code}`);
  await Shelf.updateOne(
    { _id: shelf._id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: oid(userId), isActive: false } }
  );
  await LocationStock.deleteMany({ shelf: shelf._id, qty: { $lte: 0 } });
  await syncShelfCounts([shelf.rack]);
  return { _id: String(shelf._id), code: shelf.code };
}

/**
 * Shelf picker list: [{ _id, code, rackCode, level, name, rackName, isActive, pieces }]
 * in natural order. Search matches shelf code / name and rack name / categories.
 */
async function listShelves({ branchId, search, rackId, includeInactive, limit } = {}) {
  const branch = oid(branchId);
  if (!branch) throw httpError('Choose a branch first');
  const filter = { branch };
  if (!parseBool(includeInactive)) filter.isActive = true;
  if (rackId) filter.rack = requireId(rackId, 'rack');
  const term = String(search ?? '').trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    const racks = await Rack.find({ branch, $or: [{ name: rx }, { categories: rx }, { code: rx }] }).select('_id').lean();
    filter.$or = [{ code: rx }, { name: rx }, { rack: { $in: racks.map((r) => r._id) } }];
  }
  const lim = Math.min(2000, Math.max(1, parseInt(limit, 10) || 1000));
  const shelves = await Shelf.find(filter).sort({ code: 1 }).collation(NATURAL).limit(lim).lean();
  const rackIds = [...new Set(shelves.map((s) => String(s.rack)))];
  const [racks, totals] = await Promise.all([
    Rack.find({ _id: { $in: rackIds } }).select('name code').lean(),
    shelfStockTotals(branch, shelves.map((s) => s._id)),
  ]);
  const rackName = new Map(racks.map((r) => [String(r._id), r.name || '']));
  return shelves.map((s) => {
    const t = totals.get(String(s._id)) || { pieces: 0, products: 0 };
    return {
      _id: String(s._id),
      code: s.code,
      rackCode: s.rackCode,
      rackId: String(s.rack),
      level: s.level,
      name: s.name || '',
      rackName: rackName.get(String(s.rack)) || '',
      capacity: s.capacity ?? null,
      isActive: s.isActive !== false,
      pieces: t.pieces,
      products: t.products,
    };
  });
}

/**
 * Shelves + racks to print labels for. scope: rackId | zone | all (default all).
 * Natural order. Inactive racks / shelves are skipped.
 */
async function labelTargets({ branchId, rackId, zone }) {
  const branch = oid(branchId);
  if (!branch) throw httpError('Choose a branch first');
  const rackFilter = { branch, isActive: true };
  if (rackId) rackFilter._id = requireId(rackId, 'rack');
  else if (zone) rackFilter.zone = parseZone(zone);
  const racks = await Rack.find(rackFilter).sort(RACK_SORT).lean();
  if (rackId && !racks.length) throw httpError('Rack not found (or it is inactive)', 404);
  const shelves = await Shelf.find({ rack: { $in: racks.map((r) => r._id) }, isActive: true }).sort({ level: 1 }).lean();
  const byRack = new Map();
  for (const s of shelves) {
    const k = String(s.rack);
    if (!byRack.has(k)) byRack.set(k, []);
    byRack.get(k).push(s);
  }
  return racks.map((r) => ({ rack: r, shelves: byRack.get(String(r._id)) || [] }));
}

/**
 * A unit has ONE home shelf: after marking `keepShelfId` as home, drop the
 * home flag elsewhere in the branch (empty marker rows are removed).
 */
async function clearOtherHomeShelves({ branchId, productId, variantKey = null, keepShelfId }) {
  const base = { branch: oid(branchId), product: oid(productId), variantId: variantKey ?? null, shelf: { $ne: oid(keepShelfId) } };
  await LocationStock.updateMany({ ...base, isHome: true }, { $set: { isHome: false } });
  await LocationStock.deleteMany({ ...base, isHome: { $ne: true }, qty: { $lte: 0 } });
}

module.exports = {
  LIMITS,
  clearOtherHomeShelves,
  parseZones,
  generateLayout,
  listRacks,
  getRack,
  createRack,
  updateRack,
  deleteRack,
  addShelf,
  updateShelf,
  deleteShelf,
  listShelves,
  shelfStockTotals,
  labelTargets,
  syncShelfCounts,
};
