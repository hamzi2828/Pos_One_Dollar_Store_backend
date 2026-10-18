// src/services/stockops/movementLedgerService.js
// Read side of the stock ledger (models/stockMovement.js):
//   list / csv : filterable, paginated ledger
//   timeline   : one unit in one branch — chronological events (received ->
//                warehouse -> shelf -> sold) and per-receipt lot metrics (FIFO).
//
// Lot metrics (FIFO approximations, the ledger does not tag pieces):
//   * every IN row (opening, purchase receipt, receive, consignment in, transfer
//     in, adjustment in) is a lot; stock that existed before the first ledger
//     row becomes a "before records" lot.
//   * OUT rows consume lots oldest first; sale returns give pieces back to the
//     newest lot that sold.
//   * pieces leave the warehouse oldest lot first: by put-away (-> shelf, sets
//     "first put on a shelf"), by a receipt straight onto a shelf, or by an out
//     taken from the warehouse.
const mongoose = require('mongoose');
const StockMovement = require('../../models/stockMovement');
const User = require('../../models/user');
const Vendor = require('../../models/vendor');
const Branch = require('../../models/branch');
const locationService = require('../inventory/locationService');
const { variantLabel } = require('../../helper/productCodes');
const {
  round2,
  httpError,
  toObjectId,
  isHexId,
  escapeRegex,
  pktRangeFilter,
  pktDateString,
  pktDateTime,
  daysBetween,
  pageParams,
  pageMeta,
  toCsv,
  loadProductLean,
  pickUnit,
  userName,
} = require('./common');

const TYPE_LABELS = {
  opening: 'Opening stock',
  purchase_receipt: 'Purchase receipt',
  receive: 'Received',
  consignment_in: 'Consignment in',
  consignment_return: 'Consignment return',
  putaway: 'Put on shelf',
  location_move: 'Moved',
  sale: 'Sold',
  gift: 'Gift',
  sale_return: 'Sale return',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  damage: 'Damaged',
  internal_use: 'Shop use',
  vendor_return: 'Returned to vendor',
  adjustment_in: 'Adjustment +',
  adjustment_out: 'Adjustment −',
};

const LOT_TYPES = ['opening', 'purchase_receipt', 'receive', 'consignment_in', 'transfer_in', 'adjustment_in'];
const SOLD_TYPES = ['sale', 'gift'];
const MAX_TIMELINE_ROWS = 20000;
const MAX_EVENTS = 400;
const MAX_CSV_ROWS = 20000;

/** Ledger filter from query params (+ branch scope). */
function buildFilter(query = {}, scope = {}) {
  const f = { ...scope };
  const pid = toObjectId(query.productId || query.product);
  if (pid) f.product = pid;
  if (query.variantId) f.variantId = String(query.variantId);
  const types = String(query.types || query.type || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => StockMovement.TYPES.includes(t));
  if (types.length === 1) f.type = types[0];
  else if (types.length > 1) f.type = { $in: types };
  if (['in', 'out', 'move'].includes(query.direction)) f.direction = query.direction;
  const range = pktRangeFilter(query.from, query.to);
  if (range) f.occurredAt = range;
  const ref = String(query.ref || '').trim();
  if (ref) {
    if (isHexId(ref)) f.refId = new mongoose.Types.ObjectId(ref);
    else f.refNo = new RegExp(`^${escapeRegex(ref)}`, 'i');
  }
  if (query.refType) f.refType = String(query.refType);
  const user = toObjectId(query.user || query.userId);
  if (user) f.user = user;
  const vendor = toObjectId(query.vendor || query.vendorId);
  if (vendor) f.vendor = vendor;
  const s = String(query.search || '').trim();
  if (s) {
    const rx = new RegExp(escapeRegex(s), 'i');
    f.$or = [{ productName: rx }, { code: rx }, { refNo: rx }, { note: rx }];
  }
  return f;
}

/** Names for user / vendor / branch ids found in rows. */
async function nameMaps(rows) {
  const ids = (key) => [...new Set(rows.map((r) => r[key] && String(r[key])).filter(Boolean))];
  const [users, vendors, branches] = await Promise.all([
    ids('user').length ? User.find({ _id: { $in: ids('user') } }).setOptions({ withDeleted: true }).select('firstName lastName email').lean() : [],
    ids('vendor').length ? Vendor.find({ _id: { $in: ids('vendor') } }).select('name').lean() : [],
    ids('branch').length ? Branch.find({ _id: { $in: ids('branch') } }).select('name code').lean() : [],
  ]);
  return {
    user: new Map(users.map((u) => [String(u._id), userName(u)])),
    vendor: new Map(vendors.map((v) => [String(v._id), v.name])),
    branch: new Map(branches.map((b) => [String(b._id), b])),
  };
}

const placeText = (loc) => {
  if (!loc || !loc.kind || loc.kind === 'none') return '';
  if (loc.kind === 'shelf') return loc.code || 'Shelf';
  if (loc.kind === 'warehouse') return 'Warehouse';
  if (loc.kind === 'branch') return loc.code ? `Branch ${loc.code}` : 'Other branch';
  if (loc.kind === 'vendor') return 'Vendor';
  if (loc.kind === 'customer') return 'Customer';
  return loc.kind;
};

const rowView = (r, names) => {
  const b = names.branch.get(String(r.branch));
  return {
    _id: r._id,
    occurredAt: r.occurredAt,
    type: r.type,
    typeLabel: TYPE_LABELS[r.type] || r.type,
    direction: r.direction,
    quantity: r.quantity,
    qtyChange: r.qtyChange,
    balanceAfter: r.balanceAfter,
    productId: r.product,
    variantId: r.variantId,
    productName: r.productName,
    code: r.code,
    category: r.category,
    from: placeText(r.from),
    to: placeText(r.to),
    shelves: (r.shelves || []).map((s) => ({ code: s.code, qty: s.qty })),
    unitCost: r.unitCost,
    totalCost: r.totalCost,
    unitPrice: r.unitPrice,
    purchasePrice: r.purchasePrice,
    vendorId: r.vendor,
    vendorName: r.vendor ? names.vendor.get(String(r.vendor)) || '' : '',
    refType: r.refType,
    refId: r.refId,
    refNo: r.refNo,
    userId: r.user,
    userName: r.user ? names.user.get(String(r.user)) || '' : '',
    branchId: r.branch,
    branchName: b ? b.name : '',
    branchCode: b ? b.code : '',
    note: r.note,
  };
};

async function list(query = {}, scope = {}) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 50, maxLimit: 500 });
  const filter = buildFilter(query, scope);
  const [rows, total, sums] = await Promise.all([
    StockMovement.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    StockMovement.countDocuments(filter),
    // Totals for the whole filter: page 1 only (the screen keeps them while paging).
    page > 1
      ? null
      : StockMovement.aggregate([
          { $match: filter },
          { $group: { _id: '$direction', pieces: { $sum: '$quantity' }, value: { $sum: { $ifNull: ['$totalCost', 0] } } } },
        ]),
  ]);
  const names = await nameMaps(rows);
  const summary = { piecesIn: 0, piecesOut: 0, piecesMoved: 0, valueIn: 0, valueOut: 0 };
  for (const s of sums || []) {
    if (s._id === 'in') {
      summary.piecesIn = s.pieces;
      summary.valueIn = round2(s.value);
    } else if (s._id === 'out') {
      summary.piecesOut = s.pieces;
      summary.valueOut = round2(s.value);
    } else summary.piecesMoved = s.pieces;
  }
  return { data: rows.map((r) => rowView(r, names)), meta: { ...pageMeta(page, limit, total), ...(sums ? { summary } : {}) } };
}

async function csv(query = {}, scope = {}) {
  const filter = buildFilter(query, scope);
  const rows = await StockMovement.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(MAX_CSV_ROWS).lean();
  const names = await nameMaps(rows);
  const headers = [
    'Date (PKT)', 'Branch', 'Type', 'Product', 'Code', 'Qty change', 'Balance after', 'From', 'To', 'Shelves',
    'Unit cost', 'Total cost', 'Unit price', 'Vendor price', 'Vendor', 'Ref type', 'Ref no', 'User', 'Note',
  ];
  const data = rows.map((r) => {
    const v = rowView(r, names);
    return [
      pktDateTime(v.occurredAt), v.branchCode || v.branchName, v.typeLabel, v.productName, v.code, v.qtyChange, v.balanceAfter, v.from, v.to,
      v.shelves.map((s) => `${s.code}:${s.qty}`).join(' '), v.unitCost, v.totalCost, v.unitPrice, v.purchasePrice, v.vendorName,
      v.refType, v.refNo, v.userName, v.note,
    ];
  });
  return { filename: `stock-movements-${pktDateString()}.csv`, csv: toCsv(headers, data) };
}

// ---------------- timeline ----------------

const newLot = (row, names) => ({
  lotId: row ? String(row._id) : 'before-records',
  type: row ? row.type : 'opening',
  typeLabel: row ? TYPE_LABELS[row.type] : 'Stock before records',
  synthetic: !row,
  receivedAt: row ? row.occurredAt : null,
  qty: row ? row.quantity : 0,
  vendorId: row && row.vendor ? String(row.vendor) : null,
  vendorName: row && row.vendor ? names.vendor.get(String(row.vendor)) || '' : '',
  unitCost: row ? row.unitCost : null,
  purchasePrice: row ? row.purchasePrice : null,
  refNo: row ? row.refNo : '',
  consumed: 0,
  sold: 0,
  otherOut: 0,
  leftWarehouse: 0,
  firstShelvedAt: null,
  at50: null,
  at100: null,
});

/** Oldest-first allocation of `qty` over lots using `room(lot)` / `take(lot, n)`. */
const allocateFifo = (lots, qty, room, take) => {
  let left = qty;
  for (const lot of lots) {
    if (left <= 0) break;
    const n = Math.min(left, Math.max(0, room(lot)));
    if (n > 0) {
      take(lot, n);
      left -= n;
    }
  }
  return left;
};

function computeLots(rows, { names, startAt }) {
  const lots = [];
  // Pieces that existed before the first ledger row.
  if (rows.length) {
    const first = rows[0];
    const before = first.balanceAfter !== null && first.balanceAfter !== undefined ? first.balanceAfter - first.qtyChange : 0;
    if (before > 0) {
      const lot = newLot(null, names);
      lot.qty = before;
      lot.receivedAt = startAt && new Date(startAt) < new Date(first.occurredAt) ? startAt : first.occurredAt;
      lots.push(lot);
    }
  }

  const markThresholds = (lot, at) => {
    if (!lot.at50 && lot.consumed >= lot.qty * 0.5) lot.at50 = at;
    if (!lot.at100 && lot.consumed >= lot.qty) lot.at100 = at;
  };
  const leaveWarehouse = (qty, at, shelved) =>
    allocateFifo(
      lots,
      qty,
      (l) => l.qty - l.leftWarehouse,
      (l, n) => {
        l.leftWarehouse += n;
        if (shelved && !l.firstShelvedAt) l.firstShelvedAt = at;
      }
    );

  for (const r of rows) {
    if (LOT_TYPES.includes(r.type)) {
      const lot = newLot(r, names);
      lots.push(lot);
      if (r.to && r.to.kind === 'shelf') {
        lot.leftWarehouse = lot.qty;
        lot.firstShelvedAt = r.occurredAt;
      }
      continue;
    }
    if (r.type === 'sale_return') {
      // Give the pieces back to the newest lot that sold.
      let left = r.quantity;
      for (let i = lots.length - 1; i >= 0 && left > 0; i--) {
        const l = lots[i];
        const n = Math.min(left, l.sold);
        if (n <= 0) continue;
        l.sold -= n;
        l.consumed -= n;
        left -= n;
        if (l.consumed < l.qty) l.at100 = null;
        if (l.consumed < l.qty * 0.5) l.at50 = null;
      }
      continue;
    }
    if (r.type === 'putaway') {
      leaveWarehouse(r.quantity, r.occurredAt, true);
      continue;
    }
    if (r.type === 'location_move') {
      if (r.to && r.to.kind === 'warehouse') {
        // Back to the warehouse: undo the newest shelving.
        let left = r.quantity;
        for (let i = lots.length - 1; i >= 0 && left > 0; i--) {
          const n = Math.min(left, lots[i].leftWarehouse);
          lots[i].leftWarehouse -= n;
          left -= n;
        }
      }
      continue;
    }
    if (r.direction === 'out') {
      const sold = SOLD_TYPES.includes(r.type);
      allocateFifo(
        lots,
        r.quantity,
        (l) => l.qty - l.consumed,
        (l, n) => {
          l.consumed += n;
          if (sold) l.sold += n;
          else l.otherOut += n;
          markThresholds(l, r.occurredAt);
        }
      );
      const fromShelves = (r.shelves || []).reduce((s, x) => s + (Number(x.qty) || 0), 0);
      const fromWarehouse = Math.max(0, r.quantity - fromShelves);
      if (fromWarehouse > 0) leaveWarehouse(fromWarehouse, r.occurredAt, false);
    }
  }

  const now = new Date();
  return lots.map((l) => {
    const onHand = Math.max(0, l.qty - l.consumed);
    const inWarehouse = Math.min(onHand, Math.max(0, l.qty - l.leftWarehouse));
    return {
      lotId: l.lotId,
      type: l.type,
      typeLabel: l.typeLabel,
      synthetic: l.synthetic,
      receivedAt: l.receivedAt,
      qty: l.qty,
      vendorId: l.vendorId,
      vendorName: l.vendorName,
      unitCost: l.unitCost,
      purchasePrice: l.purchasePrice,
      refNo: l.refNo,
      firstShelvedAt: l.firstShelvedAt,
      // Days from arrival to the first shelf; still waiting -> days so far.
      daysInWarehouse: l.firstShelvedAt
        ? daysBetween(l.receivedAt, l.firstShelvedAt)
        : inWarehouse > 0
        ? daysBetween(l.receivedAt, now)
        : null,
      waitingInWarehouse: !l.firstShelvedAt && inWarehouse > 0,
      inWarehouse,
      sold: l.sold,
      otherOut: l.otherOut,
      onHand,
      halfGoneAt: l.at50,
      soldOutAt: l.at100,
      daysTo50: l.at50 ? daysBetween(l.receivedAt, l.at50) : null,
      daysTo100: l.at100 ? daysBetween(l.receivedAt, l.at100) : null,
      status: onHand === 0 ? 'sold_out' : l.consumed > 0 ? 'selling' : 'not_started',
    };
  });
}

/** Rows -> display events; sales/gifts of the same PKT day are merged into one. */
function buildEvents(rows, names) {
  const events = [];
  for (const r of rows) {
    const v = rowView(r, names);
    const last = events[events.length - 1];
    const day = pktDateString(r.occurredAt);
    if (last && SOLD_TYPES.includes(r.type) && last.type === r.type && last.day === day) {
      last.quantity += r.quantity;
      last.count += 1;
      last.lastAt = r.occurredAt;
      last.balanceAfter = r.balanceAfter;
      if (v.from && !last.fromSet.has(v.from)) last.fromSet.add(v.from);
      continue;
    }
    events.push({ ...v, day, count: 1, lastAt: r.occurredAt, fromSet: new Set(v.from ? [v.from] : []) });
  }
  return events.map(({ fromSet, ...e }) => ({ ...e, from: [...fromSet].join(', ') || e.from }));
}

/**
 * Timeline of one unit in one branch.
 * Returns { product, branch, split, events, lots, summary, truncated }.
 */
async function timeline(productId, { variantId = null, branchId } = {}) {
  const product = await loadProductLean(productId);
  const picked = pickUnit(product, variantId, { required: false });
  if (!picked) {
    throw httpError(`Choose a variant of ${product.name}`, 400, 'VARIANT_REQUIRED');
  }
  const branch = toObjectId(branchId);
  const rows = await StockMovement.find({ product: product._id, variantId: picked.variantId, branch })
    .sort({ occurredAt: 1, _id: 1 })
    .limit(MAX_TIMELINE_ROWS)
    .lean();
  const names = await nameMaps(rows);
  const [split, branchDoc] = await Promise.all([
    locationService.unitSplit({ branchId: branch, productId: product._id, variantId: picked.variantId, product }),
    Branch.findById(branch).select('name code').lean(),
  ]);
  const lots = computeLots(rows, { names, startAt: product.createdAt });
  const events = buildEvents(rows, names);

  const real = lots.filter((l) => !l.synthetic);
  const avg = (list) => (list.length ? Math.round((list.reduce((s, x) => s + x, 0) / list.length) * 10) / 10 : null);
  const lastOf = (types) => {
    for (let i = rows.length - 1; i >= 0; i--) if (types.includes(rows[i].type)) return rows[i].occurredAt;
    return null;
  };
  const summary = {
    received: real.reduce((s, l) => s + l.qty, 0),
    sold: lots.reduce((s, l) => s + l.sold, 0),
    otherOut: lots.reduce((s, l) => s + l.otherOut, 0),
    onHand: split.total,
    warehouse: split.warehouse,
    shelved: split.shelved,
    lots: real.length,
    firstReceivedAt: real.length ? real[0].receivedAt : null,
    lastReceivedAt: real.length ? real[real.length - 1].receivedAt : null,
    lastShelvedAt: lastOf(['putaway']),
    lastSoldAt: lastOf(SOLD_TYPES),
    avgDaysInWarehouse: avg(lots.filter((l) => l.firstShelvedAt).map((l) => l.daysInWarehouse)),
    avgDaysTo50: avg(lots.filter((l) => l.daysTo50 !== null).map((l) => l.daysTo50)),
    avgDaysTo100: avg(lots.filter((l) => l.daysTo100 !== null).map((l) => l.daysTo100)),
  };

  return {
    product: {
      id: String(product._id),
      name: product.name,
      variantId: picked.variantId,
      variantLabel: picked.variant ? variantLabel(picked.variant) : '',
      code: picked.unit.shortCode || picked.unit.sku || '',
      category: product.category,
      thumbnailUrl: product.thumbnailUrl || null,
      variants:
        product.productType === 'variant'
          ? (product.variants || []).map((v) => ({ variantId: String(v.variantId), label: variantLabel(v) }))
          : [],
    },
    branch: branchDoc ? { id: String(branchDoc._id), name: branchDoc.name, code: branchDoc.code } : { id: String(branch) },
    split: { total: split.total, shelved: split.shelved, warehouse: split.warehouse },
    summary,
    lots: lots.slice().reverse(), // newest lot first
    events: events.slice(-MAX_EVENTS),
    truncated: events.length > MAX_EVENTS || rows.length >= MAX_TIMELINE_ROWS,
  };
}

module.exports = { TYPE_LABELS, buildFilter, list, csv, timeline, computeLots, rowView, nameMaps };
