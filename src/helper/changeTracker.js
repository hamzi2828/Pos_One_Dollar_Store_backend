// Data change log: a Mongoose plugin that records every create, update and
// delete on every model into the `change_logs` collection (models/changeLog.js),
// with the values before/after and who did it (helper/auditContext.js).
//
// Covered:  doc.save() / Model.create()          -> create | update
//           updateOne / updateMany / findOneAndUpdate / findByIdAndUpdate
//           replaceOne / findOneAndReplace          -> update (create on upsert)
//           deleteOne / deleteMany / findOneAndDelete / doc.deleteOne()
//                                                   -> delete (full document kept)
//           insertMany                              -> create
//           bulkWrite                               -> per document when the op
//                                                      filters by _id, else a summary
// Not covered: writes through Model.collection.* (raw driver). Use
// recordChange() from this file for those.
//
// Logging never breaks or blocks a write: every step is wrapped, and the log
// row is written after the change, without waiting for it.
const mongoose = require('mongoose');
const { getActor } = require('./auditContext');

const MAX_DOCS = 500;            // per-document rows for one updateMany/deleteMany
const MAX_VALUE_CHARS = 20000;   // one value bigger than this is stored as a marker
const MAX_ROW_CHARS = 200000;    // whole row budget

// Logs, counters, OTPs and polling tables: not business data, would flood the log.
const SKIP_MODELS = new Set([
  'AuditLog', 'ChangeLog', 'PerfLog', 'PosActivity', 'PurchasingLog', 'LabelPrint',
  'MessageOutbox', 'PortalOtp', 'SaleCounter', 'Notification', 'PrintJob',
  ...String(process.env.CHANGE_LOG_SKIP_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
// Changes to only these fields are not worth a row.
const IGNORE_FIELDS = new Set(['updatedAt', '__v', 'lastSeenAt']);
// Never stored: secrets and biometric templates.
const REDACT_KEY = /^(password|passwordhash|passenc|codehash|editkeyhash|otp|otphash|token|refreshtoken|resettoken|secret|apikey|api_key|template)$/i;

const ENABLED = process.env.CHANGE_LOG_ENABLED !== '0';

function skipModel(name) { return !ENABLED || !name || SKIP_MODELS.has(name); }
function warn(where, err) { if (err && err.name === 'CastError') return; console.error(`[changeLog] ${where}:`, err && err.message ? err.message : err); }

// ------------------------------------------------------------ value helpers

/** JSON-safe, redacted copy of a value (ObjectId -> hex, Date -> ISO, docs -> plain). */
function clean(v, depth = 0, rawKeys = false) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (depth > 15) return '[too deep]';
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  const bt = v._bsontype;
  if (bt === 'ObjectId' || bt === 'ObjectID' || bt === 'Decimal128' || bt === 'Long') return v.toString();
  if (Buffer.isBuffer(v) || bt === 'Binary') return `[binary ${v.length || v.position || 0} bytes]`;
  if (v instanceof Map) v = Object.fromEntries(v);
  else if (typeof v.toObject === 'function' && !Array.isArray(v)) {
    try { v = v.toObject({ depopulate: true, virtuals: false, getters: false, transform: false, flattenMaps: true }); } catch { /* keep v */ }
  }
  if (Array.isArray(v)) return v.map((x) => { const c = clean(x, depth + 1, rawKeys); return c === undefined ? null : c; });
  const out = {};
  for (const k of Object.keys(v)) {
    const safeKey = rawKeys ? k : k.replace(/^\$/, '_$').replace(/\./g, '_');
    if (REDACT_KEY.test(k)) { if (v[k] != null && v[k] !== '') out[safeKey] = '[redacted]'; continue; }
    const c = clean(v[k], depth + 1, rawKeys);
    if (c !== undefined) out[safeKey] = c;
  }
  return out;
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasIds = (arr) => arr.length > 0 && arr.every((x) => isObj(x) && x._id != null);

/** [{ path, from, to }] between two cleaned objects. Arrays of subdocs are matched by _id. */
function diff(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (!prefix && IGNORE_FIELDS.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (same(x, y)) continue;
    if (isObj(x) && isObj(y)) { diff(x, y, path, out); continue; }
    if (Array.isArray(x) && Array.isArray(y) && hasIds(x) && hasIds(y)) {
      const mx = new Map(x.map((i) => [String(i._id), i]));
      const my = new Map(y.map((i) => [String(i._id), i]));
      for (const [id, item] of mx) {
        if (!my.has(id)) out.push({ path: `${path}[${id}]`, from: item, to: null });
        else diff(item, my.get(id), `${path}[${id}]`, out);
      }
      for (const [id, item] of my) if (!mx.has(id)) out.push({ path: `${path}[${id}]`, from: null, to: item });
      continue;
    }
    out.push({ path, from: x === undefined ? null : x, to: y === undefined ? null : y });
  }
  return out;
}

function shrinkValue(v) {
  if (v == null) return v;
  const s = JSON.stringify(v);
  return s && s.length > MAX_VALUE_CHARS ? `[too large: ${s.length} chars]` : v;
}

/** Keep the row under MAX_ROW_CHARS: big values become markers. */
function fitRow(row) {
  if (JSON.stringify(row).length <= MAX_ROW_CHARS) return row;
  row.truncated = true;
  if (Array.isArray(row.changes)) row.changes = row.changes.map((c) => ({ path: c.path, from: shrinkValue(c.from), to: shrinkValue(c.to) }));
  for (const key of ['before', 'after']) {
    if (isObj(row[key])) for (const k of Object.keys(row[key])) row[key][k] = shrinkValue(row[key][k]);
  }
  if (JSON.stringify(row).length > MAX_ROW_CHARS) {
    if (Array.isArray(row.changes)) row.changes = row.changes.slice(0, 200);
    for (const key of ['before', 'after']) if (row[key]) row[key] = { _note: 'document too large to store' };
  }
  return row;
}

const pick = (obj, keys) => {
  if (!keys) return obj;
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};
const topOf = (paths) => [...new Set(paths.map((p) => String(p).split('.')[0]).filter(Boolean))];
const asJson = (v) => { try { const s = JSON.stringify(clean(v, 0, true)); return s && s.length > 5000 ? `${s.slice(0, 5000)}…` : s; } catch { return null; } };

/** Top-level fields an update touches; null = unknown (pipeline / replace) -> whole doc. */
function touchedFields(update) {
  if (!update || Array.isArray(update)) return null;
  const set = new Set();
  for (const k of Object.keys(update)) {
    const v = update[k];
    if (k.startsWith('$')) { if (isObj(v)) for (const p of Object.keys(v)) set.add(p.split('.')[0]); } else set.add(k.split('.')[0]);
  }
  set.delete('');
  return set.size ? [...set] : null;
}
const projectionOf = (fields) => (fields ? Object.fromEntries(fields.map((f) => [f, 1])) : undefined);

// ------------------------------------------------------------ writing rows

let ChangeLog = null;
function changeLogModel() {
  if (!ChangeLog) ChangeLog = require('../models/changeLog');
  return ChangeLog;
}

function toObjectId(id) {
  return id && mongoose.Types.ObjectId.isValid(id) && String(id).length === 24 ? new mongoose.Types.ObjectId(String(id)) : null;
}

/** Write rows (fire and forget). Each row: { model, docId, operation, ... } + actor ctx. */
function writeRows(rows, ctx) {
  if (!rows.length) return;
  const actor = ctx || getActor();
  const now = new Date();
  const docs = rows.map((r) => fitRow({
    ...r,
    docId: r.docId != null ? String(r.docId) : null,
    source: actor.source || 'api',
    userId: toObjectId(actor.userId),
    employeeId: actor.employeeId || null,
    actorKind: actor.actorKind || null,
    actorName: actor.actorName || null,
    actorEmail: actor.actorEmail || null,
    ipAddress: actor.ipAddress || null,
    userAgent: actor.userAgent || null,
    method: actor.method || null,
    path: actor.path || null,
    requestId: actor.requestId || null,
    createdAt: now,
  }));
  // Raw driver insert: no hooks, no casting cost on the hot path.
  changeLogModel().collection.insertMany(docs, { ordered: false }).catch((err) => warn('write', err));
}

/**
 * Manual entry for writes that bypass Mongoose (Model.collection.*).
 * recordChange({ model: 'POSOrder', docId, operation: 'update', changes: [{ path, from, to }] })
 */
function recordChange(row) {
  try {
    const r = { ...row };
    if (r.before) r.before = clean(r.before);
    if (r.after) r.after = clean(r.after);
    if (Array.isArray(r.changes)) r.changes = r.changes.map((c) => ({ path: c.path, from: clean(c.from), to: clean(c.to) }));
    if (r.filter && typeof r.filter !== 'string') r.filter = asJson(r.filter);
    if (r.update && typeof r.update !== 'string') r.update = asJson(r.update);
    writeRows([r]);
  } catch (err) { warn('recordChange', err); }
}

function updateRow(model, op, id, before, after) {
  const changes = diff(before, after);
  if (!changes.length) return null;
  // Soft delete (isDeleted -> true) is a delete for whoever reads the log.
  const softDeleted = changes.some((c) => c.path === 'isDeleted' && c.to === true && c.from !== true);
  return {
    model: model.modelName, collectionName: model.collection.collectionName, docId: id, operation: softDeleted ? 'delete' : 'update',
    op: softDeleted ? `${op} (soft delete)` : op,
    changedFields: topOf(changes.map((c) => c.path.replace(/\[.*$/, ''))), changes,
  };
}
const createRow = (model, op, doc) => ({
  model: model.modelName, collectionName: model.collection.collectionName, docId: doc && doc._id, operation: 'create', op, after: doc,
});
const deleteRow = (model, op, doc) => ({
  model: model.modelName, collectionName: model.collection.collectionName, docId: doc && doc._id, operation: 'delete', op, before: doc,
});

// ------------------------------------------------------------ hooks

const UPDATE_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'];
const REPLACE_OPS = new Set(['replaceOne', 'findOneAndReplace']);
const DELETE_OPS = ['deleteOne', 'deleteMany', 'findOneAndDelete'];
const MANY_OPS = new Set(['updateMany', 'deleteMany']);
// Internal reads must also see soft-deleted rows (helper/softDeletePlugin.js).
const RAW_READ = { withDeleted: true };

function sessionOf(q) { const o = q.getOptions ? q.getOptions() : {}; return o.session || undefined; }

/** Matching docs before a query write (same filter, sort, session). */
async function findTargets(query, fields) {
  const many = MANY_OPS.has(query.op);
  const opts = query.getOptions();
  // withDeleted: the write's own filter already holds any soft-delete scope.
  let q = query.model.find(query.getFilter()).setOptions(RAW_READ).lean().limit(many ? MAX_DOCS + 1 : 1);
  if (fields) q = q.select(projectionOf([...fields, '_id']));
  if (!many && opts.sort) q = q.sort(opts.sort);
  const session = sessionOf(query);
  if (session) q = q.session(session);
  return q.exec();
}

function unwrapResult(res) {
  // findOneAndUpdate with includeResultMetadata returns { value, ok, lastErrorObject }
  if (res && typeof res === 'object' && 'lastErrorObject' in res && 'value' in res) return res.value;
  return res;
}

async function preQueryUpdate() {
  try {
    if (skipModel(this.model && this.model.modelName)) return;
    const update = this.getUpdate();
    const fields = REPLACE_OPS.has(this.op) ? null : touchedFields(update);
    const before = await findTargets(this, fields);
    this._changeLog = { ctx: getActor(), fields, before, update };
  } catch (err) { warn(`pre ${this.op}`, err); }
}

async function postQueryUpdate(res) {
  const st = this._changeLog;
  if (!st) return;
  this._changeLog = null;
  try {
    const model = this.model;
    const many = MANY_OPS.has(this.op);
    const overflow = st.before.length > MAX_DOCS;
    const before = overflow ? st.before.slice(0, MAX_DOCS) : st.before;
    const ids = before.map((d) => d._id);
    const rows = [];

    // Upsert that inserted a new document
    let upsertedId = res && (res.upsertedId || (res.upserted && res.upserted[0] && res.upserted[0]._id));
    if (!upsertedId && !ids.length && !many) {
      const doc = unwrapResult(res);
      if (doc && doc._id) upsertedId = doc._id;
    }

    if (ids.length) {
      let q = model.find({ _id: { $in: ids } }).setOptions(RAW_READ).lean();
      if (st.fields) q = q.select(projectionOf([...st.fields, '_id']));
      const session = sessionOf(this);
      if (session) q = q.session(session);
      const after = await q.exec();
      const byId = new Map(after.map((d) => [String(d._id), d]));
      for (const b of before) {
        const a = byId.get(String(b._id));
        const row = updateRow(model, this.op, b._id, pick(clean(b), st.fields), pick(clean(a || {}), st.fields));
        if (row) rows.push(row);
      }
    }
    if (upsertedId) {
      const doc = await model.findById(upsertedId).setOptions(RAW_READ).lean();
      if (doc) rows.push(createRow(model, this.op, clean(doc)));
    }
    if (overflow) {
      rows.push({
        model: model.modelName, collectionName: model.collection.collectionName, docId: null, operation: 'update', op: this.op,
        filter: asJson(this.getFilter()), update: asJson(st.update), truncated: true,
        changes: [{ path: '_note', from: null, to: `More than ${MAX_DOCS} documents matched; only the first ${MAX_DOCS} are logged one by one.` }],
      });
    }
    writeRows(rows, st.ctx);
  } catch (err) { warn(`post ${this.op}`, err); }
}

async function preQueryDelete() {
  try {
    if (skipModel(this.model && this.model.modelName)) return;
    const before = await findTargets(this, null);
    this._changeLog = { ctx: getActor(), before };
  } catch (err) { warn(`pre ${this.op}`, err); }
}

function postQueryDelete(res) {
  const st = this._changeLog;
  if (!st) return;
  this._changeLog = null;
  try {
    // deleteOne/deleteMany report a count; nothing deleted -> nothing to log.
    if (res && typeof res.deletedCount === 'number' && res.deletedCount === 0) return;
    if (this.op === 'findOneAndDelete' && !unwrapResult(res)) return;
    const model = this.model;
    const docs = st.before.slice(0, MAX_DOCS);
    const rows = docs.map((d) => deleteRow(model, this.op, clean(d)));
    if (st.before.length > MAX_DOCS) {
      rows.push({
        model: model.modelName, collectionName: model.collection.collectionName, docId: null, operation: 'delete', op: this.op,
        filter: asJson(this.getFilter()), truncated: true,
        changes: [{ path: '_note', from: null, to: `More than ${MAX_DOCS} documents deleted; only the first ${MAX_DOCS} are kept.` }],
      });
    }
    writeRows(rows, st.ctx);
  } catch (err) { warn(`post ${this.op}`, err); }
}

function isSubdoc(doc) {
  return !!(doc.$isSubdocument || doc.$isSingleNested || doc.$isArraySubdocument
    || (typeof doc.ownerDocument === 'function' && doc.ownerDocument() !== doc));
}

async function preSave() {
  try {
    if (isSubdoc(this) || skipModel(this.constructor.modelName)) return;
    if (this.isNew) { this.$locals._changeLog = { ctx: getActor(), isNew: true }; return; }
    const fields = topOf(this.modifiedPaths()).filter((f) => !IGNORE_FIELDS.has(f));
    if (!fields.length) return;
    const session = this.$session && this.$session();
    const before = await this.constructor.collection.findOne(
      { _id: this._id },
      { projection: projectionOf(fields), ...(session ? { session } : {}) },
    );
    this.$locals._changeLog = { ctx: getActor(), isNew: false, fields, before };
  } catch (err) { warn('pre save', err); }
}

function postSave() {
  const st = this.$locals && this.$locals._changeLog;
  if (!st) return;
  this.$locals._changeLog = null;
  try {
    const model = this.constructor;
    const now = clean(this);
    if (st.isNew) return writeRows([createRow(model, 'save', now)], st.ctx);
    const row = updateRow(model, 'save', this._id, pick(clean(st.before || {}), st.fields), pick(now, st.fields));
    if (row) writeRows([row], st.ctx);
  } catch (err) { warn('post save', err); }
}

function postInsertMany(docs) {
  try {
    if (skipModel(this.modelName) || !Array.isArray(docs)) return;
    writeRows(docs.slice(0, MAX_DOCS * 4).map((d) => createRow(this, 'insertMany', clean(d))));
  } catch (err) { warn('post insertMany', err); }
}

/** Ids of the docs a bulkWrite op targets, when its filter is by _id. */
function bulkOpId(op) {
  const body = op.updateOne || op.updateMany || op.replaceOne || op.deleteOne || op.deleteMany;
  const f = body && body.filter;
  if (!f || f._id == null) return null;
  if (typeof f._id === 'object' && !f._id._bsontype && !(f._id instanceof mongoose.Types.ObjectId)) return null; // {$in: …}
  return String(f._id);
}

/** Wraps Model.bulkWrite (Mongoose has no per-op hooks for it). */
async function trackedBulkWrite(ops, options) {
  const original = mongoose.Model.bulkWrite;
  if (skipModel(this.modelName) || !Array.isArray(ops) || !ops.length) return original.call(this, ops, options);
  const ctx = getActor();
  let before = new Map();
  const ids = [];
  const summary = [];
  try {
    for (const op of ops) {
      const id = bulkOpId(op);
      if (id) ids.push(id);
      else if (!op.insertOne) summary.push(op);
    }
    if (ids.length) {
      const docs = await this.find({ _id: { $in: [...new Set(ids)].slice(0, MAX_DOCS * 4) } }).setOptions(RAW_READ).lean();
      before = new Map(docs.map((d) => [String(d._id), d]));
    }
  } catch (err) { warn('pre bulkWrite', err); }

  const res = await original.call(this, ops, options);

  try {
    const rows = [];
    for (const op of ops) if (op.insertOne && op.insertOne.document) rows.push(createRow(this, 'bulkWrite', clean(op.insertOne.document)));
    if (ids.length) {
      const docs = await this.find({ _id: { $in: [...new Set(ids)].slice(0, MAX_DOCS * 4) } }).setOptions(RAW_READ).lean();
      const after = new Map(docs.map((d) => [String(d._id), d]));
      for (const id of new Set(ids)) {
        const b = before.get(id);
        const a = after.get(id);
        if (b && !a) rows.push(deleteRow(this, 'bulkWrite', clean(b)));
        else if (!b && a) rows.push(createRow(this, 'bulkWrite', clean(a)));
        else if (b && a) { const r = updateRow(this, 'bulkWrite', id, clean(b), clean(a)); if (r) rows.push(r); }
      }
    }
    for (const op of summary.slice(0, MAX_DOCS)) {
      const type = Object.keys(op)[0];
      const body = op[type] || {};
      rows.push({
        model: this.modelName, collectionName: this.collection.collectionName, docId: null,
        operation: /delete/i.test(type) ? 'delete' : 'update', op: `bulkWrite.${type}`,
        filter: asJson(body.filter), update: asJson(body.update || body.replacement),
      });
    }
    writeRows(rows, ctx);
  } catch (err) { warn('post bulkWrite', err); }
  return res;
}

/** The plugin: register with mongoose.plugin(changeTracker) BEFORE any model is compiled. */
function changeTracker(schema) {
  schema.pre('save', preSave);
  schema.post('save', postSave);
  schema.pre(UPDATE_OPS, { document: false, query: true }, preQueryUpdate);
  schema.post(UPDATE_OPS, { document: false, query: true }, postQueryUpdate);
  schema.pre(DELETE_OPS, { document: false, query: true }, preQueryDelete);
  schema.post(DELETE_OPS, { document: false, query: true }, postQueryDelete);
  schema.post('insertMany', postInsertMany);
  schema.static('bulkWrite', trackedBulkWrite);
}

module.exports = { changeTracker, recordChange, diff, clean };
