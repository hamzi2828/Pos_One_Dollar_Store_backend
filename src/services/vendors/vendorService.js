// src/services/vendors/vendorService.js
// Vendor master data + the vendor account ("len den"):
//   list / get / create / update / activate / delete (soft, only at balance 0)
//   statement (opening, every row with running balance, closing, totals) + CSV
//   products bought from the vendor (first / last / min / max price, qty)
//   manual adjustments and opening balance rows
// Balances always come from services/vendorLedgerService.js.
const Vendor = require('../../models/vendor');
const VendorLedgerEntry = require('../../models/vendorLedgerEntry');
const StockMovement = require('../../models/stockMovement');
const Product = require('../../models/product');
const ledger = require('../vendorLedgerService');
const { nextNumber } = require('../sequenceService');
const {
  round2,
  httpError,
  oid,
  requireId,
  str,
  money,
  bool,
  dayStart,
  dayEnd,
  docDate,
  pageParams,
  pageMeta,
  searchRx,
  scope,
  userNames,
  branchNames,
  toCsv,
} = require('./common');

const TYPE_LABELS = {
  opening_balance: 'Opening balance',
  bill: 'Bill (purchase)',
  payment: 'Payment',
  debit_note: 'Return / debit note',
  credit_note: 'Credit note',
  consignment_settlement: 'Consignment settlement',
  discount: 'Discount',
  refund_received: 'Refund received',
  adjustment: 'Adjustment',
};

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RX = /^[A-Z0-9][A-Z0-9-]{0,29}$/;

// ---------- loading ----------

/** Live vendor or 404. `activeOnly` -> 400 when the vendor is switched off. */
async function loadVendor(vendorId, { activeOnly = false, lean = true } = {}) {
  const id = requireId(vendorId, 'vendor');
  let q = Vendor.findOne({ _id: id, isDeleted: { $ne: true } });
  if (lean) q = q.lean();
  const vendor = await q;
  if (!vendor) throw httpError('Vendor not found', 404);
  if (activeOnly && vendor.isActive === false) throw httpError(`${vendor.name} is inactive. Activate the vendor first.`, 400, 'VENDOR_INACTIVE');
  return vendor;
}

// ---------- input ----------

/** Clean vendor fields from a request body (only keys that were sent). */
function cleanInput(body = {}) {
  const out = {};
  const text = { name: 120, contactPerson: 120, phone: 40, whatsapp: 40, cnic: 30, ntn: 30, city: 80, notes: 2000 };
  for (const [k, max] of Object.entries(text)) if (body[k] !== undefined) out[k] = str(body[k], max);

  if (body.email !== undefined) {
    out.email = str(body.email, 120).toLowerCase();
    if (out.email && !EMAIL_RX.test(out.email)) throw httpError('Please enter a valid email address');
  }
  if (body.code !== undefined) {
    out.code = str(body.code, 30).toUpperCase().replace(/\s+/g, '-');
    if (out.code && !CODE_RX.test(out.code)) throw httpError('Vendor code may only use letters, numbers and "-"');
  }
  if (body.address !== undefined) {
    const a = typeof body.address === 'string' ? { street: body.address } : body.address || {};
    out.address = {
      street: str(a.street, 300),
      state: str(a.state, 80),
      country: str(a.country, 80),
      postalCode: str(a.postalCode, 20),
      ...(a.city !== undefined ? { city: str(a.city, 80) } : {}),
    };
  }
  if (body.bankDetails !== undefined) {
    const b = body.bankDetails || {};
    out.bankDetails = {
      bankName: str(b.bankName, 120),
      accountTitle: str(b.accountTitle, 120),
      accountNumber: str(b.accountNumber, 60),
      iban: str(b.iban, 40).toUpperCase(),
    };
  }
  if (body.categories !== undefined || body.category !== undefined) {
    const raw = body.categories !== undefined ? body.categories : body.category;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    out.categories = [...new Set(list.map((c) => str(c, 60)).filter(Boolean))].slice(0, 50);
  }
  if (body.paymentTermsDays !== undefined) {
    const n = Number(body.paymentTermsDays || 0);
    if (!Number.isFinite(n) || n < 0 || n > 365 || Math.floor(n) !== n) throw httpError('Payment terms must be 0 to 365 days');
    out.paymentTermsDays = n;
  }
  if (body.isConsignment !== undefined) out.isConsignment = bool(body.isConsignment);
  if (body.isActive !== undefined) out.isActive = bool(body.isActive);
  return out;
}

async function assertUnique(fields, exceptId = null) {
  const not = exceptId ? { _id: { $ne: exceptId } } : {};
  if (fields.code) {
    const dup = await Vendor.findOne({ code: fields.code, isDeleted: false, ...not }).select('name').lean();
    if (dup) throw httpError(`Code ${fields.code} is already used by ${dup.name}`, 409, 'DUPLICATE_CODE');
  }
  if (fields.email) {
    const dup = await Vendor.findOne({ email: fields.email, isDeleted: false, ...not }).select('name').lean();
    if (dup) throw httpError(`This email is already used by ${dup.name}`, 409, 'DUPLICATE_EMAIL');
  }
}

/** Next free automatic code: VEN-0001, VEN-0002... */
async function autoCode() {
  for (let i = 0; i < 20; i++) {
    const code = await nextNumber('VEN', { yearly: false, pad: 4 });
    if (!(await Vendor.exists({ code, isDeleted: false }))) return code;
  }
  throw httpError('Could not make a vendor code, please type one', 409);
}

// ---------- opening balance ----------

/**
 * Make the live opening balance row match `amount`
 * (> 0: we owe the vendor (credit), < 0: the vendor owes us (debit), 0: none).
 */
async function setOpeningBalance(vendor, amount, { date, userId } = {}) {
  const value = round2(Number(amount) || 0);
  if (!Number.isFinite(value) || Math.abs(value) > 1e10) throw httpError('Invalid opening balance');
  const current = await VendorLedgerEntry.findOne({ vendor: vendor._id, type: 'opening_balance', isVoided: false }).lean();
  const currentValue = current ? round2(current.credit - current.debit) : 0;
  if (current && currentValue === value && !date) return current;
  if (!current && value === 0) return null;
  if (current) await ledger.voidEntry(current._id, { userId, reason: 'Opening balance changed' });
  if (value === 0) return null;
  return ledger.post({
    vendorId: vendor._id,
    type: 'opening_balance',
    credit: value > 0 ? value : 0,
    debit: value < 0 ? -value : 0,
    date: date ? docDate(date) : current ? current.date : vendor.createdAt || new Date(),
    refType: 'Vendor',
    refId: vendor._id,
    refNo: vendor.code || '',
    description: value > 0 ? 'Opening balance (we owe the vendor)' : 'Opening balance (vendor owes us)',
    userId,
  });
}

// ---------- CRUD ----------

const LIST_SORTS = {
  name: { name: 1 },
  '-name': { name: -1 },
  code: { code: 1 },
  newest: { createdAt: -1 },
  '-createdAt': { createdAt: -1 },
  createdAt: { createdAt: 1 },
};

/** Ledger balance per vendor id (string) for every vendor that has rows. */
async function allBalances() {
  const rows = await VendorLedgerEntry.aggregate([
    { $match: { isVoided: false } },
    { $group: { _id: '$vendor', credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
  ]);
  return rows.map((r) => ({ vendor: r._id, balance: round2(r.credit - r.debit) }));
}

/**
 * GET /api/vendors — contract (docs §6):
 * data: [{ _id, name, phone, contactPerson, city, isConsignment, isActive, balance, ... }]
 * Filters: search, isActive, isConsignment, hasBalance (true | payable | receivable), category.
 * meta.summary: totals over ALL live vendors (cards on the vendors page).
 */
async function list(query = {}) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 25, maxLimit: 500 });
  const filter = { isDeleted: { $ne: true } };
  const rx = searchRx(query.search);
  if (rx) filter.$or = [{ name: rx }, { code: rx }, { phone: rx }, { whatsapp: rx }, { contactPerson: rx }, { city: rx }, { cnic: rx }];
  if (query.isActive === 'true' || query.isActive === true) filter.isActive = true;
  if (query.isActive === 'false' || query.isActive === false) filter.isActive = false;
  if (query.isConsignment === 'true') filter.isConsignment = true;
  if (query.isConsignment === 'false') filter.isConsignment = { $ne: true };
  if (query.category) filter.categories = str(query.category, 60);

  const balances = await allBalances();
  const hb = String(query.hasBalance || '');
  if (['true', 'payable', 'receivable'].includes(hb)) {
    const ids = balances
      .filter((b) => (hb === 'payable' ? b.balance > 0 : hb === 'receivable' ? b.balance < 0 : b.balance !== 0))
      .map((b) => b.vendor);
    filter._id = { $in: ids };
  }

  const sort = LIST_SORTS[query.sort] || LIST_SORTS.name;
  const [items, total, liveIds] = await Promise.all([
    Vendor.find(filter).sort({ ...sort, _id: 1 }).collation({ locale: 'en', strength: 2 }).skip(skip).limit(limit).lean(),
    Vendor.countDocuments(filter),
    Vendor.find({ isDeleted: { $ne: true } }).select('_id isActive isConsignment').lean(),
  ]);

  const balanceMap = await ledger.getBalances(items.map((v) => v._id));
  const data = items.map((v) => {
    const b = balanceMap.get(String(v._id)) || { credit: 0, debit: 0, balance: 0 };
    return { ...v, city: v.city || (v.address && v.address.city) || '', balance: b.balance, totalCredit: b.credit, totalDebit: b.debit };
  });

  const live = new Set(liveIds.map((v) => String(v._id)));
  const summary = { vendorCount: liveIds.length, activeCount: 0, consignmentCount: 0, totalPayable: 0, totalReceivable: 0, payableCount: 0, receivableCount: 0 };
  for (const v of liveIds) {
    if (v.isActive !== false) summary.activeCount += 1;
    if (v.isConsignment) summary.consignmentCount += 1;
  }
  for (const b of balances) {
    if (!live.has(String(b.vendor))) continue;
    if (b.balance > 0) {
      summary.totalPayable = round2(summary.totalPayable + b.balance);
      summary.payableCount += 1;
    } else if (b.balance < 0) {
      summary.totalReceivable = round2(summary.totalReceivable - b.balance);
      summary.receivableCount += 1;
    }
  }
  return { data, meta: pageMeta(page, limit, total, { summary }) };
}

/** Totals of the vendor account by kind (all time). */
async function accountTotals(vendorId) {
  const rows = await VendorLedgerEntry.aggregate([
    { $match: { vendor: oid(vendorId), isVoided: false } },
    { $group: { _id: '$type', credit: { $sum: '$credit' }, debit: { $sum: '$debit' }, count: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, { credit: round2(r.credit), debit: round2(r.debit), count: r.count }]));
  const c = (t) => (by[t] ? by[t].credit : 0);
  const d = (t) => (by[t] ? by[t].debit : 0);
  return {
    opening: round2(c('opening_balance') - d('opening_balance')),
    billed: round2(c('bill') + c('credit_note')),
    consignment: round2(c('consignment_settlement')),
    paid: round2(d('payment')),
    returned: round2(d('debit_note')),
    discount: round2(d('discount')),
    refunds: round2(c('refund_received')),
    adjustments: round2(c('adjustment') - d('adjustment')),
    byType: by,
  };
}

/** GET /api/vendors/:id — vendor + balance + totals (billed, paid, returned...). */
async function getById(vendorId) {
  const vendor = await loadVendor(vendorId);
  const [bal, totals] = await Promise.all([ledger.getBalance(vendor._id), accountTotals(vendor._id)]);
  const lastPayment = await VendorLedgerEntry.findOne({ vendor: vendor._id, type: 'payment', isVoided: false }).sort({ date: -1 }).select('date debit method').lean();
  return {
    ...vendor,
    city: vendor.city || (vendor.address && vendor.address.city) || '',
    balance: bal.balance,
    totalCredit: bal.credit,
    totalDebit: bal.debit,
    totals,
    lastPayment: lastPayment ? { date: lastPayment.date, amount: lastPayment.debit, method: lastPayment.method } : null,
  };
}

/** POST /api/vendors. `openingBalance` (> 0 we owe them, < 0 they owe us) -> ledger row. */
async function create(body = {}, { userId } = {}) {
  const fields = cleanInput(body);
  if (!fields.name) throw httpError('Vendor name is required');
  await assertUnique(fields);
  if (!fields.code) fields.code = await autoCode();
  const opening = body.openingBalance !== undefined && body.openingBalance !== '' ? Number(body.openingBalance) : 0;
  if (!Number.isFinite(opening)) throw httpError('Opening balance must be a number');

  let vendor;
  try {
    vendor = await Vendor.create({ ...fields, createdBy: oid(userId), updatedBy: oid(userId) });
  } catch (e) {
    if (e && e.code === 11000) throw httpError('This vendor code is already used', 409, 'DUPLICATE_CODE');
    throw e;
  }
  if (opening) await setOpeningBalance(vendor, opening, { date: body.openingBalanceDate, userId });
  return getById(vendor._id);
}

/** PUT /api/vendors/:id (only the fields sent). `openingBalance` re-posts the opening row. */
async function update(vendorId, body = {}, { userId } = {}) {
  const vendor = await loadVendor(vendorId, { lean: false });
  const fields = cleanInput(body);
  if (fields.name !== undefined && !fields.name) throw httpError('Vendor name cannot be empty');
  if (fields.code === '') delete fields.code; // keep the old code
  await assertUnique(fields, vendor._id);

  const oldName = vendor.name;
  // address.city and city are one value (see models/vendor.js).
  const curAddress = vendor.address && vendor.address.toObject ? vendor.address.toObject() : { ...(vendor.address || {}) };
  if (fields.address) {
    if (fields.city === undefined && fields.address.city !== undefined) fields.city = fields.address.city;
    fields.address = { ...curAddress, ...fields.address };
  }
  if (fields.city !== undefined) fields.address = { ...(fields.address || curAddress), city: fields.city };
  if (fields.categories !== undefined) vendor.category = '';
  vendor.set({ ...fields, updatedBy: oid(userId) });
  try {
    await vendor.save();
  } catch (e) {
    if (e && e.code === 11000) throw httpError('This vendor code is already used', 409, 'DUPLICATE_CODE');
    throw e;
  }

  if (body.openingBalance !== undefined && body.openingBalance !== '') {
    await setOpeningBalance(vendor, body.openingBalance, { date: body.openingBalanceDate, userId });
  }
  // Older purchase screens keep a copy of the vendor name.
  if (fields.name && fields.name !== oldName) {
    try {
      const Purchase = require('../../models/purchase');
      await Purchase.updateMany({ vendorId: vendor._id, isDeleted: false }, { $set: { vendorName: vendor.name } });
    } catch (e) {
      console.warn('[vendors] could not refresh purchase vendor names:', e.message);
    }
  }
  return getById(vendor._id);
}

/** PATCH /api/vendors/:id/status — { isActive } or toggle. */
async function setActive(vendorId, isActive, { userId } = {}) {
  const vendor = await loadVendor(vendorId, { lean: false });
  vendor.isActive = isActive === undefined || isActive === null || isActive === '' ? !vendor.isActive : bool(isActive);
  vendor.updatedBy = oid(userId);
  await vendor.save();
  return getById(vendor._id);
}

/** DELETE /api/vendors/:id — soft delete; 409 while the account is not settled. */
async function remove(vendorId, { userId } = {}) {
  const vendor = await loadVendor(vendorId, { lean: false });
  const { balance } = await ledger.getBalance(vendor._id);
  if (balance !== 0) {
    throw httpError(
      `${vendor.name} still has a balance of Rs ${Math.abs(balance).toLocaleString('en-PK')} (${balance > 0 ? 'we owe them' : 'they owe us'}). Settle it first.`,
      409,
      'VENDOR_HAS_BALANCE',
      { balance }
    );
  }
  const ConsignmentStock = require('../../models/consignmentStock');
  const open = await ConsignmentStock.find({ vendor: vendor._id, isOpen: true }).select('qtyIn qtyReturned qtySettled').lean();
  if (open.some((p) => p.qtyIn - p.qtyReturned - p.qtySettled > 0)) {
    throw httpError(`${vendor.name} still has consignment stock in the shop. Return or settle it first.`, 409, 'VENDOR_HAS_CONSIGNMENT');
  }
  vendor.isDeleted = true;
  vendor.isActive = false;
  vendor.deletedAt = new Date();
  vendor.deletedBy = oid(userId);
  await vendor.save();
  return { _id: vendor._id, deleted: true };
}

// ---------- statement ----------

/**
 * GET /api/vendors/:id/ledger?from&to — every "len den" row of the vendor.
 * opening = balance before `from`; rows (voided ones too, greyed, not counted)
 * with a running balance; closing = opening + credits - debits in the range.
 */
async function statement(vendorId, { from, to, limit = 5000 } = {}) {
  const vendor = await loadVendor(vendorId);
  const start = dayStart(from);
  const end = dayEnd(to);
  if (start && end && start > end) throw httpError('"From" date is after "To" date');

  let opening = 0;
  if (start) {
    const [row] = await VendorLedgerEntry.aggregate([
      { $match: { vendor: vendor._id, isVoided: false, date: { $lt: start } } },
      { $group: { _id: null, credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
    ]);
    opening = row ? round2(row.credit - row.debit) : 0;
  }

  const match = { vendor: vendor._id };
  if (start || end) match.date = { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) };
  const max = Math.min(10000, Math.max(1, Number(limit) || 5000));
  const entries = await VendorLedgerEntry.find(match).sort({ date: 1, _id: 1 }).limit(max + 1).lean();
  const truncated = entries.length > max;
  if (truncated) entries.pop();

  const [users, branches] = await Promise.all([
    userNames(entries.flatMap((e) => [e.createdBy, e.voidedBy])),
    branchNames(entries.map((e) => e.branch)),
  ]);

  let running = opening;
  const totals = { credit: 0, debit: 0, byType: {} };
  const rows = entries.map((e) => {
    if (!e.isVoided) {
      running = round2(running + e.credit - e.debit);
      totals.credit = round2(totals.credit + e.credit);
      totals.debit = round2(totals.debit + e.debit);
      const t = (totals.byType[e.type] = totals.byType[e.type] || { credit: 0, debit: 0, count: 0 });
      t.credit = round2(t.credit + e.credit);
      t.debit = round2(t.debit + e.debit);
      t.count += 1;
    }
    const b = e.branch ? branches.get(String(e.branch)) : null;
    return {
      _id: e._id,
      date: e.date,
      type: e.type,
      typeLabel: TYPE_LABELS[e.type] || e.type,
      description: e.description,
      refType: e.refType,
      refId: e.refId,
      refNo: e.refNo,
      method: e.method,
      reference: e.reference,
      attachments: e.attachments || [],
      credit: e.credit,
      debit: e.debit,
      balance: running,
      isVoided: !!e.isVoided,
      voidReason: e.voidReason || '',
      voidedAt: e.voidedAt,
      voidedByName: e.voidedBy ? users.get(String(e.voidedBy)) || '' : '',
      branch: e.branch,
      branchName: b ? b.name : '',
      createdByName: e.createdBy ? users.get(String(e.createdBy)) || '' : '',
      createdAt: e.createdAt,
    };
  });

  return {
    vendor: { _id: vendor._id, name: vendor.name, code: vendor.code, phone: vendor.phone, city: vendor.city || '' },
    from: start,
    to: end,
    opening,
    rows,
    totals,
    closing: running,
    truncated,
  };
}

/** CSV of the statement (opening and closing lines included). */
async function statementCsv(vendorId, query = {}) {
  const s = await statement(vendorId, query);
  const fmtDate = (d) => (d ? new Date(new Date(d).getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10) : '');
  const lines = [
    { date: s.from ? fmtDate(s.from) : '', typeLabel: 'Opening balance', balance: s.opening },
    ...s.rows,
    { date: s.to ? fmtDate(s.to) : '', typeLabel: 'Closing balance', credit: s.totals.credit, debit: s.totals.debit, balance: s.closing },
  ];
  const csv = toCsv(lines, [
    { label: 'Date', value: (r) => (r._id ? fmtDate(r.date) : r.date) },
    { label: 'Type', key: 'typeLabel' },
    { label: 'Document', key: 'refNo' },
    { label: 'Description', key: 'description' },
    { label: 'Method', key: 'method' },
    { label: 'Reference', key: 'reference' },
    { label: 'Branch', key: 'branchName' },
    { label: 'Credit (we owe more)', value: (r) => (r.credit ? r.credit : '') },
    { label: 'Debit (we owe less)', value: (r) => (r.debit ? r.debit : '') },
    { label: 'Balance', value: (r) => (r.isVoided ? '' : r.balance) },
    { label: 'Voided', value: (r) => (r.isVoided ? `VOID: ${r.voidReason || ''}` : '') },
  ]);
  const safe = String(s.vendor.code || s.vendor.name || 'vendor').replace(/[^A-Za-z0-9-]+/g, '_');
  return { csv, filename: `ledger-${safe}${query.from ? `-${query.from}` : ''}${query.to ? `-to-${query.to}` : ''}.csv` };
}

// ---------- products bought ----------

const IN_TYPES = ['purchase_receipt', 'consignment_in'];
const BACK_TYPES = ['vendor_return', 'consignment_return'];

/**
 * GET /api/vendors/:id/products — what we got from this vendor (stock ledger):
 * per unit qty received / returned, first / last / min / max price, last date.
 * Price = vendor price before charges (purchasePrice), landed cost = unitCost.
 */
async function productsBought(vendorId, req, query = {}) {
  const vendor = await loadVendor(vendorId);
  const match = { vendor: vendor._id, type: { $in: [...IN_TYPES, ...BACK_TYPES] }, ...scope(req) };
  const rows = await StockMovement.aggregate([
    { $match: match },
    { $sort: { occurredAt: 1, _id: 1 } },
    {
      $group: {
        _id: { product: '$product', variantId: '$variantId' },
        productName: { $last: '$productName' },
        code: { $last: '$code' },
        category: { $last: '$category' },
        qtyReturned: { $sum: { $cond: [{ $in: ['$type', BACK_TYPES] }, '$quantity', 0] } },
        receipts: {
          $push: {
            $cond: [
              { $in: ['$type', IN_TYPES] },
              { at: '$occurredAt', qty: '$quantity', price: { $ifNull: ['$purchasePrice', '$unitCost'] }, cost: '$unitCost', type: '$type', refNo: '$refNo' },
              '$$REMOVE',
            ],
          },
        },
      },
    },
  ]);

  const products = await Product.find({ _id: { $in: rows.map((r) => r._id.product) } })
    .setOptions({ withDeleted: true })
    .select('name price costPrice stock productType variants.variantId variants.price variants.costPrice variants.stock isConsignment isDeleted thumbnailUrl')
    .lean();
  const pmap = new Map(products.map((p) => [String(p._id), p]));

  const rx = searchRx(query.search);
  let data = rows
    .map((r) => ({ ...r, receipts: (r.receipts || []).filter(Boolean) }))
    .filter((r) => r.receipts.length)
    .map((r) => {
      const rec = r.receipts;
      const prices = rec.map((x) => Number(x.price)).filter((n) => Number.isFinite(n));
      const first = rec[0];
      const last = rec[rec.length - 1];
      const p = pmap.get(String(r._id.product));
      const v = p && p.productType === 'variant' ? (p.variants || []).find((x) => String(x.variantId) === String(r._id.variantId)) : null;
      const unit = v || p;
      const qtyIn = rec.reduce((s, x) => s + (x.qty || 0), 0);
      return {
        product: r._id.product,
        variantId: r._id.variantId,
        productName: (p && p.name) || r.productName,
        code: r.code,
        category: r.category,
        isDeleted: !!(p && p.isDeleted),
        isConsignment: !!(p && p.isConsignment),
        salePrice: unit ? unit.price : null,
        currentCost: unit ? unit.costPrice : null,
        currentStock: unit ? unit.stock : null,
        thumbnailUrl: p ? p.thumbnailUrl : undefined,
        qtyIn,
        qtyReturned: r.qtyReturned,
        receiptCount: rec.length,
        totalValue: round2(rec.reduce((s, x) => s + (x.qty || 0) * (Number(x.price) || 0), 0)),
        firstPrice: first ? first.price : null,
        firstDate: first ? first.at : null,
        lastPrice: last ? last.price : null,
        lastLandedCost: last ? last.cost : null,
        lastDate: last ? last.at : null,
        lastQty: last ? last.qty : null,
        lastRefNo: last ? last.refNo : '',
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        history: rec.slice(-20).reverse(),
      };
    });
  if (rx) data = data.filter((d) => rx.test(d.productName) || rx.test(d.code || ''));
  data.sort((a, b) => new Date(b.lastDate) - new Date(a.lastDate));

  const { page, limit, skip } = pageParams(query, { defaultLimit: 50, maxLimit: 500 });
  const summary = {
    products: data.length,
    pieces: data.reduce((s, d) => s + d.qtyIn, 0),
    value: round2(data.reduce((s, d) => s + d.totalValue, 0)),
  };
  return { data: data.slice(skip, skip + limit), meta: pageMeta(page, limit, data.length, { summary }) };
}

// ---------- manual adjustments ----------

/** POST /api/vendors/:id/adjustments { direction: credit|debit, amount, reason, date } */
async function postAdjustment(vendorId, body = {}, { userId, branchId = null } = {}) {
  const vendor = await loadVendor(vendorId);
  const direction = String(body.direction || '');
  if (!['credit', 'debit'].includes(direction)) {
    throw httpError('Choose "credit" (we owe the vendor more) or "debit" (we owe the vendor less)');
  }
  const amount = money(body.amount, 'Amount', { positive: true });
  const reason = str(body.reason, 500);
  if (reason.length < 3) throw httpError('Please write the reason for this adjustment');
  return ledger.post({
    vendorId: vendor._id,
    type: 'adjustment',
    credit: direction === 'credit' ? amount : 0,
    debit: direction === 'debit' ? amount : 0,
    date: docDate(body.date),
    branchId,
    refType: 'VendorAdjustment',
    description: reason,
    reference: str(body.reference, 100),
    userId,
  });
}

/**
 * POST /api/vendors/:id/ledger/:entryId/void — only manual rows (adjustment,
 * opening balance). Other rows are voided through their document (payment...).
 */
async function voidManualEntry(vendorId, entryId, body = {}, { userId } = {}) {
  const vendor = await loadVendor(vendorId);
  const entry = await VendorLedgerEntry.findOne({ _id: requireId(entryId, 'entry'), vendor: vendor._id }).lean();
  if (!entry) throw httpError('Ledger row not found', 404);
  if (entry.isVoided) throw httpError('This row is already voided', 409, 'ALREADY_VOIDED');
  if (!['adjustment', 'opening_balance'].includes(entry.type)) {
    throw httpError('Only adjustments and opening balances are voided here. Void the payment / return / settlement itself.', 400, 'NOT_MANUAL');
  }
  const reason = str(body.reason, 500);
  if (reason.length < 3) throw httpError('Please write why this row is wrong');
  return ledger.voidEntry(entry._id, { userId, reason });
}

module.exports = {
  TYPE_LABELS,
  loadVendor,
  cleanInput,
  list,
  getById,
  accountTotals,
  create,
  update,
  setActive,
  remove,
  setOpeningBalance,
  statement,
  statementCsv,
  productsBought,
  postAdjustment,
  voidManualEntry,
};
