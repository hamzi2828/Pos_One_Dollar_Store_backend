// src/services/vendors/consignmentService.js
// Consignment (sale-or-return): a vendor places pieces in the shop at a fixed
// buy rate, we pay only for what sells, and on the next visit the vendor
// takes unsold / old pieces back and brings new designs.
//
//   intake      -> stock in (`consignment_in`, cost = rate), product marked
//                  isConsignment / consignmentVendor / consignmentRate,
//                  position qtyIn +  — NO payable
//   sold        =  sale + gift - sale_return movements of the unit since the
//                  position's first intake (consignment products belong to one vendor)
//   settlement  -> unsettled sold pieces x rate = `consignment_settlement`
//                  credit in the vendor ledger; position qtySettled + (guarded,
//                  so the same pieces are never settled twice); optional payment
//   return/swap -> stock out (`consignment_return`), position qtyReturned +, no debit note
//
// Positions: models/consignmentStock.js (one open position per unit and branch).
const Consignment = require('../../models/consignment');
const ConsignmentSettlement = require('../../models/consignmentSettlement');
const ConsignmentStock = require('../../models/consignmentStock');
const Product = require('../../models/product');
const Vendor = require('../../models/vendor');
const VendorPayment = require('../../models/vendorPayment');
const StockMovement = require('../../models/stockMovement');
const Shelf = require('../../models/shelf');
const Branch = require('../../models/branch');
const stockService = require('../stockService');
const ledger = require('../vendorLedgerService');
const { nextNumber } = require('../sequenceService');
const { getMainBranchId } = require('../../helper/productCodes');
const { resolveWriteBranch } = require('../../middleware/access');
const { loadVendor } = require('./vendorService');
const paymentService = require('./paymentService');
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

const MAX_ITEMS = 300;
const SOLD_OUT = ['sale', 'gift'];
const unitKey = (branch, product, variantId) => `${String(branch)}|${String(product)}|${variantId ? String(variantId) : ''}`;

// ---------------------------------------------------------------------------
// Sold pieces per position (from the stock ledger)
// ---------------------------------------------------------------------------

async function soldByMatch(orList) {
  const rows = await StockMovement.aggregate([
    { $match: { type: { $in: [...SOLD_OUT, 'sale_return'] }, $or: orList } },
    {
      $group: {
        _id: { branch: '$branch', product: '$product', variantId: '$variantId' },
        out: { $sum: { $cond: [{ $in: ['$type', SOLD_OUT] }, '$quantity', 0] } },
        back: { $sum: { $cond: [{ $eq: ['$type', 'sale_return'] }, '$quantity', 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [unitKey(r._id.branch, r._id.product, r._id.variantId), Math.max(0, r.out - r.back)]));
}

const windowOf = (p) => ({
  branch: p.branch,
  product: p.product,
  variantId: p.variantId || null,
  occurredAt: { $gte: p.firstIntakeAt, ...(p.closedAt ? { $lt: p.closedAt } : {}) },
});

/** Map positionId -> pieces sold since the position's first intake. */
async function soldFor(positions) {
  const out = new Map();
  if (!positions.length) return out;
  // Positions of the same unit (an old closed one + the open one) need their own window.
  const seen = new Map();
  for (const p of positions) {
    const k = unitKey(p.branch, p.product, p.variantId);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const batch = positions.filter((p) => seen.get(unitKey(p.branch, p.product, p.variantId)) === 1);
  const single = positions.filter((p) => seen.get(unitKey(p.branch, p.product, p.variantId)) > 1);
  for (let i = 0; i < batch.length; i += 500) {
    const chunk = batch.slice(i, i + 500);
    const sold = await soldByMatch(chunk.map(windowOf));
    for (const p of chunk) out.set(String(p._id), sold.get(unitKey(p.branch, p.product, p.variantId)) || 0);
  }
  for (const p of single) {
    const sold = await soldByMatch([windowOf(p)]);
    out.set(String(p._id), sold.get(unitKey(p.branch, p.product, p.variantId)) || 0);
  }
  return out;
}

/** Position + computed numbers (placed, sold, unsettled, unsold) and the unit's physical stock. */
function positionView(p, sold, physical = null) {
  const placed = Math.max(0, p.qtyIn - p.qtyReturned);
  const unsettled = Math.max(0, sold - p.qtySettled);
  const unsold = Math.max(0, placed - sold);
  return {
    _id: p._id,
    vendor: p.vendor,
    branch: p.branch,
    product: p.product,
    variantId: p.variantId,
    productName: p.productName,
    variantLabel: p.variantLabel,
    code: p.code,
    rate: p.rate,
    qtyIn: p.qtyIn,
    qtyReturned: p.qtyReturned,
    qtySettled: p.qtySettled,
    amountSettled: p.amountSettled,
    placed,
    sold,
    unsettled,
    unsettledAmount: round2(unsettled * p.rate),
    // pieces paid for that came back afterwards (sale_return after a settlement)
    overSettled: Math.max(0, p.qtySettled - sold),
    unsold,
    unsoldValue: round2(unsold * p.rate),
    currentStock: physical,
    firstIntakeAt: p.firstIntakeAt,
    lastIntakeAt: p.lastIntakeAt,
    lastReturnAt: p.lastReturnAt,
    lastSettledAt: p.lastSettledAt,
    isOpen: p.isOpen,
  };
}

/** Physical pieces of each position's unit in its branch. */
async function physicalStock(positions) {
  const out = new Map();
  if (!positions.length) return out;
  const mainBranchId = await getMainBranchId();
  const products = await Product.find({ _id: { $in: [...new Set(positions.map((p) => String(p.product)))] } })
    .setOptions({ withDeleted: true })
    .select('name productType stock branchStock batches.branch batches.quantity variants.variantId variants._id variants.stock variants.branchStock variants.batches.branch variants.batches.quantity')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  for (const pos of positions) {
    const p = byId.get(String(pos.product));
    if (!p) {
      out.set(String(pos._id), 0);
      continue;
    }
    try {
      const { unit } = unitOf(p, pos.variantId);
      out.set(String(pos._id), stockService.unitAvailable(unit, pos.branch, mainBranchId));
    } catch (_) {
      out.set(String(pos._id), 0);
    }
  }
  return out;
}

async function viewsFor(positions) {
  const [sold, physical] = await Promise.all([soldFor(positions), physicalStock(positions)]);
  return positions.map((p) => positionView(p, sold.get(String(p._id)) || 0, physical.get(String(p._id)) ?? null));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * GET /api/consignments/summary — consignment vendors with stock placed /
 * sold / unsold / unsettled amount (open positions in the request's branches).
 */
async function summary(req) {
  const positions = await ConsignmentStock.find({ isOpen: true, ...scope(req) }).lean();
  const views = await viewsFor(positions);
  const vendors = await Vendor.find({ isDeleted: { $ne: true }, $or: [{ isConsignment: true }, { _id: { $in: positions.map((p) => p.vendor) } }] })
    .select('name code phone whatsapp city isActive isConsignment')
    .sort({ name: 1 })
    .lean();
  const balances = await ledger.getBalances(vendors.map((v) => v._id));

  const empty = () => ({ products: 0, placed: 0, sold: 0, unsold: 0, unsoldValue: 0, unsettledQty: 0, unsettledAmount: 0, settledAmount: 0, lastIntakeAt: null, lastSettledAt: null });
  const byVendor = new Map(vendors.map((v) => [String(v._id), empty()]));
  const later = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);
  for (const v of views) {
    const s = byVendor.get(String(v.vendor));
    if (!s) continue;
    s.products += 1;
    s.placed += v.placed;
    s.sold += v.sold;
    s.unsold += v.unsold;
    s.unsoldValue = round2(s.unsoldValue + v.unsoldValue);
    s.unsettledQty += v.unsettled;
    s.unsettledAmount = round2(s.unsettledAmount + v.unsettledAmount);
    s.settledAmount = round2(s.settledAmount + (v.amountSettled || 0));
    s.lastIntakeAt = later(s.lastIntakeAt, v.lastIntakeAt);
    s.lastSettledAt = later(s.lastSettledAt, v.lastSettledAt);
  }
  const data = vendors.map((v) => ({
    ...v,
    balance: (balances.get(String(v._id)) || { balance: 0 }).balance,
    ...byVendor.get(String(v._id)),
  }));
  const totals = data.reduce(
    (t, v) => ({
      vendors: t.vendors + 1,
      placed: t.placed + v.placed,
      sold: t.sold + v.sold,
      unsold: t.unsold + v.unsold,
      unsoldValue: round2(t.unsoldValue + v.unsoldValue),
      unsettledAmount: round2(t.unsettledAmount + v.unsettledAmount),
    }),
    { vendors: 0, placed: 0, sold: 0, unsold: 0, unsoldValue: 0, unsettledAmount: 0 }
  );
  return { data, meta: { totals } };
}

/**
 * GET /api/consignments/vendors/:vendorId/stock — the "vendor visit" sheet for
 * ONE branch (the request's branch; super admin without one: main branch).
 */
async function vendorStock(req, vendorId) {
  const vendor = await loadVendor(vendorId);
  const branchId = await resolveWriteBranch(req);
  const positions = await ConsignmentStock.find({ vendor: vendor._id, branch: oid(branchId), isOpen: true }).sort({ productName: 1 }).lean();
  const items = await viewsFor(positions);
  const [branch, lastSettlement, bal] = await Promise.all([
    Branch.findById(branchId).select('name code').lean(),
    ConsignmentSettlement.findOne({ vendor: vendor._id, branch: oid(branchId), status: 'active' }).sort({ createdAt: -1 }).select('settlementNo total createdAt').lean(),
    ledger.getBalance(vendor._id),
  ]);
  const totals = items.reduce(
    (t, i) => ({
      placed: t.placed + i.placed,
      sold: t.sold + i.sold,
      unsold: t.unsold + i.unsold,
      unsoldValue: round2(t.unsoldValue + i.unsoldValue),
      unsettledQty: t.unsettledQty + i.unsettled,
      unsettledAmount: round2(t.unsettledAmount + i.unsettledAmount),
    }),
    { placed: 0, sold: 0, unsold: 0, unsoldValue: 0, unsettledQty: 0, unsettledAmount: 0 }
  );
  return {
    vendor: { _id: vendor._id, name: vendor.name, code: vendor.code, phone: vendor.phone, whatsapp: vendor.whatsapp, balance: bal.balance },
    branch: branch ? { _id: branch._id, name: branch.name, code: branch.code } : { _id: branchId },
    items,
    totals,
    lastSettlement,
  };
}

const decorateDocs = async (rows) => {
  const [users, branches] = await Promise.all([userNames(rows.flatMap((r) => [r.createdBy, r.voidedBy])), branchNames(rows.map((r) => r.branch))]);
  return rows.map((r) => ({
    ...r,
    branchName: branches.get(String(r.branch)) ? branches.get(String(r.branch)).name : '',
    createdByName: r.createdBy ? users.get(String(r.createdBy)) || '' : '',
    voidedByName: r.voidedBy ? users.get(String(r.voidedBy)) || '' : '',
  }));
};

/** GET /api/consignments?vendor&kind&from&to&search — intake / return documents. */
async function list(req, query = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope(req) };
  const vendor = query.vendor || query.vendorId;
  if (vendor) filter.vendor = requireId(vendor, 'vendor');
  if (query.kind && ['intake', 'return'].includes(query.kind)) filter.kind = query.kind;
  const range = dateRange(query.from, query.to);
  if (range) filter.date = range;
  const rx = searchRx(query.search);
  if (rx) filter.$or = [{ consignmentNo: rx }, { vendorName: rx }, { 'items.productName': rx }];
  const [rows, total] = await Promise.all([
    Consignment.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Consignment.countDocuments(filter),
  ]);
  return { data: await decorateDocs(rows), meta: pageMeta(page, limit, total) };
}

async function getDoc(req, id) {
  const doc = await Consignment.findById(requireId(id, 'consignment')).lean();
  if (!doc) throw httpError('Consignment not found', 404);
  assertInScope(req, doc, 'Consignment');
  const [row] = await decorateDocs([doc]);
  return row;
}

/** GET /api/consignments/settlements?vendor&status&from&to */
async function listSettlements(req, query = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = { ...scope(req) };
  const vendor = query.vendor || query.vendorId;
  if (vendor) filter.vendor = requireId(vendor, 'vendor');
  if (query.status && ['active', 'voided'].includes(query.status)) filter.status = query.status;
  const range = dateRange(query.from, query.to);
  if (range) filter.createdAt = range;
  const rx = searchRx(query.search);
  if (rx) filter.$or = [{ settlementNo: rx }, { vendorName: rx }];
  const [rows, total, sums] = await Promise.all([
    ConsignmentSettlement.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    ConsignmentSettlement.countDocuments(filter),
    ConsignmentSettlement.aggregate([{ $match: { ...filter, status: 'active' } }, { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$paidAmount' }, count: { $sum: 1 } } }]),
  ]);
  const s = sums[0] || { total: 0, paid: 0, count: 0 };
  return { data: await decorateDocs(rows), meta: pageMeta(page, limit, total, { summary: { total: round2(s.total), paid: round2(s.paid), count: s.count } }) };
}

async function getSettlement(req, id) {
  const doc = await ConsignmentSettlement.findById(requireId(id, 'settlement')).lean();
  if (!doc) throw httpError('Settlement not found', 404);
  assertInScope(req, doc, 'Settlement');
  const [row] = await decorateDocs([doc]);
  if (row.payment) row.paymentDoc = await VendorPayment.findById(row.payment).select('paymentNo amount method status').lean();
  return row;
}

// ---------------------------------------------------------------------------
// Intake / return documents (posted item by item, retry-safe)
// ---------------------------------------------------------------------------

async function shelfIn(branchId, shelfId) {
  if (!shelfId) return null;
  const shelf = await Shelf.findOne({ _id: requireId(shelfId, 'shelf'), branch: oid(branchId) }).select('_id').lean();
  if (!shelf) throw httpError('Shelf not found');
  return shelf._id;
}

/** Move every item that is not posted yet; marks the document completed at the end. */
async function postPending(docId, userId) {
  const doc = await Consignment.findById(docId).lean();
  if (!doc) throw httpError('Consignment not found', 404);
  if (doc.status === 'completed') return doc;
  const vendor = await Vendor.findById(doc.vendor).select('name').lean();

  for (const item of doc.items.filter((i) => !i.posted)) {
    const at = new Date();
    if (doc.kind === 'intake') {
      // Another vendor's finished positions for this product end here.
      await ConsignmentStock.updateMany(
        { product: item.product, isOpen: true, vendor: { $ne: doc.vendor } },
        { $set: { isOpen: false, closedAt: at } }
      );
      await stockService.receiveStock({
        productId: item.product,
        variantId: item.variantId,
        quantity: item.qty,
        branchId: doc.branch,
        cost: { unitCost: item.rate, purchasePrice: item.rate, vendorId: doc.vendor, vendorName: vendor ? vendor.name : doc.vendorName },
        movement: {
          type: 'consignment_in',
          refType: 'Consignment',
          refId: doc._id,
          refNo: doc.consignmentNo,
          vendorId: doc.vendor,
          userId,
          toShelfId: item.shelf || null,
          note: 'Consignment (sale or return)',
        },
      });
      await Consignment.updateOne({ _id: doc._id, 'items._id': item._id }, { $set: { 'items.$.posted': true, 'items.$.postedAt': new Date() } });
      await ConsignmentStock.findOneAndUpdate(
        { branch: doc.branch, product: item.product, variantId: item.variantId || null, isOpen: true, vendor: doc.vendor },
        {
          $inc: { qtyIn: item.qty },
          $set: { rate: item.rate, lastIntakeAt: at, productName: item.productName, variantLabel: item.variantLabel, code: item.code },
          $setOnInsert: { firstIntakeAt: at, qtyReturned: 0, qtySettled: 0, amountSettled: 0 },
        },
        { upsert: true, new: true }
      );
      await Product.updateOne(
        { _id: item.product },
        { $set: { isConsignment: true, consignmentVendor: doc.vendor, consignmentRate: item.rate } }
      );
    } else {
      await stockService.deductStock({
        productId: item.product,
        variantId: item.variantId,
        quantity: item.qty,
        branchId: doc.branch,
        movement: {
          type: 'consignment_return',
          refType: 'Consignment',
          refId: doc._id,
          refNo: doc.consignmentNo,
          vendorId: doc.vendor,
          userId,
          fromShelfId: item.shelf || null,
          note: 'Consignment pieces given back to the vendor',
        },
      });
      await Consignment.updateOne({ _id: doc._id, 'items._id': item._id }, { $set: { 'items.$.posted': true, 'items.$.postedAt': new Date() } });
      await ConsignmentStock.updateOne(
        { branch: doc.branch, product: item.product, variantId: item.variantId || null, isOpen: true, vendor: doc.vendor },
        { $inc: { qtyReturned: item.qty }, $set: { lastReturnAt: at } }
      );
    }
  }
  await Consignment.updateOne({ _id: doc._id }, { $set: { status: 'completed' }, $push: { history: historyRow(userId, 'posted') } });
  if (doc.kind === 'intake') await Vendor.updateOne({ _id: doc.vendor, isConsignment: { $ne: true } }, { $set: { isConsignment: true } });
  return Consignment.findById(doc._id).lean();
}

/** Run postPending; on a stock error keep the document (pending) and say how to retry. */
async function postOrExplain(req, doc) {
  try {
    await postPending(doc._id, req.access.userId);
  } catch (e) {
    e.message = `${e.message} — ${doc.consignmentNo} is saved; fix the problem and press "Retry".`;
    e.consignmentId = doc._id;
    throw e;
  }
  return getDoc(req, doc._id);
}

/**
 * POST /api/consignments — intake { vendorId, items: [{ productId, variantId, rate, qty, toShelfId }], date, notes }
 */
async function intake(req, body = {}) {
  const vendor = await loadVendor(body.vendorId || body.vendor, { activeOnly: true });
  const branchId = await resolveWriteBranch(req);
  const input = body.items;
  if (!Array.isArray(input) || !input.length) throw httpError('Add at least one item the vendor is placing');
  if (input.length > MAX_ITEMS) throw httpError(`At most ${MAX_ITEMS} items per intake`);

  const mainBranchId = await getMainBranchId();
  const ids = [...new Set(input.map((i) => String((i && (i.productId || i.product)) || '')))];
  ids.forEach((id) => requireId(id, 'product'));
  const products = await Product.find({ _id: { $in: ids.map(oid) } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const others = await ConsignmentStock.find({ product: { $in: ids.map(oid) }, isOpen: true, vendor: { $ne: vendor._id } }).lean();
  const otherViews = await viewsFor(others);

  const items = [];
  for (const raw of input) {
    const product = byId.get(String(raw.productId || raw.product));
    if (!product) throw httpError('Product not found (it may have been deleted)', 404);
    const u = unitOf(product, raw.variantId);
    const qty = pieces(raw.qty ?? raw.qtyIn, `Quantity of ${product.name}`);
    const rate = money(raw.rate, `Rate of ${product.name}`, { positive: true });

    // A consignment product belongs to ONE vendor.
    const busy = otherViews.filter((v) => sameId(v.product, product._id) && (v.unsold > 0 || v.unsettled > 0));
    if (busy.length) {
      throw httpError(
        `${product.name} is another vendor's consignment stock with unsold or unsettled pieces. Settle / return those first, or make a new product.`,
        409,
        'OTHER_VENDOR'
      );
    }
    // Our own pieces of the same unit would be counted as the vendor's sales.
    const mine = product.isConsignment && sameId(product.consignmentVendor, vendor._id);
    const own = stockService.unitAvailable(u.unit, branchId, mainBranchId);
    if (!mine && own > 0) {
      throw httpError(
        `${product.name}${u.label ? ` (${u.label})` : ''} already has ${own} pieces of our own stock here. Make a separate product for ${vendor.name}'s pieces so their sales are counted correctly.`,
        409,
        'OWN_STOCK'
      );
    }
    items.push({
      product: product._id,
      variantId: u.variantId,
      productName: product.name,
      variantLabel: u.label,
      code: u.code,
      rate: round4(rate),
      qty,
      amount: round2(qty * rate),
      shelf: await shelfIn(branchId, raw.toShelfId),
    });
  }

  const doc = await Consignment.create({
    consignmentNo: await nextNumber('CN'),
    kind: 'intake',
    vendor: vendor._id,
    vendorName: vendor.name,
    branch: oid(branchId),
    status: 'pending',
    date: docDate(body.date),
    items,
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    totalValue: round2(items.reduce((s, i) => s + i.amount, 0)),
    notes: str(body.notes, 1000),
    createdBy: oid(req.access.userId),
    history: [historyRow(req.access.userId, 'created')],
  });
  return postOrExplain(req, doc);
}

/**
 * POST /api/consignments/returns — give unsold pieces back
 * { vendorId, items: [{ productId, variantId, qty, fromShelfId }], notes }
 */
async function returnItems(req, body = {}) {
  const vendor = await loadVendor(body.vendorId || body.vendor);
  const branchId = await resolveWriteBranch(req);
  const input = body.items;
  if (!Array.isArray(input) || !input.length) throw httpError('Choose the pieces the vendor is taking back');
  if (input.length > MAX_ITEMS) throw httpError(`At most ${MAX_ITEMS} items per return`);

  const positions = await ConsignmentStock.find({ vendor: vendor._id, branch: oid(branchId), isOpen: true }).lean();
  const views = await viewsFor(positions);
  const byUnit = new Map(views.map((v) => [`${v.product}|${v.variantId || ''}`, v]));
  const products = await Product.find({ _id: { $in: positions.map((p) => p.product) } }).setOptions({ withDeleted: true }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  const wanted = new Map();
  for (const raw of input) {
    const pid = String(raw.productId || raw.product || '');
    requireId(pid, 'product');
    const product = byId.get(pid);
    if (!product) throw httpError(`This item is not ${vendor.name}'s consignment stock`, 400, 'NOT_CONSIGNMENT');
    const u = unitOf(product, raw.variantId);
    const pos = byUnit.get(`${pid}|${u.variantId || ''}`);
    if (!pos) throw httpError(`${product.name} is not ${vendor.name}'s consignment stock`, 400, 'NOT_CONSIGNMENT');
    const qty = pieces(raw.qty, `Quantity of ${product.name}`);
    const key = `${pid}|${u.variantId || ''}`;
    const total = (wanted.get(key) || 0) + qty;
    wanted.set(key, total);
    const limit = Math.min(pos.unsold, pos.currentStock ?? pos.unsold);
    if (total > limit) {
      throw httpError(
        `${product.name}${u.label ? ` (${u.label})` : ''}: only ${limit} unsold piece${limit === 1 ? '' : 's'} can go back (${pos.unsold} unsold, ${pos.currentStock ?? '?'} in stock)`,
        400,
        'TOO_MANY'
      );
    }
    items.push({
      product: product._id,
      variantId: u.variantId,
      productName: product.name,
      variantLabel: u.label,
      code: u.code,
      rate: pos.rate,
      qty,
      amount: round2(qty * pos.rate),
      shelf: await shelfIn(branchId, raw.fromShelfId),
    });
  }

  const doc = await Consignment.create({
    consignmentNo: await nextNumber('CN'),
    kind: 'return',
    vendor: vendor._id,
    vendorName: vendor.name,
    branch: oid(branchId),
    status: 'pending',
    date: docDate(body.date),
    items,
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    totalValue: round2(items.reduce((s, i) => s + i.amount, 0)),
    notes: str(body.notes, 1000),
    createdBy: oid(req.access.userId),
    history: [historyRow(req.access.userId, 'created')],
  });
  return postOrExplain(req, doc);
}

/** POST /api/consignments/:id/post — retry a pending intake / return. */
async function retryPost(req, id) {
  const doc = await Consignment.findById(requireId(id, 'consignment')).lean();
  if (!doc) throw httpError('Consignment not found', 404);
  assertInScope(req, doc, 'Consignment');
  return postOrExplain(req, doc);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** Validate "pay now" before anything is written. */
function cleanPayNow(payNow) {
  if (!payNow || !bool(payNow.enabled ?? true) || !payNow.amount) return null;
  const method = String(payNow.method || 'cash').toLowerCase();
  if (!VendorPayment.METHODS.includes(method)) throw httpError(`Payment method must be one of: ${VendorPayment.METHODS.join(', ')}`);
  const reference = str(payNow.reference, 100);
  if (method === 'cheque' && !reference) throw httpError('Please enter the cheque number');
  return { amount: money(payNow.amount, 'Payment amount', { positive: true }), method, bankId: payNow.bankId || null, reference };
}

/**
 * POST /api/consignments/settlements
 * { vendorId, lines?: [{ productId, variantId, soldQty }], notes, payNow?: { amount, method, bankId, reference } }
 * Without lines: every unsettled sold piece of the vendor.
 */
async function settle(req, body = {}) {
  const vendor = await loadVendor(body.vendorId || body.vendor);
  const branchId = await resolveWriteBranch(req);
  const userId = req.access.userId;
  const payNow = cleanPayNow(body.payNow);
  if (payNow && !req.access.can('vendor_payments', 'create')) {
    throw httpError('You may settle but not pay (needs Vendor Payments → create)', 403);
  }

  const positions = await ConsignmentStock.find({ vendor: vendor._id, branch: oid(branchId), isOpen: true }).lean();
  const views = await viewsFor(positions);
  const posById = new Map(positions.map((p) => [String(p._id), p]));
  const byUnit = new Map(views.map((v) => [`${v.product}|${v.variantId || ''}`, v]));

  let picks;
  if (Array.isArray(body.lines) && body.lines.length) {
    const seen = new Set();
    picks = body.lines.map((l) => {
      const key = `${String(l.productId || l.product || '')}|${l.variantId || ''}`;
      if (seen.has(key)) throw httpError('The same item is listed twice');
      seen.add(key);
      const v = byUnit.get(key);
      if (!v) throw httpError('An item is not this vendor\'s consignment stock', 400, 'NOT_CONSIGNMENT');
      const qty = pieces(l.soldQty ?? l.qty, `Sold quantity of ${v.productName}`);
      if (qty > v.unsettled) {
        throw httpError(`${v.productName}: only ${v.unsettled} sold piece${v.unsettled === 1 ? '' : 's'} not settled yet`, 409, 'OVER_SETTLE');
      }
      return { view: v, qty };
    });
  } else {
    picks = views.filter((v) => v.unsettled > 0).map((v) => ({ view: v, qty: v.unsettled }));
  }
  if (!picks.length) throw httpError('Nothing new was sold since the last settlement', 409, 'NOTHING_TO_SETTLE');

  const now = new Date();
  const lines = picks.map(({ view, qty }) => ({
    position: view._id,
    product: view.product,
    variantId: view.variantId,
    productName: view.productName,
    variantLabel: view.variantLabel,
    code: view.code,
    soldQty: qty,
    rate: view.rate,
    amount: round2(qty * view.rate),
  }));
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  const totalQty = lines.reduce((s, l) => s + l.soldQty, 0);
  const periodFrom = picks.reduce((min, { view }) => {
    const d = view.lastSettledAt || view.firstIntakeAt;
    return !min || new Date(d) < new Date(min) ? d : min;
  }, null);

  const doc = await ConsignmentSettlement.create({
    settlementNo: await nextNumber('CS'),
    vendor: vendor._id,
    vendorName: vendor.name,
    branch: oid(branchId),
    periodFrom,
    periodTo: now,
    lines,
    totalQty,
    total,
    notes: str(body.notes, 1000),
    createdBy: oid(userId),
    history: [historyRow(userId, 'created', `${totalQty} pcs, Rs ${total}`)],
  });

  // Claim the pieces: only succeeds while qtySettled is what we read (no double settlement).
  const claimed = [];
  let entry = null;
  try {
    for (const line of lines) {
      const pos = posById.get(String(line.position));
      const res = await ConsignmentStock.updateOne(
        { _id: pos._id, qtySettled: pos.qtySettled },
        { $inc: { qtySettled: line.soldQty, amountSettled: line.amount }, $set: { lastSettledAt: now } }
      );
      if (!res.modifiedCount) throw httpError('These pieces were just settled by someone else. Reload the vendor visit.', 409, 'SETTLE_CONFLICT');
      claimed.push(line);
    }
    if (total > 0) {
      entry = await ledger.post({
        vendorId: vendor._id,
        type: 'consignment_settlement',
        credit: total,
        branchId,
        refType: 'ConsignmentSettlement',
        refId: doc._id,
        refNo: doc.settlementNo,
        description: `${totalQty} consignment pc${totalQty === 1 ? '' : 's'} sold`,
        userId,
        unique: true,
      });
    }
  } catch (e) {
    for (const line of claimed) {
      await ConsignmentStock.updateOne({ _id: line.position }, { $inc: { qtySettled: -line.soldQty, amountSettled: -line.amount } });
    }
    await ConsignmentSettlement.deleteOne({ _id: doc._id });
    throw e;
  }
  await ConsignmentSettlement.updateOne({ _id: doc._id }, { $set: { ledgerEntry: entry ? entry._id : null } });

  let paymentError = null;
  if (payNow) {
    try {
      const payment = await paymentService.recordPayment({
        vendorId: vendor._id,
        branchId,
        amount: payNow.amount,
        method: payNow.method,
        bankId: payNow.bankId,
        reference: payNow.reference,
        notes: `Paid at consignment settlement ${doc.settlementNo}`,
        settlementId: doc._id,
        userId,
      });
      await ConsignmentSettlement.updateOne(
        { _id: doc._id },
        { $set: { payment: payment._id, paidAmount: payment.amount }, $push: { history: historyRow(userId, 'paid', `${payment.paymentNo} Rs ${payment.amount}`) } }
      );
    } catch (e) {
      // The settlement stands; the payment can be recorded from Vendor Payments.
      paymentError = e.message;
    }
  }
  const out = await getSettlement(req, doc._id);
  if (paymentError) out.paymentError = paymentError;
  return out;
}

/** POST /api/consignments/settlements/:id/void { reason } — pieces become unsettled again. */
async function voidSettlement(req, id, body = {}) {
  const doc = await ConsignmentSettlement.findById(requireId(id, 'settlement')).lean();
  if (!doc) throw httpError('Settlement not found', 404);
  assertInScope(req, doc, 'Settlement');
  if (doc.status === 'voided') throw httpError('This settlement is already voided', 409, 'ALREADY_VOIDED');
  const reason = str(body.reason, 500);
  if (reason.length < 3) throw httpError('Please write why this settlement is voided');
  const userId = req.access.userId;
  const updated = await ConsignmentSettlement.findOneAndUpdate(
    { _id: doc._id, status: 'active' },
    {
      $set: { status: 'voided', voidedAt: new Date(), voidedBy: oid(userId), voidReason: reason },
      $push: { history: historyRow(userId, 'voided', reason) },
    },
    { new: true }
  ).lean();
  if (!updated) throw httpError('This settlement is already voided', 409, 'ALREADY_VOIDED');
  for (const line of doc.lines) {
    await ConsignmentStock.updateOne(
      { _id: line.position, qtySettled: { $gte: line.soldQty } },
      { $inc: { qtySettled: -line.soldQty, amountSettled: -line.amount } }
    );
  }
  await ledger.voidByRef('ConsignmentSettlement', doc._id, { userId, reason: `Settlement voided: ${reason}` });
  return getSettlement(req, doc._id);
}

module.exports = {
  soldFor,
  positionView,
  summary,
  vendorStock,
  list,
  getDoc,
  listSettlements,
  getSettlement,
  intake,
  returnItems,
  retryPost,
  settle,
  voidSettlement,
};
