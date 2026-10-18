// src/services/purchasing/purchaseOrderService.js
// Purchase orders: one buying trip, many vendor bills, trip charges, builty.
// See models/purchaseOrder.js for the workflow and docs/STORE_OPERATIONS.md §1.
const PurchaseOrder = require('../../models/purchaseOrder');
const GoodsReceipt = require('../../models/goodsReceipt');
const Vendor = require('../../models/vendor');
const Product = require('../../models/product');
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');
const { nextNumber } = require('../sequenceService');
const vendorLedger = require('../vendorLedgerService');
const config = require('../configService');
const notificationService = require('../notificationService');
const costing = require('./costing');
const products = require('./productLookup');
const h = require('./helpers');

const { httpError } = h;

const CHARGE_LABELS = {
  car_rent: 'Car rent',
  transport: 'Transport',
  builty_freight: 'Builty freight',
  loading: 'Loading',
  unloading: 'Unloading',
  landing: 'Landing',
  labour: 'Labour',
  misc: 'Misc',
};

const settings = () =>
  config.getMany({ 'purchasing.minMarginPct': 15, 'purchasing.requireDifferentReceiver': false }).then((c) => ({
    minMarginPct: Number(c['purchasing.minMarginPct']) || 0,
    requireDifferentReceiver: c['purchasing.requireDifferentReceiver'] === true || c['purchasing.requireDifferentReceiver'] === 'true',
  }));

const safeNotify = async (payload) => {
  try {
    await notificationService.notify(payload);
  } catch (e) {
    console.error('[purchasing] notify failed:', e.message);
  }
};

// ---------------------------------------------------------------- loading

async function findPO(req, id) {
  if (!h.isId(id)) throw httpError('Purchase order not found', 404);
  const po = await PurchaseOrder.findOne({ _id: id, ...branchFilter(req) });
  if (!po) throw httpError('Purchase order not found', 404);
  return po;
}

const assertOpen = (po) => {
  if (po.status !== 'open') {
    throw httpError(`Purchase order ${po.poNumber} is ${po.status} and cannot be changed`, 409, 'PO_LOCKED');
  }
  if (h.isLocked(po)) throw httpError('This purchase order is being closed right now. Try again in a moment.', 409, 'PO_BUSY');
};

/**
 * Load → change → save an OPEN purchase order. Retried when someone else saved
 * the same PO in between (optimistic concurrency), so `fn` must work on the
 * document it is given.
 */
async function mutateOpen(req, id, fn) {
  for (let attempt = 1; ; attempt++) {
    const po = await findPO(req, id);
    assertOpen(po);
    const result = await fn(po);
    costing.recalcPO(po);
    try {
      await po.save();
      return { po, result };
    } catch (err) {
      if (err && err.name === 'VersionError' && attempt < 3) continue;
      throw h.friendlyDbError(err);
    }
  }
}

const findBill = (po, billId) => {
  const bill = po.bills.id(billId);
  if (!bill) throw httpError('Vendor bill not found on this purchase order', 404);
  return bill;
};

// ---------------------------------------------------------------- parsing

async function loadVendor(vendorId) {
  if (!h.isId(vendorId)) throw httpError('Choose a vendor for this bill');
  const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: { $ne: true } }).lean();
  if (!vendor) throw httpError('Vendor not found', 404);
  if (vendor.isActive === false) throw httpError(`Vendor ${vendor.name} is inactive`);
  return vendor;
}

/**
 * One item from the request. Quantity in pieces (`qty`) or boxes × pieces per
 * box + loose pieces; price per piece (`unitPrice`) or per box (`boxPrice`).
 */
function parseItem(input, unit) {
  const perBox = unit.piecesPerBox || 1;
  let qty;
  let boxes = 0;
  if (h.has(input.qty)) {
    qty = h.toAmount(input.qty, 'Quantity', { int: true });
  } else {
    boxes = h.toAmount(input.boxes, 'Boxes', { int: true });
    qty = boxes * perBox + h.toAmount(input.loosePieces, 'Loose pieces', { int: true });
  }
  if (!(qty >= 1)) throw httpError(`Enter a quantity for ${unit.productName}`);

  let unitPrice = 0;
  if (h.has(input.unitPrice)) unitPrice = h.toPrice(input.unitPrice, 'Unit price');
  else if (h.has(input.boxPrice)) unitPrice = h.round4(h.toPrice(input.boxPrice, 'Box price') / perBox);

  return {
    product: unit.productId,
    variantId: unit.variantId,
    productName: unit.productName,
    code: unit.code,
    piecesPerBox: perBox,
    boxes,
    qty,
    unitPrice,
    discount: h.toAmount(input.discount, 'Line discount'),
    salePrice: unit.salePrice,
    note: h.toText(input.note, 300),
  };
}

const sameUnit = (item, unit) =>
  String(item.product) === String(unit.productId) && String(item.variantId || '') === String(unit.variantId || '');

/** Add items to a bill; the same product again adds to its quantity. */
async function addItemsToBill(bill, inputs, branchId) {
  const added = [];
  for (const input of inputs) {
    const unit = await products.loadUnit(input.productId || input.product, input.variantId || null, { branchId });
    const item = parseItem(input, unit);
    const existing = bill.items.find((i) => sameUnit(i, unit));
    if (existing) {
      existing.qty += item.qty;
      existing.boxes = (existing.boxes || 0) + item.boxes;
      if (h.has(input.unitPrice) || h.has(input.boxPrice)) existing.unitPrice = item.unitPrice;
      if (h.has(input.discount)) existing.discount = item.discount;
      added.push(existing._id);
    } else {
      bill.items.push(item);
      added.push(bill.items[bill.items.length - 1]._id);
    }
  }
  return added;
}

function applyBillFields(bill, body, vendor) {
  if (vendor) {
    bill.vendor = vendor._id;
    bill.vendorName = vendor.name;
  }
  if (body.billNo !== undefined) bill.billNo = h.toText(body.billNo, 60);
  if (body.billDate !== undefined) bill.billDate = h.toDate(body.billDate, 'Bill date');
  if (body.cartons !== undefined) bill.cartons = h.toAmount(body.cartons, 'Cartons', { int: true });
  if (body.discount !== undefined) bill.discount = h.toAmount(body.discount, 'Bill discount');
  if (body.notes !== undefined) bill.notes = h.toText(body.notes, 500);
}

const assertUniqueBillNo = (po, bill) => {
  if (!bill.billNo) return;
  const dup = po.bills.find(
    (b) => b !== bill && String(b._id) !== String(bill._id) && String(b.vendor) === String(bill.vendor) && b.billNo === bill.billNo
  );
  if (dup) throw httpError(`Bill no. ${bill.billNo} from ${bill.vendorName} is already on this purchase order`, 409);
};

// ---------------------------------------------------------------- read

async function meta() {
  const s = await settings();
  const categories = (await Product.distinct('category')).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    statuses: PurchaseOrder.STATUSES,
    chargeTypes: PurchaseOrder.CHARGE_TYPES.map((value) => ({ value, label: CHARGE_LABELS[value] || value })),
    allocationMethods: [
      { value: 'value', label: 'By value (default)', hint: 'Expensive lines carry more of the charges' },
      { value: 'quantity', label: 'By pieces', hint: 'Every piece carries the same charge' },
      { value: 'carton', label: 'By cartons', hint: "Each bill's cartons carry the same charge" },
    ],
    ...s,
    categories,
  };
}

async function list(req) {
  const q = req.query || {};
  const { page, limit, skip } = h.pageParams(q);
  const base = { ...branchFilter(req) };
  if (h.isId(q.vendorId)) base['bills.vendor'] = h.toId(q.vendorId);
  const range = h.dateRange(q.from, q.to);
  if (range) base.createdAt = range;
  const search = String(q.search || '').trim();
  if (search) {
    const rx = new RegExp(h.escapeRegex(search), 'i');
    base.$or = [
      { poNumber: rx },
      { grnNumber: rx },
      { 'bills.vendorName': rx },
      { 'bills.billNo': rx },
      { 'builty.builtyNo': rx },
      { buyerName: rx },
      { notes: rx },
    ];
  }

  const filter = { ...base };
  if (q.status === 'active') filter.status = { $in: ['open', 'closed', 'receiving'] };
  else if (PurchaseOrder.STATUSES.includes(q.status)) filter.status = q.status;

  const [rows, total, counts, sums] = await Promise.all([
    PurchaseOrder.find(filter, { 'bills.items': 0, history: 0, charges: 0 })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('branch', 'name code')
      .lean(),
    PurchaseOrder.countDocuments(filter),
    PurchaseOrder.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    PurchaseOrder.aggregate([
      { $match: filter },
      { $group: { _id: null, goods: { $sum: '$totals.goods' }, charges: { $sum: '$totals.charges' }, grand: { $sum: '$totals.grand' } } },
    ]),
  ]);

  const statusCounts = Object.fromEntries(PurchaseOrder.STATUSES.map((s) => [s, 0]));
  for (const c of counts) statusCounts[c._id] = c.n;
  statusCounts.all = counts.reduce((s, c) => s + c.n, 0);
  statusCounts.active = statusCounts.open + statusCounts.closed + statusCounts.receiving;
  const sum = sums[0] || {};

  const data = rows.map((po) => ({
    ...po,
    vendors: [...new Set((po.bills || []).map((b) => b.vendorName).filter(Boolean))],
    bills: (po.bills || []).map((b) => ({ _id: b._id, vendor: b.vendor, vendorName: b.vendorName, billNo: b.billNo, cartons: b.cartons, billTotal: b.billTotal })),
  }));
  return {
    data,
    meta: h.pageMeta(page, limit, total, {
      counts: statusCounts,
      totals: { goods: h.round2(sum.goods), charges: h.round2(sum.charges), grand: h.round2(sum.grand) },
    }),
  };
}

async function getOne(req, id) {
  const po = await findPO(req, id);
  await po.populate('branch', 'name code');
  const plain = po.toObject();
  delete plain.lockedAt;
  if (po.goodsReceipt) {
    const grn = await GoodsReceipt.findById(po.goodsReceipt).select('grnNumber status receiverName startedAt completedAt totals').lean();
    plain.grn = grn || null;
  }
  return plain;
}

async function costingFor(req, id) {
  const po = await findPO(req, id);
  const lines = po.bills.flatMap((b) => b.items);
  const units = await products.loadUnitsFor(lines, { branchId: po.branch });
  const { minMarginPct } = await settings();
  return costing.previewCosting(po, units, { minMarginPct });
}

// ---------------------------------------------------------------- write: header

async function create(req, body = {}) {
  const branch = await resolveWriteBranch(req);
  const method = body.allocationMethod || 'value';
  if (!PurchaseOrder.ALLOCATION_METHODS.includes(method)) throw httpError('Unknown allocation method');
  const po = new PurchaseOrder({
    poNumber: await nextNumber('PO'),
    branch,
    status: 'open',
    buyer: h.userId(req),
    buyerName: h.toText(body.buyerName, 100) || h.userName(req),
    notes: h.toText(body.notes, 1000),
    expectedArrival: h.toDate(body.expectedArrival, 'Expected arrival'),
    allocationMethod: method,
    createdBy: h.userId(req),
    history: [h.historyEntry(req, 'created')],
  });
  costing.recalcPO(po);
  try {
    await po.save();
  } catch (err) {
    throw h.friendlyDbError(err);
  }
  return po.toObject();
}

async function updateHeader(req, id, body = {}) {
  const { po } = await mutateOpen(req, id, (doc) => {
    if (body.notes !== undefined) doc.notes = h.toText(body.notes, 1000);
    if (body.buyerName !== undefined) doc.buyerName = h.toText(body.buyerName, 100) || doc.buyerName;
    if (body.expectedArrival !== undefined) doc.expectedArrival = h.toDate(body.expectedArrival, 'Expected arrival');
    if (body.allocationMethod !== undefined) {
      if (!PurchaseOrder.ALLOCATION_METHODS.includes(body.allocationMethod)) throw httpError('Unknown allocation method');
      doc.allocationMethod = body.allocationMethod;
    }
  });
  return po.toObject();
}

// ---------------------------------------------------------------- write: bills & items

async function addBill(req, id, body = {}, photos = []) {
  const vendor = await loadVendor(body.vendorId || body.vendor);
  const items = h.toList(body.items);
  const { po, result } = await mutateOpen(req, id, async (doc) => {
    doc.bills.push({ vendor: vendor._id, vendorName: vendor.name, photos, createdBy: h.userId(req) });
    const bill = doc.bills[doc.bills.length - 1];
    applyBillFields(bill, body, null);
    assertUniqueBillNo(doc, bill);
    await addItemsToBill(bill, items, doc.branch);
    doc.history.push(h.historyEntry(req, 'bill_added', `${vendor.name}${bill.billNo ? ` bill ${bill.billNo}` : ''}`));
    return bill._id;
  });
  return { po: po.toObject(), billId: result };
}

async function updateBill(req, id, billId, body = {}, photos = []) {
  const vendorId = body.vendorId || body.vendor;
  const vendor = vendorId ? await loadVendor(vendorId) : null;
  const remove = new Set(h.toList(body.removePhotos).map(String));
  const { po } = await mutateOpen(req, id, async (doc) => {
    const bill = findBill(doc, billId);
    applyBillFields(bill, body, vendor);
    assertUniqueBillNo(doc, bill);
    if (remove.size) bill.photos = bill.photos.filter((p) => !remove.has(p));
    if (photos.length) bill.photos.push(...photos);
    if (bill.photos.length > 10) throw httpError('A bill can have at most 10 photos');
  });
  return po.toObject();
}

async function removeBill(req, id, billId) {
  const { po } = await mutateOpen(req, id, (doc) => {
    const bill = findBill(doc, billId);
    doc.history.push(h.historyEntry(req, 'bill_removed', `${bill.vendorName}${bill.billNo ? ` bill ${bill.billNo}` : ''}`));
    bill.deleteOne();
  });
  return po.toObject();
}

async function addItems(req, id, billId, body = {}) {
  const inputs = Array.isArray(body.items) ? body.items : h.toList(body.items).length ? h.toList(body.items) : [body];
  if (!inputs.length) throw httpError('Add at least one item');
  const { po, result } = await mutateOpen(req, id, (doc) => addItemsToBill(findBill(doc, billId), inputs, doc.branch));
  return { po: po.toObject(), itemIds: result };
}

async function updateItem(req, id, billId, itemId, body = {}) {
  const { po } = await mutateOpen(req, id, (doc) => {
    const bill = findBill(doc, billId);
    const item = bill.items.id(itemId);
    if (!item) throw httpError('Item not found on this bill', 404);
    const unit = { productName: item.productName, piecesPerBox: item.piecesPerBox || 1 };
    if (h.has(body.qty) || h.has(body.boxes) || h.has(body.loosePieces)) {
      const parsed = parseItem({ qty: body.qty, boxes: body.boxes, loosePieces: body.loosePieces }, unit);
      item.qty = parsed.qty;
      item.boxes = parsed.boxes;
    }
    if (h.has(body.unitPrice)) item.unitPrice = h.toPrice(body.unitPrice, 'Unit price');
    else if (h.has(body.boxPrice)) item.unitPrice = h.round4(h.toPrice(body.boxPrice, 'Box price') / unit.piecesPerBox);
    if (body.discount !== undefined) item.discount = h.toAmount(body.discount, 'Line discount');
    if (body.note !== undefined) item.note = h.toText(body.note, 300);
  });
  return po.toObject();
}

async function removeItem(req, id, billId, itemId) {
  const { po } = await mutateOpen(req, id, (doc) => {
    const item = findBill(doc, billId).items.id(itemId);
    if (!item) throw httpError('Item not found on this bill', 404);
    item.deleteOne();
  });
  return po.toObject();
}

/** Stretch: create a brand-new product from a PO line and add it to the bill. */
async function addNewProduct(req, id, billId, body = {}) {
  if (!req.access.can('products', 'create')) throw httpError('You do not have permission to create products', 403);
  const po = await findPO(req, id);
  assertOpen(po);
  findBill(po, billId);
  // Check the line before creating anything, so a bad quantity leaves no orphan product.
  parseItem(body, { productName: h.toText(body.name, 200) || 'the new product', piecesPerBox: Math.max(1, parseInt(body.piecesPerBox, 10) || 1) });
  const unit = await products.createProductForLine(body, { branchId: String(po.branch) });
  const out = await addItems(req, id, billId, {
    items: [{ productId: unit.productId, qty: body.qty, boxes: body.boxes, loosePieces: body.loosePieces, unitPrice: body.unitPrice, boxPrice: body.boxPrice }],
  });
  return { ...out, product: unit };
}

// ---------------------------------------------------------------- write: charges

function parseCharge(body, current = {}) {
  const type = body.type !== undefined ? body.type : current.type;
  if (!PurchaseOrder.CHARGE_TYPES.includes(type)) throw httpError('Choose a charge type');
  const amount = body.amount !== undefined ? h.toAmount(body.amount, 'Amount') : current.amount;
  if (!(amount > 0)) throw httpError('Charge amount must be more than 0');
  return {
    type,
    amount,
    note: body.note !== undefined ? h.toText(body.note, 300) : current.note || '',
    paidTo: body.paidTo !== undefined ? h.toText(body.paidTo, 100) : current.paidTo || '',
  };
}

async function addCharge(req, id, body = {}) {
  const charge = parseCharge(body);
  const { po } = await mutateOpen(req, id, (doc) => {
    doc.charges.push({ ...charge, source: 'manual', createdBy: h.userId(req) });
    doc.history.push(h.historyEntry(req, 'charge_added', `${CHARGE_LABELS[charge.type]} Rs ${charge.amount}`));
  });
  return po.toObject();
}

async function updateCharge(req, id, chargeId, body = {}) {
  const { po } = await mutateOpen(req, id, (doc) => {
    const charge = doc.charges.id(chargeId);
    if (!charge) throw httpError('Charge not found', 404);
    Object.assign(charge, parseCharge(body, charge));
  });
  return po.toObject();
}

async function removeCharge(req, id, chargeId) {
  const { po } = await mutateOpen(req, id, (doc) => {
    const charge = doc.charges.id(chargeId);
    if (!charge) throw httpError('Charge not found', 404);
    doc.history.push(h.historyEntry(req, 'charge_removed', `${CHARGE_LABELS[charge.type]} Rs ${charge.amount}`));
    charge.deleteOne();
  });
  return po.toObject();
}

// ---------------------------------------------------------------- close / cancel / reopen

/** GRN lines from the PO (net vendor price per piece, carton share). */
function grnLinesFrom(po) {
  return costing.netLines(po).map((l, i) => ({
    lineNo: i + 1,
    bill: l.bill._id,
    poItem: l.item._id,
    vendor: l.bill.vendor,
    vendorName: l.bill.vendorName,
    billNo: l.bill.billNo,
    product: l.item.product,
    variantId: l.item.variantId || null,
    productName: l.item.productName,
    code: l.item.code,
    piecesPerBox: l.item.piecesPerBox || 1,
    expectedQty: l.qty,
    unitPrice: h.round4(l.netUnitPrice),
    lineValue: l.netTotal,
    cartonShare: l.cartonShare,
    shortQty: l.qty,
  }));
}

/**
 * After the PO is marked closed: post each vendor bill to the vendor ledger
 * and create the goods receipt. Idempotent (unique ledger rows, one GRN per
 * PO), so a retry after a failure finishes the job without duplicates.
 */
async function finalizeClose(req, po) {
  const refNo = po.poNumber;
  for (const bill of po.bills) {
    if (!(bill.billTotal > 0)) continue;
    const entry = await vendorLedger.post({
      vendorId: bill.vendor,
      type: 'bill',
      credit: bill.billTotal,
      date: bill.billDate || po.closedAt || new Date(),
      branchId: po.branch,
      reference: bill.billNo || '',
      attachments: bill.photos || [],
      refType: 'PurchaseOrder',
      refId: bill._id,
      refNo,
      description: `Purchase ${po.poNumber}${bill.billNo ? ` · bill ${bill.billNo}` : ''} · ${bill.items.length} items, ${bill.cartons || 0} cartons`,
      userId: h.userId(req),
      unique: true,
    });
    bill.ledgerEntry = entry._id;
  }

  let grn = await GoodsReceipt.findOne({ purchaseOrder: po._id });
  if (!grn) {
    try {
      grn = await GoodsReceipt.create({
        grnNumber: await nextNumber('GRN'),
        purchaseOrder: po._id,
        poNumber: po.poNumber,
        branch: po.branch,
        status: 'pending',
        buyer: po.buyer,
        buyerName: po.buyerName,
        builty: {
          builtyNo: po.builty.builtyNo,
          transporter: po.builty.transporter,
          date: po.builty.date,
          cartons: po.builty.cartons,
          photos: po.builty.photos,
        },
        allocationMethod: po.allocationMethod,
        chargesTotal: po.totals.charges,
        expectedCartons: po.builty.cartons || po.totals.cartons,
        lines: grnLinesFrom(po),
        createdBy: h.userId(req),
        history: [h.historyEntry(req, 'created', `From ${po.poNumber}`)],
      });
    } catch (err) {
      if (err && err.code === 11000) grn = await GoodsReceipt.findOne({ purchaseOrder: po._id });
      if (!grn) throw err;
    }
  }
  const isNew = !po.goodsReceipt;
  po.goodsReceipt = grn._id;
  po.grnNumber = grn.grnNumber;
  await po.save();

  if (isNew) {
    const vendors = [...new Set(po.bills.map((b) => b.vendorName))].join(', ');
    await safeNotify({
      type: 'goods_receiving',
      title: `Goods to receive: ${grn.grnNumber}`,
      message: `${po.builty.cartons || po.totals.cartons} cartons (${po.totals.pieces} pcs) from ${vendors}. Builty ${po.builty.builtyNo || '—'}. Please verify and receive.`,
      level: 'info',
      link: `/admin/purchasing/receiving/${grn._id}`,
      branchId: po.branch,
      audience: 'goods_receiving',
      meta: { purchaseOrderId: po._id, goodsReceiptId: grn._id },
    });
  }
  return grn;
}

async function close(req, id, body = {}, photos = []) {
  const current = await findPO(req, id);
  if (!['open', 'closed'].includes(current.status)) {
    throw httpError(`Purchase order ${current.poNumber} is already ${current.status}`, 409, 'PO_LOCKED');
  }
  const po = await h.acquireLock(PurchaseOrder, current._id, { status: { $in: ['open', 'closed'] } });
  if (!po) throw httpError('This purchase order is being closed right now. Try again in a moment.', 409, 'PO_BUSY');

  const warnings = [];
  try {
    if (po.status === 'open') {
      // Validate the trip
      if (!po.bills.length) throw httpError('Add at least one vendor bill before closing');
      const empty = po.bills.find((b) => !b.items.length);
      if (empty) throw httpError(`Bill from ${empty.vendorName} has no items. Add items or remove the bill.`);

      const builtyNo = body.builtyNo !== undefined ? h.toText(body.builtyNo, 60) : po.builty.builtyNo;
      const builtyPhotos = [...(po.builty.photos || []), ...photos].slice(0, 10);
      if (!builtyNo && !builtyPhotos.length) throw httpError('Enter the builty number or upload the builty photo');
      const cartons = h.has(body.cartons) ? h.toAmount(body.cartons, 'Cartons', { int: true }) : po.builty.cartons;
      if (!(cartons > 0)) throw httpError('Enter how many cartons are on the builty');
      const freight = h.has(body.freight) ? h.toAmount(body.freight, 'Freight') : po.builty.freight || 0;

      po.builty = {
        builtyNo,
        transporter: body.transporter !== undefined ? h.toText(body.transporter, 100) : po.builty.transporter,
        date: h.has(body.date) ? h.toDate(body.date, 'Builty date') : po.builty.date || new Date(),
        cartons,
        freight,
        photos: builtyPhotos,
        submittedAt: new Date(),
        submittedBy: h.userId(req),
      };
      // Freight paid on the builty is a trip charge (one row, replaced on every close).
      po.charges = po.charges.filter((c) => c.source !== 'builty');
      if (freight > 0) {
        po.charges.push({
          type: 'builty_freight',
          amount: freight,
          note: `Builty ${builtyNo || ''}`.trim(),
          paidTo: po.builty.transporter,
          source: 'builty',
          createdBy: h.userId(req),
        });
      }
      costing.recalcPO(po);
      if (po.totals.cartons && po.totals.cartons !== cartons) {
        warnings.push(`Builty says ${cartons} cartons but the bills add up to ${po.totals.cartons}.`);
      }
      po.status = 'closed';
      po.closedAt = new Date();
      po.closedBy = h.userId(req);
      po.history.push(h.historyEntry(req, 'closed', [`Builty ${builtyNo || '(photo)'}, ${cartons} cartons`, ...warnings].join(' ')));
      try {
        await po.save();
      } catch (err) {
        throw h.friendlyDbError(err);
      }
    }
    const grn = await finalizeClose(req, po);
    return { po: po.toObject(), grn: { _id: grn._id, grnNumber: grn.grnNumber, status: grn.status }, warnings };
  } finally {
    await h.releaseLock(PurchaseOrder, po._id);
  }
}

/**
 * Undo the close (bills voided in the vendor ledger, GRN removed) while the
 * receiver has not started. `mode` 'cancel' also cancels the PO; 'reopen'
 * puts it back to open so the buyer can fix it.
 */
async function undoClose(req, po, mode, reason) {
  if (po.goodsReceipt) {
    if (mode === 'reopen') {
      const res = await GoodsReceipt.deleteOne({ _id: po.goodsReceipt, status: 'pending' });
      if (!res.deletedCount && (await GoodsReceipt.exists({ _id: po.goodsReceipt }))) {
        throw httpError('Receiving has already started for this purchase order', 409, 'RECEIVING_STARTED');
      }
    } else {
      const res = await GoodsReceipt.updateOne(
        { _id: po.goodsReceipt, status: 'pending' },
        { $set: { status: 'cancelled' }, $push: { history: h.historyEntry(req, 'cancelled', reason) } }
      );
      if (!res.modifiedCount && (await GoodsReceipt.exists({ _id: po.goodsReceipt, status: { $ne: 'cancelled' } }))) {
        throw httpError('Receiving has already started for this purchase order', 409, 'RECEIVING_STARTED');
      }
    }
  }
  for (const bill of po.bills) {
    await vendorLedger.voidByRef('PurchaseOrder', bill._id, {
      userId: h.userId(req),
      reason: `${po.poNumber} ${mode === 'reopen' ? 'reopened' : 'cancelled'}${reason ? `: ${reason}` : ''}`,
    });
    bill.ledgerEntry = null;
  }
}

async function cancel(req, id, body = {}) {
  const current = await findPO(req, id);
  if (!['open', 'closed'].includes(current.status)) {
    throw httpError(
      current.status === 'cancelled' ? 'This purchase order is already cancelled' : 'Receiving has started; this purchase order can no longer be cancelled',
      409
    );
  }
  const po = await h.acquireLock(PurchaseOrder, current._id, { status: { $in: ['open', 'closed'] } });
  if (!po) throw httpError('This purchase order is busy right now. Try again in a moment.', 409, 'PO_BUSY');
  const reason = h.toText(body.reason, 300);
  try {
    if (po.status === 'closed') await undoClose(req, po, 'cancel', reason);
    po.status = 'cancelled';
    po.cancelledAt = new Date();
    po.cancelledBy = h.userId(req);
    po.cancelReason = reason;
    po.history.push(h.historyEntry(req, 'cancelled', reason));
    await po.save();
    return po.toObject();
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(PurchaseOrder, po._id);
  }
}

async function reopen(req, id, body = {}) {
  const current = await findPO(req, id);
  if (current.status !== 'closed') throw httpError('Only a closed purchase order that is not being received can be reopened', 409);
  const po = await h.acquireLock(PurchaseOrder, current._id, { status: 'closed' });
  if (!po) throw httpError('This purchase order is busy right now. Try again in a moment.', 409, 'PO_BUSY');
  const reason = h.toText(body.reason, 300);
  try {
    await undoClose(req, po, 'reopen', reason);
    po.status = 'open';
    po.goodsReceipt = null;
    po.grnNumber = '';
    po.closedAt = null;
    po.closedBy = null;
    po.history.push(h.historyEntry(req, 'reopened', reason));
    await po.save();
    return po.toObject();
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(PurchaseOrder, po._id);
  }
}

module.exports = {
  CHARGE_LABELS,
  settings,
  safeNotify,
  meta,
  list,
  getOne,
  costingFor,
  create,
  updateHeader,
  addBill,
  updateBill,
  removeBill,
  addItems,
  updateItem,
  removeItem,
  addNewProduct,
  addCharge,
  updateCharge,
  removeCharge,
  close,
  cancel,
  reopen,
};
