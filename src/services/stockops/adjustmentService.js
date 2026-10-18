// src/services/stockops/adjustmentService.js
// Stock counts and manual corrections.
//
//   count mode (reason count_correction): each line has countedQty; the server
//     reads the system qty when the sheet is saved and diff = counted - system.
//   qty mode (found / lost / opening / other): each line has a signed diff
//     (found & opening must be +, lost must be -).
//   apply: + lines -> receiveStock (adjustment_in, or 'opening'),
//          - lines -> deductStock (adjustment_out). One ledger row per line.
// The diff saved with the sheet is applied (the system qty is frozen when the
// sheet is saved, so sales after the count do not change the correction).
// Retry safe: processing claim + per-line `applied` flag + ledger check.
const StockAdjustment = require('../../models/stockAdjustment');
const StockMovement = require('../../models/stockMovement');
const stockService = require('../stockService');
const { nextNumber } = require('../sequenceService');
const { lookupCode } = require('./productLookup');
const {
  round2,
  round4,
  httpError,
  toObjectId,
  toInt,
  escapeRegex,
  pktRangeFilter,
  pageParams,
  pageMeta,
  loadProductLean,
  pickUnit,
  unitSnapshot,
  unitAvailable,
  userName,
  historyEntry,
  STALE_LOCK_MS,
} = require('./common');

const MAX_LINES = 500;
const USER_FIELDS = 'firstName lastName email';
const REASON_LABELS = {
  count_correction: 'Stock count correction',
  found: 'Found stock',
  lost: 'Lost stock',
  opening: 'Opening stock',
  other: 'Other',
};

const view = (d) => {
  if (!d) return d;
  const o = typeof d.toObject === 'function' ? d.toObject() : { ...d };
  o.createdByName = userName(o.createdBy);
  o.appliedByName = userName(o.appliedBy);
  delete o.processingAt;
  delete o.requestId;
  return o;
};

const populateUsers = (q) => q.populate('createdBy', USER_FIELDS).populate('appliedBy', USER_FIELDS);

async function findScoped(id, scope = {}) {
  const _id = toObjectId(id);
  if (!_id) throw httpError('Invalid adjustment id', 400);
  const doc = await StockAdjustment.findOne({ _id, ...scope });
  if (!doc) throw httpError('Stock adjustment not found', 404);
  return doc;
}

const hasValue = (v) => v !== undefined && v !== null && v !== '';

/** Validated lines with system qty / diff / cost computed on the server. */
async function buildLines(rawLines, reason, branchId) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw httpError('Add at least one product', 400);
  if (rawLines.length > MAX_LINES) throw httpError(`At most ${MAX_LINES} lines per sheet`, 400);
  const countMode = reason === 'count_correction';
  const merged = new Map();
  for (const raw of rawLines) {
    let productId = raw && raw.productId;
    let variantId = (raw && raw.variantId) || null;
    if (!productId && raw && raw.code) {
      const hit = await lookupCode(raw.code, branchId);
      if (hit.needsVariant && !variantId) throw httpError(`Choose a variant of ${hit.name}`, 400, 'VARIANT_REQUIRED');
      productId = hit.productId;
      variantId = variantId || hit.variantId;
    }
    if (!productId) throw httpError('Every line needs a product', 400);
    const product = await loadProductLean(productId);
    const picked = pickUnit(product, variantId);
    const key = `${product._id}:${picked.variantId || ''}`;
    const counted = hasValue(raw.countedQty) ? toInt(raw.countedQty, NaN) : null;
    const diff = hasValue(raw.diff) ? toInt(raw.diff, NaN) : null;
    if (countMode) {
      if (counted === null || !Number.isFinite(counted) || counted < 0) {
        throw httpError(`Enter the counted qty (0 or more) for ${product.name}`, 400);
      }
    } else if (counted === null && (diff === null || !Number.isFinite(diff) || diff === 0)) {
      throw httpError(`Enter how many pieces to add or remove for ${product.name}`, 400);
    }
    const prev = merged.get(key);
    if (prev) {
      // The same item twice on one sheet: add the counts / diffs up.
      if (counted !== null) prev.counted = (prev.counted || 0) + counted;
      if (diff !== null) prev.diff = (prev.diff || 0) + diff;
    } else {
      merged.set(key, { product, picked, counted, diff });
    }
  }

  const lines = [];
  for (const { product, picked, counted, diff } of merged.values()) {
    const snap = unitSnapshot(product, picked);
    const systemQty = await unitAvailable(picked.unit, branchId);
    const lineDiff = counted !== null ? counted - systemQty : diff;
    const label = `${snap.productName}${snap.variantLabel ? ` (${snap.variantLabel})` : ''}`;
    if ((reason === 'found' || reason === 'opening') && !(lineDiff > 0)) throw httpError(`${label}: "${REASON_LABELS[reason]}" can only add stock`, 400);
    if (reason === 'lost' && !(lineDiff < 0)) throw httpError(`${label}: "Lost stock" can only remove stock`, 400);
    if (lineDiff < 0 && -lineDiff > systemQty) throw httpError(`${label}: only ${systemQty} piece(s) in stock, cannot remove ${-lineDiff}`, 400);
    lines.push({
      product: product._id,
      variantId: snap.variantId,
      productName: snap.productName,
      variantLabel: snap.variantLabel,
      code: snap.code,
      systemQty,
      countedQty: counted,
      diff: lineDiff,
      unitCost: round4(snap.unitCost),
      applied: false,
    });
  }
  return lines;
}

const totalsOf = (lines) => {
  const t = { lines: lines.length, piecesIn: 0, piecesOut: 0, valueIn: 0, valueOut: 0 };
  for (const l of lines) {
    if (l.diff > 0) {
      t.piecesIn += l.diff;
      t.valueIn += l.diff * (l.unitCost || 0);
    } else if (l.diff < 0) {
      t.piecesOut += -l.diff;
      t.valueOut += -l.diff * (l.unitCost || 0);
    }
  }
  t.valueIn = round2(t.valueIn);
  t.valueOut = round2(t.valueOut);
  return t;
};

const checkReason = (reason) => {
  const r = reason || 'count_correction';
  if (!StockAdjustment.REASONS.includes(r)) throw httpError('Choose a valid reason', 400);
  return r;
};

/** input: { reason, notes, lines: [{ productId, variantId, countedQty | diff } | { code, ... }], apply, requestId } */
async function create(input = {}, { branchId, userId } = {}) {
  const requestId = input.requestId ? String(input.requestId).slice(0, 80) : null;
  if (requestId) {
    const existing = await StockAdjustment.findOne({ requestId });
    if (existing) return input.apply && existing.status === 'draft' ? apply(existing._id, { userId }) : existing;
  }
  const reason = checkReason(input.reason);
  const lines = await buildLines(input.lines, reason, branchId);
  let doc;
  try {
    doc = await StockAdjustment.create({
      adjNo: await nextNumber('ADJ'),
      branch: toObjectId(branchId),
      reason,
      lines,
      notes: String(input.notes || '').trim().slice(0, 1000),
      status: 'draft',
      totals: totalsOf(lines),
      createdBy: toObjectId(userId),
      ...(requestId ? { requestId } : {}),
      history: [historyEntry('created', userId)],
    });
  } catch (e) {
    if (e && e.code === 11000 && requestId) {
      const existing = await StockAdjustment.findOne({ requestId });
      if (existing) return existing;
    }
    throw e;
  }
  return input.apply ? apply(doc._id, { userId }) : doc;
}

/** Replace the lines / notes of a draft (system qty is read again). */
async function update(id, input = {}, { userId, scope = {} } = {}) {
  const doc = await findScoped(id, scope);
  if (doc.status !== 'draft') throw httpError('Only draft sheets can be changed', 409);
  if (doc.lines.some((l) => l.applied)) throw httpError('Some lines are already applied; apply the rest instead', 409);
  const reason = checkReason(input.reason || doc.reason);
  const lines = await buildLines(input.lines, reason, doc.branch);
  const out = await StockAdjustment.findOneAndUpdate(
    { _id: doc._id, status: 'draft', processingAt: null },
    {
      $set: { reason, lines, totals: totalsOf(lines), notes: hasValue(input.notes) ? String(input.notes).trim().slice(0, 1000) : doc.notes },
      $push: { history: historyEntry('updated', userId) },
    },
    { new: true }
  );
  if (!out) throw httpError('This sheet is being applied right now', 409, 'IN_PROGRESS');
  return input.apply ? apply(out._id, { userId }) : out;
}

/** Move the stock for every line not applied yet. */
async function apply(id, { userId, scope = {} } = {}) {
  const found = await findScoped(id, scope);
  if (found.status === 'applied') return found;
  if (found.status === 'cancelled') throw httpError('This sheet was cancelled', 409);

  const now = new Date();
  const doc = await StockAdjustment.findOneAndUpdate(
    { _id: found._id, status: 'draft', $or: [{ processingAt: null }, { processingAt: { $lt: new Date(now - STALE_LOCK_MS) } }] },
    { $set: { processingAt: now } },
    { new: true }
  );
  if (!doc) throw httpError('This sheet is being applied right now. Please wait a moment.', 409, 'IN_PROGRESS');

  const failed = [];
  try {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i];
      if (line.applied) continue;
      const set = {};
      if (!line.diff) {
        set[`lines.${i}.applied`] = true;
      } else {
        const type = line.diff > 0 ? (doc.reason === 'opening' ? 'opening' : 'adjustment_in') : 'adjustment_out';
        try {
          const prev = await StockMovement.findOne({ refType: 'StockAdjustment', refId: doc._id, product: line.product, variantId: line.variantId || null })
            .select('_id')
            .lean();
          let movementId = prev ? prev._id : null;
          if (!prev) {
            const movement = {
              type,
              refType: 'StockAdjustment',
              refId: doc._id,
              refNo: doc.adjNo,
              userId,
              unitCost: line.unitCost,
              note: `${REASON_LABELS[doc.reason]}${line.countedQty !== null && line.countedQty !== undefined ? `: counted ${line.countedQty}, system ${line.systemQty}` : ''}`,
            };
            const out =
              line.diff > 0
                ? await stockService.receiveStock({ productId: line.product, variantId: line.variantId, quantity: line.diff, branchId: doc.branch, movement })
                : await stockService.deductStock({ productId: line.product, variantId: line.variantId, quantity: -line.diff, branchId: doc.branch, movement });
            movementId = out.movement && out.movement._id ? out.movement._id : null;
          }
          Object.assign(set, {
            [`lines.${i}.applied`]: true,
            [`lines.${i}.movement`]: movementId,
            [`lines.${i}.movementType`]: type,
            [`lines.${i}.error`]: '',
          });
        } catch (err) {
          if (!err || !err.status || err.status >= 500) throw err;
          failed.push(`${line.productName}: ${err.message}`);
          set[`lines.${i}.error`] = err.message;
        }
      }
      await StockAdjustment.updateOne({ _id: doc._id }, { $set: set });
    }

    if (failed.length) {
      await StockAdjustment.updateOne({ _id: doc._id }, { $set: { processingAt: null } });
      throw httpError(`${failed.length} line(s) could not be applied — ${failed.join('; ')}`, 400, 'PARTIAL_APPLY');
    }
    return await StockAdjustment.findOneAndUpdate(
      { _id: doc._id },
      {
        $set: { status: 'applied', appliedBy: toObjectId(userId), appliedAt: new Date(), processingAt: null },
        $push: { history: historyEntry('applied', userId) },
      },
      { new: true }
    );
  } catch (err) {
    await StockAdjustment.updateOne({ _id: doc._id, processingAt: now }, { $set: { processingAt: null } });
    throw err;
  }
}

async function cancel(id, { userId, scope = {} } = {}) {
  const doc = await findScoped(id, scope);
  if (doc.status === 'cancelled') return doc;
  if (doc.status === 'applied' || doc.lines.some((l) => l.applied)) throw httpError('Applied sheets cannot be cancelled', 409);
  const out = await StockAdjustment.findOneAndUpdate(
    { _id: doc._id, status: 'draft', processingAt: null },
    { $set: { status: 'cancelled' }, $push: { history: historyEntry('cancelled', userId) } },
    { new: true }
  );
  if (!out) throw httpError('This sheet is being applied right now', 409, 'IN_PROGRESS');
  return out;
}

async function list(query = {}, scope = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope };
  if (['draft', 'applied', 'cancelled'].includes(query.status)) filter.status = query.status;
  if (StockAdjustment.REASONS.includes(query.reason)) filter.reason = query.reason;
  const range = pktRangeFilter(query.from, query.to);
  if (range) filter.createdAt = range;
  const pid = toObjectId(query.productId);
  if (pid) filter['lines.product'] = pid;
  const s = String(query.search || '').trim();
  if (s) {
    const rx = new RegExp(escapeRegex(s), 'i');
    filter.$or = [{ adjNo: rx }, { notes: rx }, { 'lines.productName': rx }, { 'lines.code': rx }];
  }
  const [rows, total] = await Promise.all([
    populateUsers(StockAdjustment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)).lean(),
    StockAdjustment.countDocuments(filter),
  ]);
  return { data: rows.map(view), meta: pageMeta(page, limit, total) };
}

async function getOne(id, scope = {}) {
  const doc = await findScoped(id, scope);
  return view(await populateUsers(StockAdjustment.findById(doc._id)).lean());
}

module.exports = { REASON_LABELS, create, update, apply, cancel, list, getOne, view };
