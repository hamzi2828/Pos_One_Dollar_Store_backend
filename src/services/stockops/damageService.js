// src/services/stockops/damageService.js
// Damaged / expired / missing stock: report (scan) -> approve (stock out) or reject.
//
//   report  : snapshot of the unit (avg landed cost, last vendor, codes), no stock change
//   approve : stockService.deductStock(... movement type 'damage') — retry safe:
//             a claim (processingAt) stops two approvals at once, `stockDeducted`
//             and the ledger row (refType DamageRecord) stop a second deduction.
//   daily   : one PKT day with totals + a Code 128 barcode per row (printable list).
// Config: damages.autoApprove (default false) approves every new report at once.
const DamageRecord = require('../../models/damageRecord');
const StockMovement = require('../../models/stockMovement');
const stockService = require('../stockService');
const config = require('../configService');
const notificationService = require('../notificationService');
const { nextNumber } = require('../sequenceService');
const locationService = require('../inventory/locationService');
const code128 = require('../../helper/code128');
const { lookupCode } = require('./productLookup');
const {
  round2,
  round4,
  httpError,
  toObjectId,
  toInt,
  escapeRegex,
  pktDayRange,
  pktRangeFilter,
  pktDateTime,
  pageParams,
  pageMeta,
  toCsv,
  loadProductLean,
  pickUnit,
  unitSnapshot,
  unitAvailable,
  userName,
  historyEntry,
  STALE_LOCK_MS,
} = require('./common');

const AUTO_APPROVE_KEY = 'damages.autoApprove';
const REASON_LABELS = {
  broken: 'Broken',
  expired: 'Expired',
  defective: 'Defective',
  water_damage: 'Water damage',
  rodent: 'Rodent / pest',
  missing: 'Missing',
  other: 'Other',
};

const USER_FIELDS = 'firstName lastName email';
const populateUsers = (q) =>
  q.populate('reportedBy', USER_FIELDS).populate('approvedBy', USER_FIELDS).populate('rejectedBy', USER_FIELDS);

const toBool = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';

/** Plain record for the API (user names flattened). */
const view = (r) => {
  if (!r) return r;
  const o = typeof r.toObject === 'function' ? r.toObject() : { ...r };
  o.reportedByName = userName(o.reportedBy);
  o.approvedByName = userName(o.approvedBy);
  o.rejectedByName = userName(o.rejectedBy);
  delete o.processingAt;
  delete o.requestId;
  return o;
};

async function findScoped(id, scope = {}) {
  const _id = toObjectId(id);
  if (!_id) throw httpError('Invalid damage record id', 400);
  const rec = await DamageRecord.findOne({ _id, ...scope });
  if (!rec) throw httpError('Damage record not found', 404);
  return rec;
}

async function getSettings() {
  return { autoApprove: !!(await config.get(AUTO_APPROVE_KEY, false)) };
}

async function setSettings({ autoApprove }, userId) {
  await config.set(AUTO_APPROVE_KEY, !!toBool(autoApprove), userId);
  return getSettings();
}

/**
 * New damage report in `branchId`.
 * input: { code | (productId [, variantId]), qty, location, shelfId, reason, description,
 *          claimable, date, requestId }; photos = uploaded URLs.
 */
async function report(input = {}, { branchId, userId, photos = [] } = {}) {
  const requestId = input.requestId ? String(input.requestId).slice(0, 80) : null;
  if (requestId) {
    const existing = await DamageRecord.findOne({ requestId });
    if (existing) return existing;
  }

  // Which unit: scanned code first, else product id (+ variant).
  let productId = input.productId;
  let variantId = input.variantId || null;
  let scannedCode = '';
  let batchNo = '';
  if (input.code && !productId) {
    const hit = await lookupCode(input.code, branchId);
    if (hit.needsVariant && !variantId) throw httpError(`Choose a variant of ${hit.name}`, 400, 'VARIANT_REQUIRED');
    productId = hit.productId;
    variantId = variantId || hit.variantId;
    scannedCode = hit.scannedCode;
    batchNo = hit.batchNo || '';
  } else if (input.code) {
    scannedCode = String(input.code).trim().toUpperCase();
  }
  if (!productId) throw httpError('Scan the damaged item or choose a product', 400);

  const product = await loadProductLean(productId);
  if (product.isDeleted) throw httpError('This product was deleted', 400);
  const picked = pickUnit(product, variantId);
  const snap = unitSnapshot(product, picked);

  const qty = toInt(input.qty, 0);
  if (qty < 1) throw httpError('Quantity must be at least 1', 400);
  const available = await unitAvailable(picked.unit, branchId);
  if (qty > available) {
    const err = httpError(`Only ${available} piece(s) of ${snap.productName} are in stock`, 400, 'INSUFFICIENT_STOCK');
    err.available = available;
    throw err;
  }

  const reason = String(input.reason || '');
  if (!DamageRecord.REASONS.includes(reason)) throw httpError('Choose a reason', 400);
  const location = input.location === 'warehouse' ? 'warehouse' : 'shelf';
  let shelf = null;
  if (location === 'shelf' && input.shelfId) shelf = await locationService.loadShelf(input.shelfId, branchId);

  let date = new Date();
  if (input.date) {
    const d = new Date(input.date);
    if (Number.isNaN(d.getTime())) throw httpError('Invalid date', 400);
    if (d.getTime() > Date.now() + 60 * 1000) throw httpError('Date cannot be in the future', 400);
    date = d;
  }

  const unitCost = round4(snap.unitCost);
  let rec;
  try {
    rec = await DamageRecord.create({
      damageNo: await nextNumber('DMG'),
      branch: toObjectId(branchId),
      date,
      product: product._id,
      variantId: snap.variantId,
      productName: snap.productName,
      variantLabel: snap.variantLabel,
      category: snap.category,
      code: snap.code,
      scannedCode: scannedCode || snap.code,
      batchNo,
      qty,
      location,
      shelf: shelf ? shelf._id : null,
      shelfCode: shelf ? shelf.code : '',
      reason,
      description: String(input.description || '').trim().slice(0, 1000),
      photos: (photos || []).filter(Boolean).slice(0, 5),
      unitCost,
      totalLoss: round2(unitCost * qty),
      salePrice: round2(snap.salePrice),
      vendor: snap.vendor,
      vendorName: snap.vendorName,
      claimable: toBool(input.claimable),
      status: 'pending',
      reportedBy: toObjectId(userId),
      ...(requestId ? { requestId } : {}),
      history: [historyEntry('reported', userId, `${qty} pc(s), ${REASON_LABELS[reason]}`)],
    });
  } catch (e) {
    // Same requestId sent twice at the same moment: return the first one.
    if (e && e.code === 11000 && requestId) {
      const existing = await DamageRecord.findOne({ requestId }).setOptions({ withDeleted: true });
      if (existing) return existing;
    }
    throw e;
  }

  await notificationService.notify({
    type: 'damage_reported',
    title: `Damage reported: ${snap.productName}`,
    message: `${rec.damageNo}: ${qty} pc(s), ${REASON_LABELS[reason]}, loss Rs ${rec.totalLoss}`,
    level: 'warning',
    link: '/admin/inventory/damages',
    branchId,
    audience: 'damages',
  });

  if ((await getSettings()).autoApprove) {
    return approve(rec._id, { userId, note: 'Auto-approved' });
  }
  return rec;
}

/** Approve: take the pieces out of stock ('damage' movement). Safe to call twice. */
async function approve(id, { userId, scope = {}, note = '' } = {}) {
  const rec = await findScoped(id, scope);
  if (rec.status === 'approved') return rec;
  if (rec.status === 'rejected') throw httpError('This report was rejected and cannot be approved', 409);

  const now = new Date();
  const claimed = await DamageRecord.findOneAndUpdate(
    { _id: rec._id, status: 'pending', $or: [{ processingAt: null }, { processingAt: { $lt: new Date(now - STALE_LOCK_MS) } }] },
    { $set: { processingAt: now } },
    { new: true }
  );
  if (!claimed) {
    const fresh = await DamageRecord.findById(rec._id);
    if (fresh && fresh.status === 'approved') return fresh;
    throw httpError('This report is being approved right now. Please wait a moment.', 409, 'IN_PROGRESS');
  }

  try {
    if (!claimed.stockDeducted) {
      let movementId = null;
      // A crashed earlier attempt may already have taken the stock.
      const done = await StockMovement.findOne({ refType: 'DamageRecord', refId: claimed._id, type: 'damage' }).select('_id').lean();
      if (done) {
        movementId = done._id;
      } else {
        const out = await stockService.deductStock({
          productId: claimed.product,
          variantId: claimed.variantId,
          quantity: claimed.qty,
          batchNo: claimed.batchNo || undefined,
          branchId: claimed.branch,
          movement: {
            type: 'damage',
            refType: 'DamageRecord',
            refId: claimed._id,
            refNo: claimed.damageNo,
            userId,
            unitCost: claimed.unitCost,
            note: `${REASON_LABELS[claimed.reason] || claimed.reason}${claimed.description ? `: ${claimed.description}` : ''}`.slice(0, 300),
            fromShelfId: claimed.location === 'shelf' && claimed.shelf ? claimed.shelf : null,
            strategy: claimed.location === 'warehouse' ? 'warehouse_first' : 'shelf_first',
          },
        });
        movementId = out.movement && out.movement._id ? out.movement._id : null;
      }
      await DamageRecord.updateOne({ _id: claimed._id }, { $set: { stockDeducted: true, movement: movementId } });
    }
    return await DamageRecord.findOneAndUpdate(
      { _id: claimed._id },
      {
        $set: { status: 'approved', approvedBy: toObjectId(userId), approvedAt: new Date(), processingAt: null },
        $push: { history: historyEntry('approved', userId, note) },
      },
      { new: true }
    );
  } catch (err) {
    await DamageRecord.updateOne({ _id: claimed._id, processingAt: now }, { $set: { processingAt: null } });
    throw err;
  }
}

async function reject(id, { userId, scope = {}, reason = '' } = {}) {
  const rec = await findScoped(id, scope);
  if (rec.status === 'rejected') return rec;
  if (rec.status === 'approved') throw httpError('Already approved: the stock was taken off. Use a stock adjustment to correct it.', 409);
  const stale = new Date(Date.now() - STALE_LOCK_MS);
  const out = await DamageRecord.findOneAndUpdate(
    { _id: rec._id, status: 'pending', stockDeducted: { $ne: true }, $or: [{ processingAt: null }, { processingAt: { $lt: stale } }] },
    {
      $set: { status: 'rejected', rejectedBy: toObjectId(userId), rejectedAt: new Date(), rejectReason: String(reason || '').slice(0, 500) },
      $push: { history: historyEntry('rejected', userId, reason) },
    },
    { new: true }
  );
  if (!out) throw httpError('This report is being approved right now.', 409, 'IN_PROGRESS');
  return out;
}

/** Remove a pending / rejected report (soft delete). Approved ones stay (stock already moved). */
async function remove(id, { userId, scope = {} } = {}) {
  const rec = await findScoped(id, scope);
  if (rec.status === 'approved' || rec.stockDeducted) throw httpError('Approved reports cannot be deleted', 409);
  await DamageRecord.softDeleteById(rec._id, toObjectId(userId));
  return { deleted: true };
}

const listFilter = (query = {}, scope = {}) => {
  const f = { ...scope };
  if (query.status && DamageRecord.STATUSES.includes(query.status)) f.status = query.status;
  if (query.reason && DamageRecord.REASONS.includes(query.reason)) f.reason = query.reason;
  const pid = toObjectId(query.productId || query.product);
  if (pid) f.product = pid;
  const range = pktRangeFilter(query.from, query.to);
  if (range) f.date = range;
  const s = String(query.search || '').trim();
  if (s) {
    const rx = new RegExp(escapeRegex(s), 'i');
    f.$or = [{ productName: rx }, { code: rx }, { scannedCode: rx }, { damageNo: rx }, { description: rx }];
  }
  return f;
};

async function list(query = {}, scope = {}) {
  const { page, limit, skip } = pageParams(query);
  const filter = listFilter(query, scope);
  const [rows, total] = await Promise.all([
    populateUsers(DamageRecord.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit)).lean(),
    DamageRecord.countDocuments(filter),
  ]);
  return { data: rows.map(view), meta: pageMeta(page, limit, total) };
}

const barcodeSvg = (text) => {
  const clean = code128.sanitize(text).trim();
  if (!clean) return null;
  try {
    return code128.toSVG(clean.slice(0, 40), { height: 36, includeText: true, fontSize: 9, quietZone: 6 });
  } catch (_) {
    return null;
  }
};

/** One PKT day of reports with totals (rejected rows listed but not counted). */
async function daily(query = {}, scope = {}) {
  const { date, start, end } = pktDayRange(query.date);
  const filter = { ...scope, date: { $gte: start, $lt: end } };
  if (query.status && DamageRecord.STATUSES.includes(query.status)) filter.status = query.status;
  const rows = await populateUsers(DamageRecord.find(filter).sort({ date: 1, _id: 1 }).limit(2000)).lean();

  const totals = { reports: 0, pieces: 0, loss: 0, saleValue: 0, pending: 0, approved: 0, rejected: 0, claimableLoss: 0 };
  const byReason = {};
  for (const r of rows) {
    totals[r.status] = (totals[r.status] || 0) + 1;
    if (r.status === 'rejected') continue;
    totals.reports += 1;
    totals.pieces += r.qty;
    totals.loss += r.totalLoss || 0;
    totals.saleValue += (r.salePrice || 0) * r.qty;
    if (r.claimable) totals.claimableLoss += r.totalLoss || 0;
    const b = (byReason[r.reason] = byReason[r.reason] || { reason: r.reason, label: REASON_LABELS[r.reason], pieces: 0, loss: 0 });
    b.pieces += r.qty;
    b.loss += r.totalLoss || 0;
  }
  totals.loss = round2(totals.loss);
  totals.saleValue = round2(totals.saleValue);
  totals.claimableLoss = round2(totals.claimableLoss);
  Object.values(byReason).forEach((b) => (b.loss = round2(b.loss)));

  const withBarcodes = query.barcodes !== 'false' && query.barcodes !== '0';
  return {
    date,
    rows: rows.map((r) => ({ ...view(r), barcodeSvg: withBarcodes ? barcodeSvg(r.scannedCode || r.code) : undefined })),
    totals,
    byReason: Object.values(byReason).sort((a, b) => b.loss - a.loss),
  };
}

async function dailyCsv(query = {}, scope = {}) {
  const day = await daily({ ...query, barcodes: 'false' }, scope);
  const headers = [
    'Damage No', 'Date (PKT)', 'Product', 'Variant', 'Code / barcode', 'Qty', 'Location', 'Shelf', 'Reason', 'Description',
    'Unit cost', 'Loss at cost', 'Sale price', 'Vendor', 'Claimable', 'Status', 'Reported by', 'Approved by',
  ];
  const rows = day.rows.map((r) => [
    r.damageNo, pktDateTime(r.date), r.productName, r.variantLabel, r.scannedCode || r.code, r.qty, r.location, r.shelfCode,
    REASON_LABELS[r.reason] || r.reason, r.description, r.unitCost, r.totalLoss, r.salePrice, r.vendorName, r.claimable ? 'yes' : 'no',
    r.status, r.reportedByName, r.approvedByName,
  ]);
  rows.push([]);
  rows.push(['TOTAL (not rejected)', '', '', '', '', day.totals.pieces, '', '', '', '', '', day.totals.loss]);
  return { filename: `damages-${day.date}.csv`, csv: toCsv(headers, rows) };
}

async function getOne(id, scope = {}) {
  const rec = await findScoped(id, scope);
  const full = await populateUsers(DamageRecord.findById(rec._id)).lean();
  return { ...view(full), barcodeSvg: barcodeSvg(full.scannedCode || full.code) };
}

module.exports = {
  REASON_LABELS,
  getSettings,
  setSettings,
  report,
  approve,
  reject,
  remove,
  list,
  daily,
  dailyCsv,
  getOne,
  view,
};
