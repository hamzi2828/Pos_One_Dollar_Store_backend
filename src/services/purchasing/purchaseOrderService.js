// src/services/purchasing/purchaseOrderService.js
// Purchase orders: one buying trip, many vendor bills, trip charges, builty.
// See models/purchaseOrder.js for the workflow and docs/STORE_OPERATIONS.md §1.
const PurchaseOrder = require('../../models/purchaseOrder');
const GoodsReceipt = require('../../models/goodsReceipt');
const Vendor = require('../../models/vendor');
const Product = require('../../models/product');
const User = require('../../models/user');
const { STAFF_FILTER, isEffectiveSuperAdmin } = require('../../controller/staffController');
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
  loading: 'Loading / unloading',
  unloading: 'Loading / unloading', // old rows only; new ones are saved as 'loading'
  landing: 'Landing',
  labour: 'Labour',
  misc: 'Misc',
};

/** Old charge types folded into another one: new costs are saved as the target. */
const MERGED_CHARGE_TYPES = { unloading: 'loading' };

const settings = () =>
  config.getMany({ 'purchasing.minMarginPct': 15, 'purchasing.requireDifferentReceiver': false }).then((c) => ({
    minMarginPct: Number(c['purchasing.minMarginPct']) || 0,
    requireDifferentReceiver: c['purchasing.requireDifferentReceiver'] === true || c['purchasing.requireDifferentReceiver'] === 'true',
  }));

/** Owner-only purchasing rules (super admin route). */
async function updateSettings(req, body = {}) {
  const userId = h.userId(req);
  if (body.requireDifferentReceiver !== undefined) {
    await config.set('purchasing.requireDifferentReceiver', h.toBool(body.requireDifferentReceiver, false), userId);
  }
  if (body.minMarginPct !== undefined) {
    const pct = Number(body.minMarginPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw httpError('Minimum margin must be between 0 and 100');
    await config.set('purchasing.minMarginPct', pct, userId);
  }
  return settings();
}

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

// Bills can still be added / fixed after "Send to warehouse" while the goods are
// being received (owner, 2026-10-31): more buying for the same trip.
const BILL_STATUSES = ['open', 'closed', 'receiving'];

const assertOpen = (po, { bills = false } = {}) => {
  if (bills ? !BILL_STATUSES.includes(po.status) : po.status !== 'open') {
    throw httpError(`Purchase order ${po.poNumber} is ${po.status} and cannot be changed`, 409, 'PO_LOCKED');
  }
  if (h.isLocked(po)) throw httpError('This purchase order is being closed right now. Try again in a moment.', 409, 'PO_BUSY');
};

/**
 * Load → change → save an OPEN purchase order. Retried when someone else saved
 * the same PO in between (optimistic concurrency), so `fn` must work on the
 * document it is given.
 */
async function mutateOpen(req, id, fn, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const po = await findPO(req, id);
    assertOpen(po, opts);
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

// UI words → VendorPayment.METHODS
const METHOD_ALIASES = { bank_transfer: 'bank', transfer: 'bank', online: 'bank' };

function paymentMethodOf(value) {
  const VendorPayment = require('../../models/vendorPayment');
  const raw = String(value || '').trim().toLowerCase() || 'cash';
  const method = METHOD_ALIASES[raw] || raw;
  if (!VendorPayment.METHODS.includes(method)) {
    throw httpError(`Payment method must be one of: cash, bank_transfer, cheque, easypaisa, jazzcash, other`);
  }
  return method;
}

/** Bank id for the "paid now" payment (null = none). Checked here so sending the trip never fails on it. */
async function loadPaidBank(value) {
  if (!h.has(value)) return null;
  if (!h.isId(value)) throw httpError('Choose a valid bank account');
  const Bank = require('../../models/bank');
  const bank = await Bank.findOne({ _id: value, isDeleted: { $ne: true } }).select('_id').lean();
  if (!bank) throw httpError('Bank account not found', 404);
  return bank._id;
}

/** Parse bill money fields once (outside the save-retry loop). */
async function parseBillMoney(body) {
  const out = {};
  if (body.billAmount !== undefined) out.billAmount = h.toAmount(body.billAmount, 'Bill amount');
  if (body.paidNow !== undefined) out.paidNow = h.toAmount(body.paidNow, 'Paid now');
  if (body.paidMethod !== undefined) out.paidMethod = paymentMethodOf(body.paidMethod);
  if (body.paidBank !== undefined) out.paidBank = await loadPaidBank(body.paidBank);
  return out;
}

function applyBillFields(bill, body, vendor, money = {}) {
  if (vendor) {
    bill.vendor = vendor._id;
    bill.vendorName = vendor.name;
  }
  if (body.billNo !== undefined) bill.billNo = h.toText(body.billNo, 60);
  if (body.billDate !== undefined) bill.billDate = h.toDate(body.billDate, 'Bill date');
  if (body.cartons !== undefined) bill.cartons = h.toAmount(body.cartons, 'Boxes', { int: true });
  if (body.discount !== undefined) bill.discount = h.toAmount(body.discount, 'Bill discount');
  if (body.notes !== undefined) bill.notes = h.toText(body.notes, 500);
  Object.assign(bill, money);
}

/** Paid now can never be more than what the bill says we owe. */
function assertPaidFits(bill) {
  costing.recalcBill(bill);
  if (bill.paidNow > 0 && bill.paidNow > bill.billTotal) {
    throw httpError(
      `Paid now (Rs ${bill.paidNow}) on the bill from ${bill.vendorName} is more than the bill total (Rs ${bill.billTotal}). Enter the bill amount first.`
    );
  }
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
    chargeTypes: PurchaseOrder.CHARGE_TYPES.filter((value) => !MERGED_CHARGE_TYPES[value]).map((value) => ({ value, label: CHARGE_LABELS[value] || value })),
    allocationMethods: [
      { value: 'value', label: 'By value (default)', hint: 'Expensive lines carry more of the charges' },
      { value: 'quantity', label: 'By pieces', hint: 'Every piece carries the same charge' },
      { value: 'carton', label: 'By cartons', hint: "Each bill's cartons carry the same charge" },
    ],
    ...s,
    categories,
  };
}

// ---------------------------------------------------------------- buyers (staff logins)

const staffName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Staff';
const ACTIVE_STAFF = { $and: [STAFF_FILTER, { isActive: { $ne: false } }] };

/** Active staff logins a trip can be bought by (Buyer dropdown). Names only, no staff permission needed. */
async function buyers() {
  const users = await User.find(ACTIVE_STAFF)
    .select('firstName lastName email role isSuperAdmin staffRole branch')
    .populate('staffRole', 'name')
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  return users.map((u) => ({
    id: String(u._id),
    name: staffName(u),
    role: isEffectiveSuperAdmin(u) ? 'Super Admin' : (u.staffRole && u.staffRole.name) || null,
  }));
}

/** The staff login picked as buyer (must be an active staff member). */
async function loadBuyer(buyerId) {
  const user = h.isId(buyerId) ? await User.findOne({ _id: h.toId(buyerId), ...ACTIVE_STAFF }).select('firstName lastName email').lean() : null;
  if (!user) throw httpError('Pick the buyer from the staff list (that staff login is missing or switched off).');
  return user;
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
    bills: (po.bills || []).map((b) => ({
      _id: b._id,
      vendor: b.vendor,
      vendorName: b.vendorName,
      billNo: b.billNo,
      cartons: b.cartons,
      billAmount: b.billAmount || 0,
      billTotal: b.billTotal,
      paidNow: b.paidNow || 0,
    })),
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
    const grn = await GoodsReceipt.findById(po.goodsReceipt)
      .select('grnNumber status receiverName startedAt completedAt totals boxes boxesCheckedAt boxesDone entries.bill entries.undone')
      .lean();
    if (grn) {
      // Per vendor bill, where it is in the warehouse: not_checked → checked → unpacking → done.
      const legacy = grn.boxesCheckedAt && !(grn.boxes || []).some((b) => b.checkedAt);
      grn.byBill = (grn.boxes || []).map((b) => {
        const checked = !!b.checkedAt || !!legacy;
        const items = (grn.entries || []).filter((e) => !e.undone && String(e.bill) === String(b.bill)).length;
        const boxesDone = (grn.boxesDone || []).filter((d) => String(d.bill) === String(b.bill)).length;
        const done = grn.status === 'completed' || (checked && b.received > 0 && boxesDone >= b.received);
        return {
          bill: b.bill,
          status: done ? 'done' : items || boxesDone ? 'unpacking' : checked ? 'checked' : 'not_checked',
          expected: b.expected || 0,
          received: checked ? b.received || 0 : null,
          boxesDone,
          items,
        };
      });
      delete grn.boxes;
      delete grn.boxesDone;
      delete grn.entries;
    }
    plain.grn = grn || null;
  }
  // Vendor money (previous balance, paid, balance) only for people who see vendor payments
  // (owner, 2026-11-08: the warehouse assistant sees only "This bill").
  const seesMoney = !req.access || req.access.isSuperAdmin || req.access.can('vendor_payments', 'view');
  if (seesMoney) plain.billAccounts = await billAccounts(po);
  return plain;
}

/**
 * Per bill, the vendor's account around it (owner, 2026-11-08): balance before
 * this bill, this bill, total, paid since (paid now + later payments / returns)
 * and what is left. Uses the bill's row in the vendor ledger (posted on "add bill").
 */
async function billAccounts(po) {
  const VendorLedgerEntry = require('../../models/vendorLedgerEntry');
  const out = {};
  for (const bill of po.bills) {
    const entry = bill.ledgerEntry ? await VendorLedgerEntry.findOne({ _id: bill.ledgerEntry, isVoided: false }).select('createdAt').lean() : null;
    const at = entry ? entry.createdAt : new Date();
    const sums = async (filter) => {
      const [row] = await VendorLedgerEntry.aggregate([
        { $match: { vendor: bill.vendor, isVoided: false, ...filter } },
        { $group: { _id: null, credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
      ]);
      return { credit: row ? row.credit : 0, debit: row ? row.debit : 0 };
    };
    const before = await sums({ createdAt: { $lt: at } });
    const after = entry ? await sums({ createdAt: { $gt: at } }) : { debit: Number(bill.paidNow) || 0 };
    const previous = vendorLedger.round2(before.credit - before.debit);
    const thisBill = vendorLedger.round2(bill.billTotal || 0);
    const paid = vendorLedger.round2(after.debit || 0);
    out[String(bill._id)] = { previous, thisBill, total: vendorLedger.round2(previous + thisBill), paid, balance: vendorLedger.round2(previous + thisBill - paid) };
  }
  return out;
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
  // buyerId = a staff login; else a typed name (e.g. a driver) bought for the person starting the trip.
  const picked = body.buyerId ? await loadBuyer(body.buyerId) : null;
  const po = new PurchaseOrder({
    poNumber: await nextNumber('PO'),
    branch,
    status: 'open',
    buyer: picked ? picked._id : h.userId(req),
    buyerName: picked ? staffName(picked) : h.toText(body.buyerName, 100) || h.userName(req),
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
  const picked = body.buyerId ? await loadBuyer(body.buyerId) : null;
  const { po } = await mutateOpen(req, id, (doc) => {
    if (body.notes !== undefined) doc.notes = h.toText(body.notes, 1000);
    if (picked) {
      doc.buyer = picked._id;
      doc.buyerName = staffName(picked);
    } else if (body.buyerName !== undefined) {
      doc.buyerName = h.toText(body.buyerName, 100) || doc.buyerName;
      // Switched to a typed name: the trip counts as bought by whoever started it.
      if (body.buyerId === null || body.buyerId === '') doc.buyer = doc.createdBy || doc.buyer;
    }
    if (body.expectedArrival !== undefined) doc.expectedArrival = h.toDate(body.expectedArrival, 'Expected arrival');
    if (body.allocationMethod !== undefined) {
      if (!PurchaseOrder.ALLOCATION_METHODS.includes(body.allocationMethod)) throw httpError('Unknown allocation method');
      doc.allocationMethod = body.allocationMethod;
    }
  });
  return po.toObject();
}

// ---------------------------------------------------------------- write: bills & items

const BILLS = { bills: true };

/** After send: the bill's goods are already being entered in the warehouse? */
async function billHasEntries(po, billId) {
  if (!po.goodsReceipt) return false;
  return !!(await GoodsReceipt.exists({ _id: po.goodsReceipt, entries: { $elemMatch: { bill: billId, undone: { $ne: true } } } }));
}

/** After send: refuse changes to the items of a bill the warehouse is already unpacking. */
async function assertBillNotUnpacked(req, id, billId, what = 'changed') {
  const po = await findPO(req, id);
  if (!h.isId(billId)) throw httpError('Bill not found', 404);
  if (await billHasEntries(po, billId)) {
    const bill = po.bills.id(billId);
    throw httpError(
      `${bill ? bill.vendorName : 'This bill'}: goods are already being entered in the warehouse, so this bill can no longer be ${what}.`,
      409,
      'BILL_UNPACKING'
    );
  }
}

/** Everything that must follow a bill change: vendor account rows, then the warehouse receipt. */
async function afterBillChange(req, po) {
  await syncBillAccounts(req, po);
  await syncGRN(req, po);
}

async function addBill(req, id, body = {}, photos = []) {
  const vendor = await loadVendor(body.vendorId || body.vendor);
  const items = h.toList(body.items);
  const money = await parseBillMoney(body);
  const { po, result } = await mutateOpen(
    req,
    id,
    async (doc) => {
      doc.bills.push({ vendor: vendor._id, vendorName: vendor.name, photos, createdBy: h.userId(req) });
      const bill = doc.bills[doc.bills.length - 1];
      applyBillFields(bill, body, null, money);
      assertUniqueBillNo(doc, bill);
      await addItemsToBill(bill, items, doc.branch);
      assertPaidFits(bill);
      const late = doc.status === 'open' ? '' : ' (after send to warehouse)';
      doc.history.push(h.historyEntry(req, 'bill_added', `${vendor.name}${bill.billNo ? ` bill ${bill.billNo}` : ''}${late}`));
      return bill._id;
    },
    BILLS
  );
  await afterBillChange(req, po);
  return { po: po.toObject(), billId: result };
}

async function updateBill(req, id, billId, body = {}, photos = []) {
  const vendorId = body.vendorId || body.vendor;
  const vendor = vendorId ? await loadVendor(vendorId) : null;
  const remove = new Set(h.toList(body.removePhotos).map(String));
  const money = await parseBillMoney(body);
  if (vendor) {
    const current = (await findPO(req, id)).bills.id(billId);
    if (current && String(current.vendor) !== String(vendor._id)) await assertBillNotUnpacked(req, id, billId, 'moved to another vendor');
  }
  const { po } = await mutateOpen(
    req,
    id,
    async (doc) => {
      const bill = findBill(doc, billId);
      applyBillFields(bill, body, vendor, money);
      assertUniqueBillNo(doc, bill);
      assertPaidFits(bill);
      if (remove.size) bill.photos = bill.photos.filter((p) => !remove.has(p));
      if (photos.length) bill.photos.push(...photos);
      if (bill.photos.length > 10) throw httpError('A bill can have at most 10 photos');
    },
    BILLS
  );
  await afterBillChange(req, po);
  return po.toObject();
}

async function removeBill(req, id, billId) {
  await assertBillNotUnpacked(req, id, billId, 'removed');
  // Still buying: a bill sent on its own whose boxes the warehouse already checked stays.
  const current = await findPO(req, id);
  if (current.status === 'open' && current.goodsReceipt) {
    const grn = await GoodsReceipt.findById(current.goodsReceipt).select('boxes').lean();
    const box = grn && (grn.boxes || []).find((b) => String(b.bill) === String(billId));
    if (box && box.checkedAt) {
      throw httpError('The warehouse has already checked the boxes/packs of this bill, so it cannot be removed.', 409, 'BILL_UNPACKING');
    }
  }
  let removed = null;
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
      const bill = findBill(doc, billId);
      if (doc.status !== 'open' && doc.bills.length <= 1) throw httpError('A sent trip needs at least one vendor bill. Cancel the trip instead.', 409);
      removed = { bill: bill.toObject(), index: doc.bills.indexOf(bill) };
      doc.history.push(h.historyEntry(req, 'bill_removed', `${bill.vendorName}${bill.billNo ? ` bill ${bill.billNo}` : ''}`));
      bill.deleteOne();
    },
    BILLS
  );
  // Out of the vendor account too (row + "paid now" payment).
  if (removed) await voidBillAccount(req, po, removed.bill, removed.index, `${po.poNumber} bill removed`);
  await syncGRN(req, po);
  return po.toObject();
}

async function addItems(req, id, billId, body = {}) {
  const inputs = Array.isArray(body.items) ? body.items : h.toList(body.items).length ? h.toList(body.items) : [body];
  if (!inputs.length) throw httpError('Add at least one item');
  await assertBillNotUnpacked(req, id, billId);
  const { po, result } = await mutateOpen(req, id, (doc) => addItemsToBill(findBill(doc, billId), inputs, doc.branch), BILLS);
  await afterBillChange(req, po);
  return { po: po.toObject(), itemIds: result };
}

async function updateItem(req, id, billId, itemId, body = {}) {
  await assertBillNotUnpacked(req, id, billId);
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
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
    },
    BILLS
  );
  await afterBillChange(req, po);
  return po.toObject();
}

async function removeItem(req, id, billId, itemId) {
  await assertBillNotUnpacked(req, id, billId);
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
      const item = findBill(doc, billId).items.id(itemId);
      if (!item) throw httpError('Item not found on this bill', 404);
      item.deleteOne();
    },
    BILLS
  );
  await afterBillChange(req, po);
  return po.toObject();
}

/** Stretch: create a brand-new product from a PO line and add it to the bill. */
async function addNewProduct(req, id, billId, body = {}) {
  if (!req.access.can('products', 'create')) throw httpError('You do not have permission to create products', 403);
  const po = await findPO(req, id);
  assertOpen(po, BILLS);
  findBill(po, billId);
  await assertBillNotUnpacked(req, id, billId);
  // Check the line before creating anything, so a bad quantity leaves no orphan product.
  parseItem(body, { productName: h.toText(body.name, 200) || 'the new product', piecesPerBox: Math.max(1, parseInt(body.piecesPerBox, 10) || 1) });
  const unit = await products.createProductForLine(body, { branchId: String(po.branch) });
  const out = await addItems(req, id, billId, {
    items: [{ productId: unit.productId, qty: body.qty, boxes: body.boxes, loosePieces: body.loosePieces, unitPrice: body.unitPrice, boxPrice: body.boxPrice }],
  });
  return { ...out, product: unit };
}

/**
 * Bills changed after "Send to warehouse": bring the warehouse receipt up to date.
 * New vendor bills get a box/pack row (not checked yet) and their typed items;
 * bills already being unpacked keep their counts and lines; removed bills drop out.
 */
async function syncGRN(req, po) {
  if (!['open', 'closed', 'receiving'].includes(po.status) || !po.goodsReceipt) return;
  // Still buying and no bill sent any more: the receipt goes away (if the warehouse has not started).
  if (po.status === 'open' && !sentBills(po).length) {
    const res = await GoodsReceipt.deleteOne({ _id: po.goodsReceipt, status: 'pending' });
    if (res.deletedCount) {
      await PurchaseOrder.updateOne({ _id: po._id }, { $set: { goodsReceipt: null, grnNumber: '' } });
      po.goodsReceipt = null;
      po.grnNumber = '';
      return;
    }
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const grn = await GoodsReceipt.findById(po.goodsReceipt).lean();
    if (!grn || !['pending', 'in_progress'].includes(grn.status)) return;
    const live = (grn.entries || []).filter((e) => !e.undone);
    const unpacking = (billId) => live.some((e) => String(e.bill) === String(billId));
    // Old receipts were checked all at once: keep their rows counted as checked.
    const legacyAt = grn.boxesCheckedAt && !(grn.boxes || []).some((b) => b.checkedAt) ? grn.boxesCheckedAt : null;
    const boxes = grnBoxesFrom(po).map((b) => {
      const was = (grn.boxes || []).find((x) => String(x.bill) === String(b.bill));
      return was ? { ...b, received: was.received || 0, checkedAt: was.checkedAt || legacyAt || null } : { ...b, checkedAt: null };
    });
    // Lines: keep those of bills being unpacked (counts live on them), rebuild the rest.
    const kept = (grn.lines || []).filter((l) => unpacking(l.bill) && sentBills(po).some((b) => String(b._id) === String(l.bill)));
    let lineNo = kept.reduce((m, l) => Math.max(m, l.lineNo || 0), 0);
    const fresh = grnLinesFrom(po)
      .filter((l) => !unpacking(l.bill))
      .map((l) => ({ ...l, lineNo: ++lineNo }));
    const goodsTotal = po.totals.goods;
    const set = {
      boxes,
      lines: [...kept, ...fresh],
      goodsTotal,
      expectedCartons: expectedCartonsOf(po),
      cartonsReceived: boxes.reduce((s, b) => s + (b.received || 0), 0),
    };
    // The charge rate is frozen once goods are entered; before that it follows the new goods total.
    if (!live.length) set.chargeRate = costing.chargeRateOf(po.totals.charges, goodsTotal);
    const res = await GoodsReceipt.updateOne(
      { _id: grn._id, __v: grn.__v, status: { $in: ['pending', 'in_progress'] } },
      { $set: set, $push: { history: h.historyEntry(req, 'bills_updated', `${po.poNumber}: ${boxes.length} vendor bills`) }, $inc: { __v: 1 } }
    );
    if (res.modifiedCount) return;
  }
  throw httpError('The warehouse receipt changed while saving. Reload and try again.', 409);
}

// ---------------------------------------------------------------- write: charges

function parseCharge(body, current = {}) {
  // 'unloading' is one type with 'loading' now (owner, 2026-10-30).
  const type = MERGED_CHARGE_TYPES[body.type] || (body.type !== undefined ? body.type : current.type);
  if (!PurchaseOrder.CHARGE_TYPES.includes(type)) throw httpError('Choose a charge type');
  const amount = body.amount !== undefined ? h.toAmount(body.amount, 'Amount') : current.amount;
  if (!(amount > 0)) throw httpError('Charge amount must be more than 0');
  return {
    type,
    amount,
    note: body.note !== undefined ? h.toText(body.note, 300) : current.note || '',
    paidTo: body.paidTo !== undefined ? h.toText(body.paidTo, 100) : current.paidTo || '',
    date: h.has(body.date) ? h.toDate(body.date, 'Date') : current.date || (current.type ? null : new Date()),
  };
}

const MAX_CHARGE_PHOTOS = 5;

// Trip costs, like vendor bills, can change until the trip is fully received
// (owner, 2026-11-01: a bill added after sending often brings its own costs).
// Goods already entered in the warehouse keep their cost; goods entered after
// the change use the new share (see syncChargeRate).

/** Keep the builty freight on the builty in step with its cost row. */
const syncBuiltyFreight = (doc, charge, amount) => {
  if (charge.source === 'builty' && doc.builty) doc.builty.freight = amount;
};

async function addCharge(req, id, body = {}, photos = []) {
  const charge = parseCharge(body);
  if (photos.length > MAX_CHARGE_PHOTOS) throw httpError(`A cost can have at most ${MAX_CHARGE_PHOTOS} files`);
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
      doc.charges.push({ ...charge, photos, source: 'manual', createdBy: h.userId(req) });
      doc.history.push(h.historyEntry(req, 'charge_added', `${CHARGE_LABELS[charge.type]} Rs ${charge.amount}`));
    },
    BILLS
  );
  await syncChargeRate(req, po);
  return po.toObject();
}

async function updateCharge(req, id, chargeId, body = {}, photos = []) {
  const remove = new Set(h.toList(body.removePhotos).map(String));
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
      const charge = doc.charges.id(chargeId);
      if (!charge) throw httpError('Charge not found', 404);
      const before = { type: charge.type, amount: charge.amount, note: charge.note || '' };
      // The builty freight row always stays "Builty freight".
      const next = parseCharge(charge.source === 'builty' ? { ...body, type: undefined } : body, charge);
      Object.assign(charge, next);
      syncBuiltyFreight(doc, charge, next.amount);
      if (remove.size) charge.photos = (charge.photos || []).filter((p) => !remove.has(p));
      if (photos.length) charge.photos.push(...photos);
      if (charge.photos.length > MAX_CHARGE_PHOTOS) throw httpError(`A cost can have at most ${MAX_CHARGE_PHOTOS} files`);
      if (before.type !== next.type || before.amount !== next.amount || before.note !== next.note) {
        const was = before.type !== next.type ? `${CHARGE_LABELS[before.type]} Rs ${before.amount}` : `Rs ${before.amount}`;
        doc.history.push(h.historyEntry(req, 'charge_changed', `${CHARGE_LABELS[next.type]} Rs ${next.amount} (was ${was})`));
      }
    },
    BILLS
  );
  await syncChargeRate(req, po);
  return po.toObject();
}

async function removeCharge(req, id, chargeId) {
  const { po } = await mutateOpen(
    req,
    id,
    (doc) => {
      const charge = doc.charges.id(chargeId);
      if (!charge) throw httpError('Charge not found', 404);
      doc.history.push(h.historyEntry(req, 'charge_removed', `${CHARGE_LABELS[charge.type]} Rs ${charge.amount}`));
      syncBuiltyFreight(doc, charge, 0);
      charge.deleteOne();
    },
    BILLS
  );
  await syncChargeRate(req, po);
  return po.toObject();
}

/**
 * Trip costs changed after "Send to warehouse": give the warehouse receipt the
 * new total and cost share (trip costs / goods). Entries already made keep
 * their landed cost; the next entries use the new share.
 */
async function syncChargeRate(req, po) {
  if (!['open', 'closed', 'receiving'].includes(po.status) || !po.goodsReceipt) return;
  const chargeRate = costing.chargeRateOf(po.totals.charges, po.totals.goods);
  const res = await GoodsReceipt.updateOne(
    { _id: po.goodsReceipt, status: { $in: ['pending', 'in_progress'] } },
    {
      $set: { chargesTotal: po.totals.charges, chargeRate, goodsTotal: po.totals.goods },
      $push: { history: h.historyEntry(req, 'charges_updated', `${po.poNumber}: trip costs Rs ${po.totals.charges}`) },
      $inc: { __v: 1 },
    }
  );
  return res.modifiedCount > 0;
}

// ---------------------------------------------------------------- close / cancel / reopen

/** GRN lines from the PO (net vendor price per piece, carton share). */
function grnLinesFrom(po) {
  const sent = new Set(sentBills(po).map((b) => String(b._id)));
  return costing.netLines(po).filter((l) => sent.has(String(l.bill._id))).map((l, i) => ({
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
/** Reference of the "paid at the market" payment of a bill (also how a retry finds it). */
const marketPaymentRef = (po, bill, index) => `${po.poNumber} bill ${bill.billNo || `#${index + 1}`}`;

/**
 * Record `bill.paidNow` as a vendor payment once (bill.payment set right after;
 * a payment with the same reference is reused if we crashed in between).
 */
async function postMarketPayment(req, po, bill, index) {
  if (!(bill.paidNow > 0) || bill.payment) return;
  const VendorPayment = require('../../models/vendorPayment');
  const paymentService = require('../vendors/paymentService');
  const reference = marketPaymentRef(po, bill, index);
  let payment = await VendorPayment.findOne({ vendor: bill.vendor, reference, status: 'active' }).select('_id').lean();
  if (!payment) {
    payment = await paymentService.recordPayment({
      vendorId: bill.vendor,
      branchId: po.branch,
      amount: bill.paidNow,
      method: bill.paidMethod || 'cash',
      bankId: bill.paidBank || null,
      reference,
      date: bill.billDate || po.closedAt || new Date(),
      notes: `Paid at the market · ${po.poNumber}`,
      userId: h.userId(req),
    });
  }
  bill.payment = payment._id;
  await PurchaseOrder.updateOne({ _id: po._id, 'bills._id': bill._id }, { $set: { 'bills.$.payment': payment._id } });
}

/** Void the market payment of a bill (reopen / cancel). Already voided is fine. */
async function voidMarketPayment(req, po, bill, index, reason) {
  const VendorPayment = require('../../models/vendorPayment');
  const paymentService = require('../vendors/paymentService');
  const ids = new Set(bill.payment ? [String(bill.payment)] : []);
  const found = await VendorPayment.find({ vendor: bill.vendor, reference: marketPaymentRef(po, bill, index), status: 'active' })
    .select('_id')
    .lean();
  found.forEach((p) => ids.add(String(p._id)));
  for (const id of ids) {
    try {
      await paymentService.voidPayment(req, id, { reason });
    } catch (err) {
      if (err.code !== 'ALREADY_VOIDED' && err.status !== 404) throw err;
    }
  }
  bill.payment = null;
}

/** GRN boxes checklist: one row per vendor bill. */
/** Bills the warehouse gets: all of them once the trip is sent, else only those sent one by one. */
const sentBills = (po) => (po.status === 'open' ? po.bills.filter((b) => b.sentAt) : po.bills);

/** Boxes/packs the warehouse should get. */
const expectedCartonsOf = (po) =>
  po.status === 'open' ? sentBills(po).reduce((s, b) => s + (b.cartons || 0), 0) : po.builty.cartons || po.totals.cartons;

const grnBoxesFrom = (po) =>
  sentBills(po).map((b) => ({
    bill: b._id,
    vendor: b.vendor,
    vendorName: b.vendorName,
    billNo: b.billNo,
    billTotal: b.billTotal,
    expected: b.cartons || 0,
    received: 0,
  }));

/** Date a bill counts from in the vendor account. */
const billDateOf = (po, bill) => bill.billDate || po.createdAt || new Date();

/** The bill's row in the vendor account (credit = bill total). Returns the existing live row if there is one. */
function postBillEntry(req, po, bill) {
  const what = bill.items.length ? `${bill.items.length} items, ${bill.cartons || 0} boxes` : `${bill.cartons || 0} boxes`;
  return vendorLedger.post({
    vendorId: bill.vendor,
    type: 'bill',
    credit: bill.billTotal,
    date: billDateOf(po, bill),
    branchId: po.branch,
    reference: bill.billNo || '',
    attachments: bill.photos || [],
    refType: 'PurchaseOrder',
    refId: bill._id,
    refNo: po.poNumber,
    description: `Purchase ${po.poNumber}${bill.billNo ? ` · bill ${bill.billNo}` : ''} · ${what}`,
    userId: h.userId(req),
    unique: true,
  });
}

/** Take a bill out of the vendor account: its row and its "paid now" payment. */
async function voidBillAccount(req, po, bill, index, why) {
  await vendorLedger.voidByRef('PurchaseOrder', bill._id, { userId: h.userId(req), reason: why });
  bill.ledgerEntry = null;
  await voidMarketPayment(req, po, bill, index, why);
}

/**
 * Open trip: a bill counts in the vendor's account as soon as it is added
 * (owner, 2026-10-30). After any change to the bills, make each bill's
 * account row and "paid now" payment match the bill again (changed = void the
 * old one and post a new one). Send to warehouse then finds them already there.
 */
async function syncBillAccounts(req, po) {
  if (!BILL_STATUSES.includes(po.status)) return;
  const VendorLedgerEntry = require('../../models/vendorLedgerEntry');
  const VendorPayment = require('../../models/vendorPayment');
  const paymentService = require('../vendors/paymentService');
  const why = `${po.poNumber} bill changed`;
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const updates = {};

  for (const [index, bill] of po.bills.entries()) {
    const at = `bills.${index}`;
    // Bill row
    const want = bill.billTotal > 0;
    const live = await VendorLedgerEntry.findOne({ refType: 'PurchaseOrder', refId: bill._id, type: 'bill', isVoided: false })
      .select('vendor credit date reference')
      .lean();
    const ok =
      !!live &&
      want &&
      String(live.vendor) === String(bill.vendor) &&
      vendorLedger.round2(live.credit) === vendorLedger.round2(bill.billTotal) &&
      day(live.date) === day(billDateOf(po, bill)) &&
      (live.reference || '') === (bill.billNo || '');
    if (live && !ok) await vendorLedger.voidByRef('PurchaseOrder', bill._id, { userId: h.userId(req), reason: why });
    const entryId = want ? (ok ? live._id : (await postBillEntry(req, po, bill))._id) : null;
    if (String(entryId || '') !== String(bill.ledgerEntry || '')) {
      bill.ledgerEntry = entryId;
      updates[`${at}.ledgerEntry`] = entryId;
    }

    // "Paid now" payment
    const paid = bill.paidNow > 0 ? bill.paidNow : 0;
    const pay = bill.payment ? await VendorPayment.findOne({ _id: bill.payment, status: 'active' }).select('vendor amount method bank').lean() : null;
    const payOk =
      !!pay &&
      paid > 0 &&
      String(pay.vendor) === String(bill.vendor) &&
      vendorLedger.round2(pay.amount) === vendorLedger.round2(paid) &&
      pay.method === (bill.paidMethod || 'cash') &&
      String(pay.bank || '') === String(bill.paidBank || '');
    if (payOk || (!pay && !paid && !bill.payment)) continue;
    if (pay) {
      try {
        await paymentService.voidPayment(req, pay._id, { reason: why });
      } catch (err) {
        if (err.code !== 'ALREADY_VOIDED' && err.status !== 404) throw err;
      }
    }
    let paymentId = null;
    if (paid > 0) {
      const created = await paymentService.recordPayment({
        vendorId: bill.vendor,
        branchId: po.branch,
        amount: paid,
        method: bill.paidMethod || 'cash',
        bankId: bill.paidBank || null,
        reference: marketPaymentRef(po, bill, index),
        date: billDateOf(po, bill),
        notes: `Paid at the market · ${po.poNumber}`,
        userId: h.userId(req),
      });
      paymentId = created._id;
    }
    bill.payment = paymentId;
    updates[`${at}.payment`] = paymentId;
  }
  if (Object.keys(updates).length) await PurchaseOrder.updateOne({ _id: po._id }, { $set: updates });
}

async function finalizeClose(req, po) {
  for (const [index, bill] of po.bills.entries()) {
    if (!(bill.billTotal > 0)) continue;
    const entry = await postBillEntry(req, po, bill); // already there when it was posted on "add bill"
    bill.ledgerEntry = entry._id;
    await postMarketPayment(req, po, bill, index);
  }

  const { grn, isNew } = await ensureGRN(req, po);
  if (!isNew) {
    // Some bills were already sent one by one: the receipt gets the builty and the rest of the bills.
    await GoodsReceipt.updateOne(
      { _id: grn._id },
      {
        $set: {
          builty: {
            builtyNo: po.builty.builtyNo,
            transporter: po.builty.transporter,
            date: po.builty.date,
            cartons: po.builty.cartons,
            photos: po.builty.photos,
          },
        },
      }
    );
    await syncGRN(req, po);
    // The warehouse already started on a sent bill: the trip is being received now.
    if (grn.status === 'in_progress' && po.status === 'closed') {
      po.status = 'receiving';
      po.history.push(h.historyEntry(req, 'receiving_started', grn.grnNumber));
      await po.save();
    }
  }

  const unsent = po.bills.filter((b) => !b.sentAt);
  if (isNew || unsent.length) {
    const vendors = [...new Set((isNew ? po.bills : unsent).map((b) => b.vendorName))].join(', ');
    await safeNotify({
      type: 'goods_receiving',
      title: `Goods to receive: ${grn.grnNumber}`,
      message: `${isNew ? '' : 'Rest of the trip: '}${po.builty.cartons || po.totals.cartons} boxes/packs from ${vendors}.${po.builty.builtyNo ? ` Builty ${po.builty.builtyNo}.` : ''} Please check the boxes/packs and enter the goods.`,
      level: 'info',
      link: `/admin/purchasing/receiving/${grn._id}`,
      branchId: po.branch,
      audience: 'goods_receiving',
      meta: { purchaseOrderId: po._id, goodsReceiptId: grn._id },
    });
  }
  // Every bill now counts as sent.
  if (unsent.length) {
    const at = po.closedAt || new Date();
    for (const b of unsent) {
      b.sentAt = at;
      b.sentBy = h.userId(req);
    }
    await po.save();
  }
  return grn;
}

/** The trip's warehouse receipt: found, or created with the bills sent so far. */
async function ensureGRN(req, po) {
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
        goodsTotal: po.totals.goods,
        chargeRate: costing.chargeRateOf(po.totals.charges, po.totals.goods),
        expectedCartons: expectedCartonsOf(po),
        boxes: grnBoxesFrom(po),
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
  return { grn, isNew };
}

/** One bill to the warehouse while the trip is still buying. Safe to repeat. */
async function sendBill(req, id, billId) {
  const current = await findPO(req, id);
  if (current.status !== 'open') throw httpError('This trip is already sent to the warehouse.', 409, 'PO_LOCKED');
  findBill(current, billId);
  const po = await h.acquireLock(PurchaseOrder, current._id, { status: 'open' });
  if (!po) throw httpError('This trip is busy right now. Try again in a moment.', 409, 'PO_BUSY');
  try {
    costing.recalcPO(po);
    const bill = findBill(po, billId);
    const label = `${bill.vendorName}${bill.billNo ? ` bill ${bill.billNo}` : ''}`;
    const fresh = !bill.sentAt;
    if (fresh) {
      if (!(bill.billTotal > 0)) throw httpError(`Bill from ${bill.vendorName} has no items and no bill amount. Enter the bill total (or add items) first.`);
      if (bill.paidNow > bill.billTotal) throw httpError(`Paid now (Rs ${bill.paidNow}) is more than the bill total (Rs ${bill.billTotal}).`);
      if (!(bill.cartons > 0)) throw httpError(`Enter how many boxes/packs come from ${bill.vendorName} first.`);
      bill.sentAt = new Date();
      bill.sentBy = h.userId(req);
      po.history.push(h.historyEntry(req, 'bill_sent', `${label} sent to warehouse (${bill.cartons} boxes/packs)`));
      try {
        await po.save();
      } catch (err) {
        throw h.friendlyDbError(err);
      }
    }
    // Vendor account row + "paid now" (normally already there from "add bill").
    const index = po.bills.indexOf(bill);
    bill.ledgerEntry = (await postBillEntry(req, po, bill))._id;
    await postMarketPayment(req, po, bill, index);

    const had = !!po.goodsReceipt;
    const { grn } = await ensureGRN(req, po);
    if (had) await syncGRN(req, po);
    if (fresh) {
      await safeNotify({
        type: 'goods_receiving',
        title: `Goods to receive: ${grn.grnNumber}`,
        message: `${bill.cartons} boxes/packs from ${label} (${po.poNumber}, still buying). Please check the boxes/packs and enter the goods.`,
        level: 'info',
        link: `/admin/purchasing/receiving/${grn._id}`,
        branchId: po.branch,
        audience: 'goods_receiving',
        meta: { purchaseOrderId: po._id, goodsReceiptId: grn._id },
      });
    }
    return { po: (await findPO(req, id)).toObject(), grn: { _id: grn._id, grnNumber: grn.grnNumber, status: grn.status } };
  } finally {
    await h.releaseLock(PurchaseOrder, po._id);
  }
}

/** Take back a bill sent by mistake, before the warehouse checked its boxes or entered goods. */
async function unsendBill(req, id, billId) {
  const current = await findPO(req, id);
  if (current.status !== 'open') throw httpError('The whole trip is already sent. Use "Reopen" instead.', 409, 'PO_LOCKED');
  const bill = findBill(current, billId);
  if (!bill.sentAt) return current.toObject();
  if (current.goodsReceipt) {
    const grn = await GoodsReceipt.findById(current.goodsReceipt).select('boxes entries.bill entries.undone').lean();
    const box = grn && (grn.boxes || []).find((b) => String(b.bill) === String(billId));
    const entered = grn && (grn.entries || []).some((e) => !e.undone && String(e.bill) === String(billId));
    if (entered || (box && box.checkedAt)) {
      throw httpError(`The warehouse has already started on the bill from ${bill.vendorName}, so it cannot be taken back.`, 409, 'BILL_UNPACKING');
    }
  }
  const po = await h.acquireLock(PurchaseOrder, current._id, { status: 'open' });
  if (!po) throw httpError('This trip is busy right now. Try again in a moment.', 409, 'PO_BUSY');
  try {
    const b = findBill(po, billId);
    b.sentAt = null;
    b.sentBy = null;
    po.history.push(h.historyEntry(req, 'bill_unsent', `${b.vendorName}${b.billNo ? ` bill ${b.billNo}` : ''} taken back from the warehouse`));
    await po.save();
    await syncGRN(req, po);
    return (await findPO(req, id)).toObject();
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(PurchaseOrder, po._id);
  }
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
      if (!po.bills.length) throw httpError('Add at least one vendor bill before sending to the warehouse');
      costing.recalcPO(po);
      const empty = po.bills.find((b) => !(b.billTotal > 0));
      if (empty) {
        throw httpError(`Bill from ${empty.vendorName} has no items and no bill amount. Enter the bill total (or add items), or remove the bill.`);
      }
      const overpaid = po.bills.find((b) => b.paidNow > b.billTotal);
      if (overpaid) {
        throw httpError(`Paid now (Rs ${overpaid.paidNow}) on the bill from ${overpaid.vendorName} is more than the bill total (Rs ${overpaid.billTotal}).`);
      }

      // Builty is optional (number, transporter, photo, freight).
      const builtyNo = body.builtyNo !== undefined ? h.toText(body.builtyNo, 60) : po.builty.builtyNo;
      const builtyPhotos = [...(po.builty.photos || []), ...photos].slice(0, 10);
      // Boxes: typed on the send screen, else the boxes on the bills.
      const cartons = h.has(body.cartons) ? h.toAmount(body.cartons, 'Boxes', { int: true }) : po.builty.cartons || po.totals.cartons;
      if (!(cartons > 0)) throw httpError('Enter how many boxes/packs (cartons) are coming to the warehouse');
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
        warnings.push(`${cartons} boxes/packs sent but the bills add up to ${po.totals.cartons} boxes/packs.`);
      }
      po.status = 'closed';
      po.closedAt = new Date();
      po.closedBy = h.userId(req);
      const builtyNote = builtyNo ? `Builty ${builtyNo}` : builtyPhotos.length ? 'Builty (photo)' : 'No builty';
      po.history.push(h.historyEntry(req, 'closed', [`Sent to warehouse: ${cartons} boxes. ${builtyNote}.`, ...warnings].join(' ')));
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
  // Reopen: the bills stay in the vendor accounts (they count from the moment
  // they are added). Cancel takes them out: see cancel().
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
    if (po.status === 'closed' || po.goodsReceipt) await undoClose(req, po, 'cancel', reason);
    // Bills (and money paid at the market) leave the vendor accounts, open or sent.
    const why = `${po.poNumber} cancelled${reason ? `: ${reason}` : ''}`;
    for (const [index, bill] of po.bills.entries()) await voidBillAccount(req, po, bill, index, why);
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
    for (const b of po.bills) {
      b.sentAt = null;
      b.sentBy = null;
    }
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
  updateSettings,
  safeNotify,
  meta,
  buyers,
  list,
  getOne,
  costingFor,
  create,
  updateHeader,
  addBill,
  updateBill,
  removeBill,
  sendBill,
  unsendBill,
  syncBillAccounts,
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
