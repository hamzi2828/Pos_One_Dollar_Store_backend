// src/services/stockops/shopUseService.js
// Items taken from our own stock for the shop's use -> stock out + an Expense.
//
//   create : pre-check stock, save the document, take every line out of stock
//            in one all-or-nothing step (stockService.deductOrderItems with type
//            'internal_use', warehouse first), then post the Expense
//            (category "Shop Use (from stock)", source 'shop_use').
//   void   : put each line back (restoreStock, 'adjustment_in', "reversal of SU-…")
//            and soft-delete the expense.
// Retry safe: client `requestId`, a processing claim, per-line `restored` flags and
// a look at the ledger (refType 'ShopUse') before any stock is moved twice.
const ShopUse = require('../../models/shopUse');
const Expense = require('../../models/expense');
const ExpenseCategory = require('../../models/expenseCategory');
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

const EXPENSE_CATEGORY = 'Shop Use (from stock)';
const MAX_LINES = 100;
const USER_FIELDS = 'firstName lastName email';

const view = (d) => {
  if (!d) return d;
  const o = typeof d.toObject === 'function' ? d.toObject() : { ...d };
  o.createdByName = userName(o.createdBy);
  o.takenByUserName = userName(o.takenBy);
  o.voidedByName = userName(o.voidedBy);
  delete o.processingAt;
  delete o.requestId;
  return o;
};

const populateUsers = (q) => q.populate('createdBy', USER_FIELDS).populate('takenBy', USER_FIELDS).populate('voidedBy', USER_FIELDS);

async function findScoped(id, scope = {}) {
  const _id = toObjectId(id);
  if (!_id) throw httpError('Invalid shop use id', 400);
  const doc = await ShopUse.findOne({ _id, ...scope });
  if (!doc) throw httpError('Shop use record not found', 404);
  return doc;
}

/** The expense category exists (created once, race safe). */
async function ensureCategory() {
  try {
    await ExpenseCategory.updateOne(
      { name: EXPENSE_CATEGORY },
      {
        $setOnInsert: {
          name: EXPENSE_CATEGORY,
          description: 'Items taken from our own stock for the shop, valued at average landed cost (posted automatically).',
          isActive: true,
        },
      },
      { upsert: true }
    );
  } catch (e) {
    if (!e || e.code !== 11000) throw e;
  }
}

const unitKey = (productId, variantId) => `${productId}:${variantId || ''}`;

/** Lines from the browser -> validated lines with cost snapshots (server-side totals). */
async function buildLines(rawLines, branchId) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw httpError('Add at least one item', 400);
  if (rawLines.length > MAX_LINES) throw httpError(`At most ${MAX_LINES} items per record`, 400);
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
    const qty = toInt(raw && raw.qty, 0);
    if (!productId) throw httpError('Every line needs a product', 400);
    if (qty < 1) throw httpError('Quantity must be at least 1 on every line', 400);
    const product = await loadProductLean(productId);
    if (product.isDeleted) throw httpError(`${product.name} was deleted`, 400);
    const picked = pickUnit(product, variantId);
    const key = unitKey(product._id, picked.variantId);
    const prev = merged.get(key);
    if (prev) prev.qty += qty;
    else merged.set(key, { product, picked, qty });
  }
  const lines = [];
  for (const { product, picked, qty } of merged.values()) {
    const snap = unitSnapshot(product, picked);
    const available = await unitAvailable(picked.unit, branchId);
    if (qty > available) {
      const err = httpError(`Only ${available} piece(s) of ${snap.productName}${snap.variantLabel ? ` (${snap.variantLabel})` : ''} are in stock`, 400, 'INSUFFICIENT_STOCK');
      err.available = available;
      throw err;
    }
    const unitCost = round4(snap.unitCost);
    lines.push({
      product: product._id,
      variantId: snap.variantId,
      productName: snap.productName,
      variantLabel: snap.variantLabel,
      code: snap.code,
      qty,
      unitCost,
      total: round2(unitCost * qty),
    });
  }
  return lines;
}

/** Allocations per line from the ledger rows of an earlier (crashed) attempt. */
const allocationsFromLedger = (doc, rows) =>
  doc.lines.map((l) => {
    const row = rows.find((r) => String(r.product) === String(l.product) && (r.variantId || null) === (l.variantId || null));
    return row ? row.batchAllocations || [] : [];
  });

/** Take the stock out (once) and post the expense (once). Returns the fresh document. */
async function finalize(docId, userId) {
  let doc = await ShopUse.findById(docId);
  if (!doc || doc.status !== 'active') return doc;

  if (!doc.stockDeducted) {
    const now = new Date();
    const claimed = await ShopUse.findOneAndUpdate(
      { _id: doc._id, stockDeducted: false, $or: [{ processingAt: null }, { processingAt: { $lt: new Date(now - STALE_LOCK_MS) } }] },
      { $set: { processingAt: now } },
      { new: true }
    );
    if (!claimed) return ShopUse.findById(doc._id); // another request is finishing it
    doc = claimed;
    let allocations;
    const done = await StockMovement.find({ refType: 'ShopUse', refId: doc._id, type: 'internal_use' }).lean();
    if (done.length) {
      allocations = allocationsFromLedger(doc, done);
    } else {
      try {
        const results = await stockService.deductOrderItems(
          doc.lines.map((l) => ({ product: l.product, variantId: l.variantId, quantity: l.qty, costPrice: l.unitCost })),
          {
            branchId: doc.branch,
            movement: {
              type: 'internal_use',
              strategy: 'warehouse_first',
              refType: 'ShopUse',
              refId: doc._id,
              refNo: doc.shopUseNo,
              userId,
              note: `Shop use: ${doc.purpose}`.slice(0, 300),
            },
          }
        );
        allocations = results.map((r) => (r && r.allocations) || []);
      } catch (err) {
        // Nothing was taken (deductOrderItems rolls back): drop the record.
        await ShopUse.deleteOne({ _id: doc._id, stockDeducted: false });
        throw err;
      }
    }
    const set = { stockDeducted: true, processingAt: null };
    allocations.forEach((a, i) => (set[`lines.${i}.allocations`] = a));
    doc = await ShopUse.findOneAndUpdate({ _id: doc._id }, { $set: set }, { new: true });
  }

  if (!doc.expense) {
    let exp = await Expense.findOne({ sourceType: 'ShopUse', sourceRef: doc._id, isDeleted: { $ne: true } });
    if (!exp) {
      await ensureCategory();
      const summary = doc.lines.map((l) => `${l.qty} x ${l.productName}${l.variantLabel ? ` (${l.variantLabel})` : ''}`).join(', ');
      exp = await Expense.create({
        title: `Shop use ${doc.shopUseNo}`,
        amount: round2(doc.totalCost),
        category: EXPENSE_CATEGORY,
        categories: [EXPENSE_CATEGORY],
        date: doc.date,
        paymentMethod: 'Other',
        reference: doc.shopUseNo,
        notes: `${doc.purpose} — ${summary}`.slice(0, 1000),
        branch: doc.branch,
        source: 'shop_use',
        sourceType: 'ShopUse',
        sourceRef: doc._id,
      });
    }
    doc = await ShopUse.findOneAndUpdate({ _id: doc._id }, { $set: { expense: exp._id } }, { new: true });
  }
  return doc;
}

/**
 * input: { lines: [{ productId, variantId, qty } | { code, qty }], purpose, takenBy (user id),
 *          takenByName, date, requestId }
 */
async function create(input = {}, { branchId, userId } = {}) {
  const requestId = input.requestId ? String(input.requestId).slice(0, 80) : null;
  if (requestId) {
    const existing = await ShopUse.findOne({ requestId });
    if (existing) return finalize(existing._id, userId);
  }
  const purpose = String(input.purpose || '').trim();
  if (!purpose) throw httpError('Write what the items are for (purpose)', 400);
  const lines = await buildLines(input.lines, branchId);

  let date = new Date();
  if (input.date) {
    const d = new Date(input.date);
    if (Number.isNaN(d.getTime())) throw httpError('Invalid date', 400);
    if (d.getTime() > Date.now() + 60 * 1000) throw httpError('Date cannot be in the future', 400);
    date = d;
  }

  let doc;
  try {
    doc = await ShopUse.create({
      shopUseNo: await nextNumber('SU'),
      branch: toObjectId(branchId),
      date,
      lines,
      purpose: purpose.slice(0, 300),
      takenBy: toObjectId(input.takenBy) || toObjectId(userId),
      takenByName: String(input.takenByName || '').trim().slice(0, 120),
      totalCost: round2(lines.reduce((s, l) => s + l.total, 0)),
      totalQty: lines.reduce((s, l) => s + l.qty, 0),
      status: 'active',
      createdBy: toObjectId(userId),
      ...(requestId ? { requestId } : {}),
      history: [historyEntry('created', userId, purpose)],
    });
  } catch (e) {
    if (e && e.code === 11000 && requestId) {
      const existing = await ShopUse.findOne({ requestId });
      if (existing) return finalize(existing._id, userId);
    }
    throw e;
  }
  return finalize(doc._id, userId);
}

/** Void: stock back in (once per line) and the expense soft-deleted. Safe to call twice. */
async function voidRecord(id, { userId, scope = {}, reason = '' } = {}) {
  const found = await findScoped(id, scope);
  if (found.status === 'voided') return found;

  const now = new Date();
  const doc = await ShopUse.findOneAndUpdate(
    { _id: found._id, status: 'active', $or: [{ processingAt: null }, { processingAt: { $lt: new Date(now - STALE_LOCK_MS) } }] },
    { $set: { processingAt: now } },
    { new: true }
  );
  if (!doc) throw httpError('This record is being processed right now. Please try again in a moment.', 409, 'IN_PROGRESS');

  try {
    // Stock may have been taken by a crashed request that never set the flag.
    let deducted = doc.stockDeducted;
    let allocations = doc.lines.map((l) => l.allocations || []);
    if (!deducted) {
      const done = await StockMovement.find({ refType: 'ShopUse', refId: doc._id, type: 'internal_use' }).lean();
      if (done.length) {
        deducted = true;
        allocations = allocationsFromLedger(doc, done);
      }
    }
    if (deducted) {
      for (let i = 0; i < doc.lines.length; i++) {
        const line = doc.lines[i];
        if (line.restored) continue;
        const already = await StockMovement.exists({
          refType: 'ShopUse',
          refId: doc._id,
          type: 'adjustment_in',
          product: line.product,
          variantId: line.variantId || null,
        });
        if (!already) {
          await stockService.restoreStock({
            productId: line.product,
            variantId: line.variantId,
            quantity: line.qty,
            allocations: allocations[i],
            branchId: doc.branch,
            movement: {
              type: 'adjustment_in',
              refType: 'ShopUse',
              refId: doc._id,
              refNo: doc.shopUseNo,
              userId,
              unitCost: line.unitCost,
              note: `reversal of ${doc.shopUseNo}`,
            },
          });
        }
        await ShopUse.updateOne({ _id: doc._id }, { $set: { [`lines.${i}.restored`]: true } });
      }
    }
    await Expense.updateMany(
      { sourceType: 'ShopUse', sourceRef: doc._id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, isActive: false, deletedAt: new Date(), deletedBy: toObjectId(userId) } }
    );
    return await ShopUse.findOneAndUpdate(
      { _id: doc._id },
      {
        $set: { status: 'voided', voidedBy: toObjectId(userId), voidedAt: new Date(), voidReason: String(reason || '').slice(0, 300), processingAt: null },
        $push: { history: historyEntry('voided', userId, reason) },
      },
      { new: true }
    );
  } catch (err) {
    await ShopUse.updateOne({ _id: doc._id, processingAt: now }, { $set: { processingAt: null } });
    throw err;
  }
}

async function list(query = {}, scope = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope };
  if (query.status === 'active' || query.status === 'voided') filter.status = query.status;
  const range = pktRangeFilter(query.from, query.to);
  if (range) filter.date = range;
  const pid = toObjectId(query.productId);
  if (pid) filter['lines.product'] = pid;
  const s = String(query.search || '').trim();
  if (s) {
    const rx = new RegExp(escapeRegex(s), 'i');
    filter.$or = [{ shopUseNo: rx }, { purpose: rx }, { takenByName: rx }, { 'lines.productName': rx }, { 'lines.code': rx }];
  }
  const [rows, total, sums] = await Promise.all([
    populateUsers(ShopUse.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit)).lean(),
    ShopUse.countDocuments(filter),
    // Expensed total = active records only.
    filter.status === 'voided'
      ? []
      : ShopUse.aggregate([
          { $match: { ...filter, status: 'active' } },
          { $group: { _id: null, totalCost: { $sum: '$totalCost' }, totalQty: { $sum: '$totalQty' } } },
        ]),
  ]);
  const sum = sums[0] || { totalCost: 0, totalQty: 0 };
  return {
    data: rows.map(view),
    meta: { ...pageMeta(page, limit, total), totalCost: round2(sum.totalCost), totalQty: sum.totalQty },
  };
}

async function getOne(id, scope = {}) {
  const doc = await findScoped(id, scope);
  return view(await populateUsers(ShopUse.findById(doc._id)).lean());
}

module.exports = { EXPENSE_CATEGORY, create, finalize, voidRecord, list, getOne, view, ensureCategory };
