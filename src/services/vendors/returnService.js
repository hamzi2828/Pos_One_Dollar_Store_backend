// src/services/vendors/returnService.js
// Vendor returns ("VR-2026-00001"): draft -> completed | cancelled.
//
// Complete = every line leaves stock (movement `vendor_return`, warehouse
// first, optional shelf) and ONE `debit_note` row goes into the vendor ledger
// (we owe the vendor less). Retry-safe:
//   - a short lock stops two completions running at once
//   - each line is marked `posted` right after its stock left, so a retry
//     only moves the lines that are still pending
//   - the debit note is unique per return (vendorLedgerService `unique`)
const VendorReturn = require('../../models/vendorReturn');
const Product = require('../../models/product');
const Shelf = require('../../models/shelf');
const stockService = require('../stockService');
const ledger = require('../vendorLedgerService');
const { nextNumber } = require('../sequenceService');
const { getMainBranchId } = require('../../helper/productCodes');
const { resolveWriteBranch } = require('../../middleware/access');
const { loadVendor } = require('./vendorService');
const { vendorLastPrices, defaultReturnCost } = require('./productLookup');
const {
  round2,
  round4,
  httpError,
  oid,
  requireId,
  sameId,
  str,
  pieces,
  money,
  bool,
  docDate,
  dateRange,
  pageParams,
  pageMeta,
  searchRx,
  scope,
  assertInScope,
  unitOf,
  userNames,
  branchNames,
  historyRow,
} = require('./common');

const LOCK_MS = 2 * 60 * 1000;
const MAX_LINES = 200;

const REASON_LABELS = {
  slow_moving: 'Slow moving',
  damaged: 'Damaged',
  expired: 'Expired',
  wrong_item: 'Wrong item',
  excess: 'Excess stock',
  other: 'Other',
};

const notify = async (payload) => {
  try {
    await require('../notificationService').notify(payload);
  } catch (_) {
    /* never fails a return */
  }
};

/** Validate request lines -> stored lines (server computes cost and amounts). */
async function buildLines(input, { vendor, branchId }) {
  if (!Array.isArray(input) || !input.length) throw httpError('Add at least one item to return');
  if (input.length > MAX_LINES) throw httpError(`At most ${MAX_LINES} lines per return`);

  const ids = [...new Set(input.map((l) => String((l && (l.productId || l.product)) || '')))];
  ids.forEach((id) => requireId(id, 'product'));
  const products = await Product.find({ _id: { $in: ids.map(oid) } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const prices = await vendorLastPrices(vendor._id, ids);

  const lines = [];
  for (const raw of input) {
    const product = byId.get(String(raw.productId || raw.product));
    if (!product) throw httpError('Product not found (it may have been deleted)', 404);
    const u = unitOf(product, raw.variantId);
    if (product.isConsignment && sameId(product.consignmentVendor, vendor._id)) {
      throw httpError(
        `${product.name} is ${vendor.name}'s consignment stock. Give it back from Consignment → Vendor visit (no debit note).`,
        400,
        'CONSIGNMENT_ITEM'
      );
    }
    const qty = pieces(raw.qty, `Quantity of ${product.name}`);
    const unitCost =
      raw.unitCost === undefined || raw.unitCost === null || raw.unitCost === ''
        ? defaultReturnCost(prices, product, u.unit, u.variantId).unitCost
        : money(raw.unitCost, `Price of ${product.name}`);
    const reason = raw.reason ? String(raw.reason) : 'other';
    if (!VendorReturn.REASONS.includes(reason)) throw httpError(`Unknown return reason "${reason}"`);

    let fromShelf = null;
    if (raw.fromShelfId) {
      const shelf = await Shelf.findOne({ _id: requireId(raw.fromShelfId, 'shelf'), branch: oid(branchId) }).select('_id').lean();
      if (!shelf) throw httpError('Shelf not found', 400);
      fromShelf = shelf._id;
    }
    lines.push({
      product: product._id,
      variantId: u.variantId,
      productName: product.name,
      variantLabel: u.label,
      code: u.code,
      qty,
      unitCost: round4(unitCost),
      amount: round2(qty * unitCost),
      reason,
      note: str(raw.note, 300),
      fromShelf,
    });
  }
  return lines;
}

const totalsOf = (lines) => ({
  totalQty: lines.reduce((s, l) => s + l.qty, 0),
  total: round2(lines.reduce((s, l) => s + l.amount, 0)),
});

async function decorate(rows) {
  const [users, branches] = await Promise.all([
    userNames(rows.flatMap((r) => [r.createdBy, r.completedBy, r.cancelledBy])),
    branchNames(rows.map((r) => r.branch)),
  ]);
  return rows.map((r) => ({
    ...r,
    lockedUntil: undefined,
    lines: (r.lines || []).map((l) => ({ ...l, reasonLabel: REASON_LABELS[l.reason] || l.reason })),
    branchName: branches.get(String(r.branch)) ? branches.get(String(r.branch)).name : '',
    createdByName: r.createdBy ? users.get(String(r.createdBy)) || '' : '',
    completedByName: r.completedBy ? users.get(String(r.completedBy)) || '' : '',
    cancelledByName: r.cancelledBy ? users.get(String(r.cancelledBy)) || '' : '',
  }));
}

async function loadInScope(req, id) {
  const doc = await VendorReturn.findById(requireId(id, 'return')).lean();
  if (!doc) throw httpError('Vendor return not found', 404);
  assertInScope(req, doc, 'Vendor return');
  return doc;
}

async function getById(req, id) {
  const [row] = await decorate([await loadInScope(req, id)]);
  return row;
}

/** GET /api/vendor-returns?vendor&status&productId&from&to&search */
async function list(req, query = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope(req) };
  const vendor = query.vendor || query.vendorId;
  if (vendor) filter.vendor = requireId(vendor, 'vendor');
  if (query.status && ['draft', 'completed', 'cancelled'].includes(query.status)) filter.status = query.status;
  if (query.productId) filter['lines.product'] = requireId(query.productId, 'product');
  const range = dateRange(query.from, query.to);
  if (range) filter.date = range;
  const rx = searchRx(query.search);
  if (rx) filter.$or = [{ returnNo: rx }, { vendorName: rx }, { 'lines.productName': rx }, { notes: rx }];

  const [rows, total, sums] = await Promise.all([
    VendorReturn.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    VendorReturn.countDocuments(filter),
    VendorReturn.aggregate([{ $match: filter }, { $group: { _id: '$status', total: { $sum: '$total' }, qty: { $sum: '$totalQty' }, count: { $sum: 1 } } }]),
  ]);
  const summary = { completed: { count: 0, total: 0, qty: 0 }, draft: { count: 0, total: 0, qty: 0 }, cancelled: { count: 0, total: 0, qty: 0 } };
  for (const s of sums) if (summary[s._id]) summary[s._id] = { count: s.count, total: round2(s.total), qty: s.qty };
  return { data: await decorate(rows), meta: pageMeta(page, limit, total, { summary }) };
}

/** POST /api/vendor-returns — draft. `complete: true` completes it straight away (needs edit). */
async function create(req, body = {}) {
  const vendor = await loadVendor(body.vendorId || body.vendor);
  const branchId = await resolveWriteBranch(req);
  const lines = await buildLines(body.lines, { vendor, branchId });
  const wantsComplete = bool(body.complete);
  if (wantsComplete && !req.access.can('vendor_returns', 'edit')) {
    throw httpError('You may save the return but not complete it (needs Vendor Returns → edit)', 403);
  }
  const returnNo = await nextNumber('VR');
  const doc = await VendorReturn.create({
    returnNo,
    vendor: vendor._id,
    vendorName: vendor.name,
    branch: oid(branchId),
    status: 'draft',
    date: docDate(body.date),
    lines,
    ...totalsOf(lines),
    notes: str(body.notes, 1000),
    createdBy: oid(req.access.userId),
    history: [historyRow(req.access.userId, 'created')],
  });
  if (wantsComplete) return complete(req, doc._id);
  return getById(req, doc._id);
}

/** PUT /api/vendor-returns/:id — drafts only, and only before any line left stock. */
async function update(req, id, body = {}) {
  const doc = await loadInScope(req, id);
  if (doc.status !== 'draft') throw httpError(`This return is ${doc.status} and cannot be changed`, 409, 'NOT_DRAFT');
  if ((doc.lines || []).some((l) => l.posted)) {
    throw httpError('Part of this return already left stock. Complete it to finish.', 409, 'PARTLY_POSTED');
  }
  const set = {};
  let vendor = null;
  if (body.vendorId && !sameId(body.vendorId, doc.vendor)) {
    vendor = await loadVendor(body.vendorId);
    set.vendor = vendor._id;
    set.vendorName = vendor.name;
  }
  if (body.lines !== undefined) {
    vendor = vendor || (await loadVendor(doc.vendor));
    const lines = await buildLines(body.lines, { vendor, branchId: doc.branch });
    Object.assign(set, { lines, ...totalsOf(lines) });
  }
  if (body.notes !== undefined) set.notes = str(body.notes, 1000);
  if (body.date !== undefined) set.date = docDate(body.date);
  const res = await VendorReturn.updateOne(
    { _id: doc._id, status: 'draft', 'lines.posted': { $ne: true } },
    { $set: set, $push: { history: historyRow(req.access.userId, 'edited') } }
  );
  if (!res.matchedCount) throw httpError('This return changed meanwhile. Reload and try again.', 409);
  return getById(req, doc._id);
}

/** Every pending line must fit the branch stock before anything moves. */
async function checkStock(doc, pending) {
  const mainBranchId = await getMainBranchId();
  const need = new Map();
  for (const l of pending) {
    const key = `${l.product}|${l.variantId || ''}`;
    need.set(key, { line: l, qty: (need.get(key) ? need.get(key).qty : 0) + l.qty });
  }
  const products = await Product.find({ _id: { $in: pending.map((l) => l.product) } }).setOptions({ withDeleted: true }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const short = [];
  for (const { line, qty } of need.values()) {
    const p = byId.get(String(line.product));
    if (!p) {
      short.push(`${line.productName}: product deleted`);
      continue;
    }
    const { unit } = unitOf(p, line.variantId);
    const have = stockService.unitAvailable(unit, doc.branch, mainBranchId);
    if (have < qty) short.push(`${line.productName}${line.variantLabel ? ` (${line.variantLabel})` : ''}: ${have} in stock, ${qty} to return`);
  }
  if (short.length) throw httpError(`Not enough stock: ${short.join('; ')}`, 400, 'INSUFFICIENT_STOCK');
}

/** POST /api/vendor-returns/:id/complete — stock out + debit note (safe to retry). */
async function complete(req, id) {
  const doc = await loadInScope(req, id);
  if (doc.status === 'completed') return getById(req, doc._id); // already done (retry)
  if (doc.status !== 'draft') throw httpError(`This return is ${doc.status}`, 409, 'NOT_DRAFT');
  if (!(doc.lines || []).length) throw httpError('This return has no items');

  const now = new Date();
  const locked = await VendorReturn.findOneAndUpdate(
    { _id: doc._id, status: 'draft', $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  ).lean();
  if (!locked) throw httpError('This return is being completed right now. Please wait a moment.', 409, 'BUSY');

  const userId = req.access.userId;
  let finished = false;
  try {
    const pending = locked.lines.filter((l) => !l.posted);
    if (pending.length) await checkStock(locked, pending);

    for (const line of pending) {
      const r = await stockService.deductStock({
        productId: line.product,
        variantId: line.variantId,
        quantity: line.qty,
        branchId: locked.branch,
        movement: {
          type: 'vendor_return',
          refType: 'VendorReturn',
          refId: locked._id,
          refNo: locked.returnNo,
          vendorId: locked.vendor,
          userId,
          strategy: 'warehouse_first',
          fromShelfId: line.fromShelf || null,
          note: `${REASON_LABELS[line.reason] || line.reason}${line.note ? `: ${line.note}` : ''}`,
        },
      });
      await VendorReturn.updateOne(
        { _id: locked._id, 'lines._id': line._id },
        { $set: { 'lines.$.posted': true, 'lines.$.postedAt': new Date(), 'lines.$.movement': r.movement ? r.movement._id : null } }
      );
    }

    const { total, totalQty } = totalsOf(locked.lines);
    let entry = null;
    if (total > 0) {
      entry = await ledger.post({
        vendorId: locked.vendor,
        type: 'debit_note',
        debit: total,
        branchId: locked.branch,
        refType: 'VendorReturn',
        refId: locked._id,
        refNo: locked.returnNo,
        description: `Returned ${totalQty} pc${totalQty === 1 ? '' : 's'} (${locked.lines.length} item${locked.lines.length === 1 ? '' : 's'})`,
        userId,
        unique: true,
      });
    }
    await VendorReturn.updateOne(
      { _id: locked._id, status: 'draft' },
      {
        $set: {
          status: 'completed',
          total,
          totalQty,
          ledgerEntry: entry ? entry._id : null,
          completedAt: new Date(),
          completedBy: oid(userId),
          lockedUntil: null,
        },
        $push: { history: historyRow(userId, 'completed', `Debit note Rs ${total}`) },
      }
    );
    finished = true;
    notify({
      type: 'vendor_return',
      title: `Returned to ${locked.vendorName}`,
      message: `${locked.returnNo} · ${totalQty} pcs · Rs ${total.toLocaleString('en-PK')}`,
      level: 'info',
      link: '/admin/vendors/returns',
      branchId: locked.branch,
      audience: 'vendor_returns',
    });
  } finally {
    if (!finished) await VendorReturn.updateOne({ _id: locked._id }, { $set: { lockedUntil: null } });
  }
  return getById(req, locked._id);
}

/** POST /api/vendor-returns/:id/cancel { reason } — drafts that never touched stock. */
async function cancel(req, id, body = {}) {
  const doc = await loadInScope(req, id);
  if (doc.status !== 'draft') throw httpError(`This return is ${doc.status} and cannot be cancelled`, 409, 'NOT_DRAFT');
  if ((doc.lines || []).some((l) => l.posted)) {
    throw httpError('Part of this return already left stock. Complete it instead.', 409, 'PARTLY_POSTED');
  }
  const reason = str(body.reason, 500);
  const res = await VendorReturn.updateOne(
    { _id: doc._id, status: 'draft', 'lines.posted': { $ne: true } },
    {
      $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: oid(req.access.userId), cancelReason: reason },
      $push: { history: historyRow(req.access.userId, 'cancelled', reason) },
    }
  );
  if (!res.matchedCount) throw httpError('This return changed meanwhile. Reload and try again.', 409);
  return getById(req, doc._id);
}

module.exports = { REASON_LABELS, list, getById, create, update, complete, cancel, buildLines };
