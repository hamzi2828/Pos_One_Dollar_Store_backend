// src/services/purchasing/receivingService.js
// Goods receiving (GRN). See models/goodsReceipt.js and docs/BUYING_FLOW.md.
//
// New flow: check boxes → enter goods one product at a time (each entry puts
// its good pieces into the WAREHOUSE at once, optionally onto a shelf) → finish
// (per bill: bill total − value entered is claimed from the vendor if wanted).
//
// Old flow (kept for GRNs counted line by line): the receiver counts every
// line, then completes — accepted pieces go in at landed cost and short /
// damaged pieces are claimed back (debit note).
const GoodsReceipt = require('../../models/goodsReceipt');
const PurchaseOrder = require('../../models/purchaseOrder');
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const { branchFilter } = require('../../middleware/access');
const stockService = require('../stockService');
const vendorLedger = require('../vendorLedgerService');
const locationService = require('../inventory/locationService');
const { normalizeCode, resolveScan } = require('../../helper/productCodes');
const costing = require('./costing');
const products = require('./productLookup');
const poService = require('./purchaseOrderService');
const h = require('./helpers');

const { httpError, round2 } = h;

const STATUS_ORDER = ['pending', 'in_progress', 'completed', 'cancelled'];

// Movement note that ties a stock row to its GRN line (used to never receive a line twice).
const lineTag = (line) => `GRN line ${line.lineNo} ·`;
// Same for goods entries (receipt) and their undo (reversal).
const entryTag = (entry) => `GRN entry ${entry.entryNo} ·`;
const undoTag = (entry) => `GRN entry ${entry.entryNo} undone ·`;
const tagRx = (tag) => new RegExp(`^${h.escapeRegex(tag)}`);

// An entry not posted after this long was cut off half way (crash): finishing picks it up.
const ENTRY_STALE_MS = 30 * 1000;
// Category for products created while unpacking when none is chosen.
const QUICK_CATEGORY = 'General';

const liveEntries = (grn) => (grn.entries || []).filter((e) => !e.undone);
const sameUnit = (a, productId, variantId) => h.sameId(a.product, productId) && String(a.variantId || '') === String(variantId || '');

/**
 * 'entries' = new flow (goods entered one by one), 'lines' = counted line by
 * line on the old screen (or completed that way).
 */
const modeOf = (grn) => {
  if (liveEntries(grn).length) return 'entries';
  return (grn.lines || []).some((l) => l.posted || l.receivedQty > 0) ? 'lines' : 'entries';
};

async function findGRN(req, id) {
  if (!h.isId(id)) throw httpError('Goods receipt not found', 404);
  const grn = await GoodsReceipt.findOne({ _id: id, ...branchFilter(req) });
  if (!grn) throw httpError('Goods receipt not found', 404);
  return grn;
}

/** Config `purchasing.requireDifferentReceiver`: the buyer may not verify their own PO. */
async function assertMayVerify(req, grn) {
  const { requireDifferentReceiver } = await poService.settings();
  if (requireDifferentReceiver && h.sameId(h.userId(req), grn.buyer)) {
    throw httpError('You bought these goods, so someone else must verify and receive them.', 403, 'SAME_RECEIVER');
  }
}

const assertCounting = (grn) => {
  if (grn.status === 'pending') throw httpError('Press "Start receiving" first', 409, 'NOT_STARTED');
  if (grn.status !== 'in_progress') throw httpError(`This goods receipt is ${grn.status}`, 409, 'GRN_LOCKED');
  if (grn.lines.some((l) => l.posted)) {
    throw httpError('Completion has already started. Press "Complete" again to finish it.', 409, 'COMPLETING');
  }
  if (liveEntries(grn).length) {
    throw httpError('Goods on this receipt are being entered one by one. Use "Enter goods" instead of counting lines.', 409, 'ENTRIES_MODE');
  }
};

/** Entries may be added: boxes checked (in progress), not finishing, not counted the old way. */
const assertEntering = (grn) => {
  if (grn.status === 'pending') throw httpError('Check the boxes first, then enter the goods.', 409, 'NOT_STARTED');
  if (grn.status !== 'in_progress') throw httpError(`This goods receipt is ${grn.status}`, 409, 'GRN_LOCKED');
  if (h.isLocked(grn)) throw httpError('This goods receipt is being finished right now. Try again in a moment.', 409, 'GRN_BUSY');
  if (modeOf(grn) === 'lines') {
    throw httpError('This receipt is being counted line by line (old screen). Finish it there with "Complete".', 409, 'COUNTED_BY_LINES');
  }
};

/** The PO bills (locked once sent) needed for boxes, bill totals and entries. */
const loadPO = (grn) =>
  PurchaseOrder.findById(grn.purchaseOrder)
    .select('poNumber status buyerName notes totals charges bills._id bills.vendor bills.vendorName bills.billNo bills.cartons bills.billTotal bills.photos bills.paidNow')
    .lean();

/**
 * One row per vendor bill: { bill, vendor, vendorName, billNo, billTotal,
 * boxesExpected, boxesReceived }. From the GRN boxes (frozen at send); older
 * GRNs without boxes fall back to the PO bills.
 */
function billsOf(grn, po) {
  if (grn.boxes && grn.boxes.length) {
    const poBills = new Map(((po && po.bills) || []).map((b) => [String(b._id), b]));
    return grn.boxes.map((b) => {
      const pb = poBills.get(String(b.bill));
      return {
        bill: b.bill,
        vendor: b.vendor || (pb && pb.vendor) || null,
        vendorName: b.vendorName,
        billNo: b.billNo,
        billTotal: round2(b.billTotal > 0 ? b.billTotal : pb ? pb.billTotal : 0),
        boxesExpected: b.expected || 0,
        boxesReceived: b.received || 0,
      };
    });
  }
  return ((po && po.bills) || []).map((b) => ({
    bill: b._id,
    vendor: b.vendor,
    vendorName: b.vendorName,
    billNo: b.billNo,
    billTotal: round2(b.billTotal),
    boxesExpected: b.cartons || 0,
    boxesReceived: 0,
  }));
}

const sumOf = (rows, fn) => rows.reduce((s, r) => s + (Number(fn(r)) || 0), 0);
// Value of the GOOD pieces entered (damaged pieces are not counted, so their money is claimable).
const enteredValue = (entries) => round2(sumOf(entries, (e) => e.stockQty * e.costPrice));

/** Progress numbers for the "enter goods" screen. */
function progressOf(grn, bills) {
  const live = liveEntries(grn);
  const byBill = bills.map((b) => {
    const es = live.filter((e) => h.sameId(e.bill, b.bill));
    const entered = enteredValue(es);
    return {
      bill: b.bill,
      vendor: b.vendor,
      vendorName: b.vendorName,
      billNo: b.billNo,
      billTotal: b.billTotal,
      entered,
      left: round2(b.billTotal - entered),
      boxesExpected: b.boxesExpected,
      boxesReceived: b.boxesReceived,
      entries: es.length,
      pieces: sumOf(es, (e) => e.qty),
      damaged: sumOf(es, (e) => e.damagedQty),
    };
  });
  const entered = round2(sumOf(byBill, (b) => b.entered));
  const billTotal = round2(sumOf(byBill, (b) => b.billTotal));
  return {
    byBill,
    entered,
    billTotal,
    left: round2(billTotal - entered),
    entries: live.length,
    pieces: sumOf(live, (e) => e.qty), // pieces entered, damaged included
    damaged: sumOf(live, (e) => e.damagedQty),
    stocked: sumOf(live, (e) => e.stockQty), // pieces put into the warehouse
    boxesExpected: sumOf(bills, (b) => b.boxesExpected),
    boxesReceived: sumOf(bills, (b) => b.boxesReceived),
  };
}

/**
 * What finishing does per bill: difference = bill total − value entered.
 * `claimsInput` [{ bill, claim }]: claim defaults to true when difference > 0.
 */
function closingOf(grn, bills, claimsInput) {
  const choices = new Map();
  for (const c of h.toList(claimsInput)) {
    const billId = c && (c.bill || c.billId);
    if (!bills.some((b) => h.sameId(b.bill, billId))) throw httpError('Vendor bill not found on this goods receipt', 404);
    choices.set(String(billId), h.toBool(c.claim, true));
  }
  const live = liveEntries(grn);
  const warnings = [];
  const byBill = bills.map((b) => {
    const es = live.filter((e) => h.sameId(e.bill, b.bill));
    const entered = enteredValue(es);
    const difference = round2(b.billTotal - entered);
    const shortLines = (grn.lines || []).filter((l) => h.sameId(l.bill, b.bill) && l.shortQty > 0);
    const claim = difference > 0 ? (choices.has(String(b.bill)) ? choices.get(String(b.bill)) : true) : false;
    let warning = null;
    if (difference < 0) {
      warning = `Rs ${-difference} more was entered than the bill from ${b.vendorName}${b.billNo ? ` (${b.billNo})` : ''} says. Check the cost prices.`;
      warnings.push(warning);
    }
    return {
      bill: b.bill,
      vendor: b.vendor,
      vendorName: b.vendorName,
      billNo: b.billNo,
      billTotal: b.billTotal,
      entered,
      difference,
      claim,
      claimAmount: claim ? difference : 0,
      damaged: sumOf(es, (e) => e.damagedQty),
      damagedValue: round2(sumOf(es, (e) => e.damagedQty * e.costPrice)),
      shortQty: sumOf(shortLines, (l) => l.shortQty),
      warning,
    };
  });
  // Typed items never entered (info only).
  const shortLines = (grn.lines || [])
    .filter((l) => l.shortQty > 0)
    .map((l) => ({
      lineId: l._id,
      bill: l.bill,
      vendorName: l.vendorName,
      productName: l.productName,
      expected: l.expectedQty,
      entered: l.receivedQty,
      short: l.shortQty,
    }));
  return {
    byBill,
    shortLines,
    warnings,
    totals: {
      billTotal: round2(sumOf(byBill, (b) => b.billTotal)),
      entered: round2(sumOf(byBill, (b) => b.entered)),
      claim: round2(sumOf(byBill, (b) => b.claimAmount)),
    },
  };
}

// Keep short / accepted in step with the counts (for lists and the screen).
const refreshLine = (line) => {
  line.receivedQty = Math.min(line.receivedQty || 0, line.expectedQty);
  line.damagedQty = Math.min(line.damagedQty || 0, line.receivedQty);
  line.shortQty = line.expectedQty - line.receivedQty;
  line.acceptedQty = line.receivedQty - line.damagedQty;
};

/** Save with a reload-and-retry on concurrent changes (two scanners at once). */
async function mutateCounting(req, id, fn) {
  for (let attempt = 1; ; attempt++) {
    const grn = await findGRN(req, id);
    assertCounting(grn);
    const result = await fn(grn);
    grn.lines.forEach(refreshLine);
    try {
      await grn.save();
      return { grn, result };
    } catch (err) {
      if (err && err.name === 'VersionError' && attempt < 4) continue;
      throw h.friendlyDbError(err);
    }
  }
}

// ---------------------------------------------------------------- read

async function list(req) {
  const q = req.query || {};
  const { page, limit, skip } = h.pageParams(q);
  const base = { ...branchFilter(req) };
  const search = String(q.search || '').trim();
  if (search) {
    const rx = new RegExp(h.escapeRegex(search), 'i');
    base.$or = [{ grnNumber: rx }, { poNumber: rx }, { 'builty.builtyNo': rx }, { 'lines.vendorName': rx }, { 'boxes.vendorName': rx }, { receiverName: rx }];
  }
  const range = h.dateRange(q.from, q.to);
  if (range) base.createdAt = range;
  const filter = { ...base };
  if (q.status === 'open') filter.status = { $in: ['pending', 'in_progress'] };
  else if (GoodsReceipt.STATUSES.includes(q.status)) filter.status = q.status;

  const [rows, total, counts] = await Promise.all([
    GoodsReceipt.aggregate([
      { $match: filter },
      { $addFields: { statusOrder: { $indexOfArray: [STATUS_ORDER, '$status'] } } },
      { $sort: { statusOrder: 1, createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          grnNumber: 1,
          poNumber: 1,
          purchaseOrder: 1,
          branch: 1,
          status: 1,
          buyerName: 1,
          receiverName: 1,
          builty: 1,
          expectedCartons: 1,
          cartonsReceived: 1,
          totals: 1,
          createdAt: 1,
          startedAt: 1,
          completedAt: 1,
          lineCount: { $size: '$lines' },
          expectedPieces: { $sum: '$lines.expectedQty' },
          receivedPieces: { $sum: '$lines.receivedQty' },
          vendors: { $setUnion: ['$lines.vendorName', { $ifNull: ['$boxes.vendorName', []] }] },
          boxesCheckedAt: 1,
          liveEntries: {
            $filter: { input: { $ifNull: ['$entries', []] }, as: 'e', cond: { $ne: ['$$e.undone', true] } },
          },
        },
      },
      {
        $addFields: {
          entryCount: { $size: '$liveEntries' },
          enteredPieces: { $sum: '$liveEntries.qty' },
        },
      },
      { $project: { liveEntries: 0 } },
    ]),
    GoodsReceipt.countDocuments(filter),
    GoodsReceipt.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const statusCounts = Object.fromEntries(GoodsReceipt.STATUSES.map((s) => [s, 0]));
  for (const c of counts) statusCounts[c._id] = c.n;
  statusCounts.open = statusCounts.pending + statusCounts.in_progress;
  return { data: rows, meta: h.pageMeta(page, limit, total, { counts: statusCounts }) };
}

/** GRN + what completing it would do (or did): stock lines, landed costs, vendor claims. */
async function getOne(req, id) {
  const grn = await findGRN(req, id);
  await grn.populate('branch', 'name code');
  const plain = grn.toObject();
  delete plain.lockedAt;
  const po = await loadPO(grn);
  plain.purchaseOrder = po || { _id: grn.purchaseOrder, poNumber: grn.poNumber };
  plain.summary = costing.receiptCosting(grn); // old line-by-line view
  plain.mode = modeOf(grn);

  // New flow: boxes, entries (newest first; undone only with ?all=1), progress, finish preview.
  const bills = billsOf(grn, po);
  if (!plain.boxes || !plain.boxes.length) {
    plain.boxes = bills.map((b) => ({ bill: b.bill, vendor: b.vendor, vendorName: b.vendorName, billNo: b.billNo, billTotal: b.billTotal, expected: b.boxesExpected, received: 0 }));
  }
  if (plain.chargeRate === null || plain.chargeRate === undefined) plain.chargeRate = chargeRateFor(grn, bills);
  const showAll = req.query && (req.query.all === '1' || req.query.all === 'true');
  plain.entries = (plain.entries || []).filter((e) => showAll || !e.undone).sort((a, b) => b.entryNo - a.entryNo);
  plain.progress = progressOf(grn, bills);
  const claimsInput = grn.status === 'completed' ? bills.map((b) => ({ bill: b.bill, claim: (grn.claims || []).some((c) => h.sameId(c.bill, b.bill)) })) : [];
  plain.closing = closingOf(grn, bills, claimsInput);
  const units = await products.loadUnitsFor(grn.lines, { branchId: grn.branch });
  for (const line of plain.lines) {
    const unit = units.get(costing.unitKey(line.product, line.variantId));
    line.salePrice = unit ? unit.salePrice : null;
    line.productDeleted = unit ? unit.isDeleted : true;
  }
  const { requireDifferentReceiver } = await poService.settings();
  plain.canVerify = !(requireDifferentReceiver && h.sameId(h.userId(req), grn.buyer));
  return plain;
}

// ---------------------------------------------------------------- counting

async function start(req, id) {
  const grn = await findGRN(req, id);
  await assertMayVerify(req, grn);
  if (grn.status === 'in_progress') return getOne(req, id); // already started: keep counting
  if (grn.status !== 'pending') throw httpError(`This goods receipt is ${grn.status}`, 409, 'GRN_LOCKED');
  const now = new Date();
  const res = await GoodsReceipt.updateOne(
    { _id: grn._id, status: 'pending' },
    {
      $set: { status: 'in_progress', receiver: h.userId(req), receiverName: h.userName(req), startedAt: now },
      $push: { history: h.historyEntry(req, 'started') },
      $inc: { __v: 1 },
    }
  );
  if (!res.modifiedCount) throw httpError('This goods receipt changed. Reload and try again.', 409);
  await PurchaseOrder.updateOne(
    { _id: grn.purchaseOrder, status: 'closed' },
    { $set: { status: 'receiving' }, $push: { history: h.historyEntry(req, 'receiving_started', grn.grnNumber) }, $inc: { __v: 1 } }
  );
  return getOne(req, id);
}

/** Apply typed counts: lines [{ lineId, receivedQty, damagedQty, note }], cartonsReceived, notes, claimFromVendor. */
function applyCounts(grn, body = {}) {
  for (const input of h.toList(body.lines)) {
    const line = grn.lines.id(input.lineId || input._id);
    if (!line) throw httpError('Line not found on this goods receipt', 404);
    const received = h.has(input.receivedQty) ? h.toAmount(input.receivedQty, 'Received', { int: true }) : line.receivedQty;
    const damaged = h.has(input.damagedQty) ? h.toAmount(input.damagedQty, 'Damaged', { int: true }) : line.damagedQty;
    if (received > line.expectedQty) {
      throw httpError(
        `${line.productName}: received ${received} is more than the ${line.expectedQty} pieces billed. Receive extra pieces separately.`
      );
    }
    if (damaged > received) throw httpError(`${line.productName}: damaged (${damaged}) cannot be more than received (${received})`);
    line.receivedQty = received;
    line.damagedQty = damaged;
    if (input.note !== undefined) line.note = h.toText(input.note, 300);
  }
  if (h.has(body.cartonsReceived)) grn.cartonsReceived = h.toAmount(body.cartonsReceived, 'Cartons received', { int: true });
  if (body.notes !== undefined) grn.notes = h.toText(body.notes, 1000);
  if (body.claimFromVendor !== undefined) grn.claimFromVendor = h.toBool(body.claimFromVendor, true);
}

async function saveCounts(req, id, body = {}) {
  await assertMayVerify(req, await findGRN(req, id));
  await mutateCounting(req, id, (grn) => applyCounts(grn, body));
  return getOne(req, id);
}

/**
 * Barcode scan: +qty pieces (a box code counts piecesPerBox) on the first line
 * of that product that still has pieces to count (spills over to the next
 * line of the same product, e.g. the same item from two vendors).
 */
async function scan(req, id, body = {}) {
  const code = normalizeCode(body.code);
  if (!code) throw httpError('Scan or type a code');
  const times = h.toAmount(body.qty, 'Quantity', { int: true, fallback: 1, min: 1 });
  const damaged = h.toBool(body.damaged, false);
  await assertMayVerify(req, await findGRN(req, id));

  const { result } = await mutateCounting(req, id, async (grn) => {
    const productIds = [...new Set(grn.lines.map((l) => String(l.product)))];
    const found = await Product.find({ _id: { $in: productIds }, scanCodes: code }).setOptions({ withDeleted: true }).lean();
    let match = null;
    let product = null;
    for (const p of found) {
      match = resolveScan(p, code);
      if (match) {
        product = p;
        break;
      }
    }
    if (!match) {
      // Fallback: the short code / SKU printed on the PO line.
      const line = grn.lines.find((l) => normalizeCode(l.code) === code);
      if (line) {
        product = { _id: line.product };
        match = { variantId: line.variantId, qty: 1 };
      }
    }
    if (!match) throw httpError(`Code ${code} is not on this goods receipt`, 404, 'NOT_ON_RECEIPT');

    const candidates = grn.lines.filter(
      (l) => String(l.product) === String(product._id) && (!match.variantId || String(l.variantId || '') === String(match.variantId))
    );
    let pieces = (match.qty || 1) * times;
    const room = candidates.reduce((s, l) => s + (l.expectedQty - l.receivedQty), 0);
    const name = candidates[0] ? candidates[0].productName : code;
    if (room <= 0) throw httpError(`All pieces of ${name} are already counted`, 400, 'ALREADY_COUNTED');
    if (pieces > room) throw httpError(`Only ${room} more piece(s) of ${name} are expected (this scan is ${pieces})`, 400, 'TOO_MANY');

    const touched = [];
    for (const line of candidates) {
      if (pieces <= 0) break;
      const add = Math.min(pieces, line.expectedQty - line.receivedQty);
      if (add <= 0) continue;
      line.receivedQty += add;
      if (damaged) line.damagedQty += add;
      pieces -= add;
      touched.push({ lineId: line._id, productName: line.productName, added: add, receivedQty: line.receivedQty, expectedQty: line.expectedQty });
    }
    return touched;
  });
  return { scanned: result, grn: await getOne(req, id) };
}

async function addPhotos(req, id, urls = []) {
  if (!urls.length) throw httpError('Choose at least one photo');
  const grn = await findGRN(req, id);
  if (!['pending', 'in_progress'].includes(grn.status)) throw httpError(`This goods receipt is ${grn.status}`, 409);
  if (grn.photos.length + urls.length > 20) throw httpError('A goods receipt can have at most 20 photos');
  await GoodsReceipt.updateOne({ _id: grn._id }, { $push: { photos: { $each: urls } } });
  return getOne(req, id);
}

// ---------------------------------------------------------------- new flow: boxes

/** Frozen charge rate, or (older GRNs) trip charges / Σ bill totals. */
const chargeRateFor = (grn, bills) =>
  typeof grn.chargeRate === 'number' ? grn.chargeRate : costing.chargeRateOf(grn.chargesTotal, sumOf(bills, (b) => b.billTotal));

/**
 * Step 1: boxes that reached the warehouse, per bill: { boxes: [{ bill, received }], note }.
 * On a pending GRN this also starts receiving (like `start`). Can be corrected
 * until the first goods are entered.
 */
async function checkBoxes(req, id, body = {}) {
  const grn = await findGRN(req, id);
  await assertMayVerify(req, grn);
  if (!['pending', 'in_progress'].includes(grn.status)) throw httpError(`This goods receipt is ${grn.status}`, 409, 'GRN_LOCKED');
  if (grn.status === 'in_progress' && liveEntries(grn).length) {
    throw httpError('Goods are already being entered, so the box count can no longer be changed.', 409, 'BOXES_LOCKED');
  }
  const inputs = h.toList(body.boxes);
  if (!inputs.length) throw httpError('Enter how many boxes arrived for each vendor bill');

  const po = await loadPO(grn);
  const boxes = billsOf(grn, po).map((b) => ({
    bill: b.bill,
    vendor: b.vendor,
    vendorName: b.vendorName,
    billNo: b.billNo,
    billTotal: b.billTotal,
    expected: b.boxesExpected,
    received: b.boxesReceived,
  }));
  for (const input of inputs) {
    const row = boxes.find((b) => h.sameId(b.bill, input && (input.bill || input.billId)));
    if (!row) throw httpError('Vendor bill not found on this goods receipt', 404);
    row.received = h.toAmount(input.received, `Boxes received from ${row.vendorName}`, { int: true });
  }
  const received = sumOf(boxes, (b) => b.received);
  const expected = sumOf(boxes, (b) => b.expected);
  const warnings = boxes
    .filter((b) => b.received !== b.expected)
    .map((b) =>
      b.received < b.expected
        ? `${b.vendorName}: ${b.expected - b.received} box(es) missing (${b.received} of ${b.expected}).`
        : `${b.vendorName}: ${b.received - b.expected} extra box(es) (${b.received}, bill says ${b.expected}).`
    );
  const now = new Date();
  const set = {
    boxes,
    cartonsReceived: received,
    boxesCheckedAt: now,
    boxesCheckedBy: h.userId(req),
    ...(body.note !== undefined || body.boxesNote !== undefined ? { boxesNote: h.toText(body.note ?? body.boxesNote, 500) } : {}),
  };
  const history = h.historyEntry(req, 'boxes_checked', [`${received} of ${expected} boxes arrived.`, ...warnings].join(' '));

  if (grn.status === 'pending') {
    const res = await GoodsReceipt.updateOne(
      { _id: grn._id, status: 'pending' },
      {
        $set: { ...set, status: 'in_progress', receiver: h.userId(req), receiverName: h.userName(req), startedAt: now },
        $push: { history },
        $inc: { __v: 1 },
      }
    );
    if (!res.modifiedCount) throw httpError('This goods receipt changed. Reload and try again.', 409);
    await PurchaseOrder.updateOne(
      { _id: grn.purchaseOrder, status: 'closed' },
      { $set: { status: 'receiving' }, $push: { history: h.historyEntry(req, 'receiving_started', grn.grnNumber) }, $inc: { __v: 1 } }
    );
  } else {
    const res = await GoodsReceipt.updateOne(
      { _id: grn._id, status: 'in_progress', entries: { $not: { $elemMatch: { undone: { $ne: true } } } } },
      { $set: set, $push: { history }, $inc: { __v: 1 } }
    );
    if (!res.modifiedCount) throw httpError('Goods are already being entered, so the box count can no longer be changed.', 409, 'BOXES_LOCKED');
  }
  return { grn: await getOne(req, id), warnings };
}

// ---------------------------------------------------------------- new flow: find / create products

/** A unit as the "enter goods" screen needs it, with the typed (expected) line it matches. */
function entryUnit(unit, grn, billId = null) {
  const lines = (grn.lines || []).filter((l) => sameUnit(l, unit.productId, unit.variantId));
  const left = (l) => Math.max(0, l.expectedQty - l.receivedQty);
  const ofBill = billId ? lines.filter((l) => h.sameId(l.bill, billId)) : [];
  const line = ofBill.find((l) => left(l) > 0) || lines.find((l) => left(l) > 0) || ofBill[0] || lines[0] || null;
  return {
    productId: unit.productId,
    variantId: unit.variantId || null,
    name: unit.productName,
    code: unit.code,
    salePrice: unit.salePrice,
    lastCost: unit.lastPurchasePrice ?? unit.costPrice ?? null,
    piecesPerBox: unit.piecesPerBox,
    expected: line
      ? {
          lineId: line._id,
          bill: line.bill,
          vendorName: line.vendorName,
          billNo: line.billNo,
          expectedQty: line.expectedQty,
          qtyLeft: left(line),
          unitPrice: h.round4(line.unitPrice),
        }
      : null,
    // extra info for the screen
    productName: unit.productName,
    variantLabel: unit.variantLabel,
    sku: unit.sku,
    category: unit.category,
    thumbnailUrl: unit.thumbnailUrl,
    costPrice: unit.costPrice,
    lastLandedCost: unit.lastLandedCost,
    lastVendorName: unit.lastVendorName,
    stockTotal: unit.stockTotal,
  };
}

/** GET /receiving/:id/lookup?code=&bill= — barcode / short code / SKU / name. */
async function lookup(req, id, query = {}) {
  const grn = await findGRN(req, id);
  await assertMayVerify(req, grn);
  const code = String(query.code || query.search || '').trim();
  if (!code) throw httpError('Scan or type a code or name');
  const units = await products.searchUnits({ search: code, branchId: grn.branch, limit: query.limit || 20 });
  const rows = units.map((u) => entryUnit(u, grn, h.isId(query.bill) ? query.bill : null));
  // Items expected on this receipt first (keeps the search order otherwise).
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (b.r.expected ? 1 : 0) - (a.r.expected ? 1 : 0) || a.i - b.i).map((x) => x.r);
}

/** POST /receiving/:id/new-product — quick product while unpacking (stock comes with the entry). */
async function newProduct(req, id, body = {}) {
  const grn = await findGRN(req, id);
  await assertMayVerify(req, grn);
  if (!['pending', 'in_progress'].includes(grn.status)) throw httpError(`This goods receipt is ${grn.status}`, 409, 'GRN_LOCKED');
  const costPrice = h.has(body.costPrice) ? h.toPrice(body.costPrice, 'Cost price') : null;
  const unit = await products.createProductForLine(body, { branchId: String(grn.branch), defaultCategory: QUICK_CATEGORY });
  const row = entryUnit(unit, grn);
  if (costPrice > 0) row.lastCost = costPrice;
  return row;
}

// ---------------------------------------------------------------- new flow: entries

/** Load → change → save entries / lines, retried when someone saved the GRN in between. */
async function mutateEntries(req, id, fn) {
  for (let attempt = 1; ; attempt++) {
    const grn = await findGRN(req, id);
    assertEntering(grn);
    const result = await fn(grn);
    grn.lines.forEach(refreshLine);
    try {
      await grn.save();
      return { grn, result };
    } catch (err) {
      if (err && err.name === 'VersionError' && attempt < 5) continue;
      throw h.friendlyDbError(err);
    }
  }
}

/**
 * Put an entry's good pieces into the warehouse — once. A stock row tagged with
 * the entry is looked for first (crash between "stock in" and "posted").
 */
async function postEntry(grn, entry, userId) {
  if (entry.posted) return entry;
  let movementId = null;
  if (entry.stockQty > 0) {
    const existing = await StockMovement.findOne({ refType: 'GoodsReceipt', refId: grn._id, type: 'purchase_receipt', note: tagRx(entryTag(entry)) })
      .select('_id')
      .lean();
    if (existing) {
      movementId = existing._id;
    } else {
      const r = await stockService.receiveStock({
        productId: entry.product,
        variantId: entry.variantId || undefined,
        quantity: entry.stockQty,
        branchId: grn.branch,
        cost: { unitCost: entry.landedUnitCost, purchasePrice: entry.costPrice, vendorId: entry.vendor, vendorName: entry.vendorName },
        movement: {
          type: 'purchase_receipt',
          refType: 'GoodsReceipt',
          refId: grn._id,
          refNo: grn.grnNumber,
          vendorId: entry.vendor,
          userId,
          note: `${entryTag(entry)} ${entry.vendorName}${entry.billNo ? ` bill ${entry.billNo}` : ''} · ${grn.poNumber}`,
        },
      });
      movementId = r.movement ? r.movement._id : null;
    }
  }
  const postedAt = new Date();
  await GoodsReceipt.updateOne(
    { _id: grn._id, 'entries._id': entry._id },
    { $set: { 'entries.$.posted': true, 'entries.$.postedAt': postedAt, 'entries.$.movement': movementId } }
  );
  entry.posted = true;
  entry.postedAt = postedAt;
  entry.movement = movementId;
  return entry;
}

/** Finish entries that were cut off half way (older than ENTRY_STALE_MS). */
async function finishStaleEntries(grn, userId) {
  for (const e of liveEntries(grn)) {
    if (!e.posted && Date.now() - new Date(e.createdAt).getTime() > ENTRY_STALE_MS) await postEntry(grn, e, userId);
  }
}

/** Remove an entry whose stock could not be posted (nothing went in), with its line counts. */
async function dropUnpostedEntry(req, id, entryId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const grn = await findGRN(req, id);
    const e = grn.entries.id(entryId);
    if (!e || e.posted) return;
    const line = e.line ? grn.lines.id(e.line) : null;
    if (line) {
      line.receivedQty = Math.max(0, line.receivedQty - e.lineQty);
      line.damagedQty = Math.max(0, line.damagedQty - e.lineDamaged);
      refreshLine(line);
    }
    e.deleteOne();
    try {
      await grn.save();
      return;
    } catch (err) {
      if (!(err && err.name === 'VersionError')) throw err;
    }
  }
}

const plainEntry = (e) => (e && e.toObject ? e.toObject() : e);

/** Boxes of a bill that arrived (or were expected, if not counted). */
function boxCountOf(grn, billId) {
  const b = (grn.boxes || []).find((x) => h.sameId(x.bill, billId));
  return b ? b.received || b.expected || 0 : 0;
}

/** Optional box number (1..boxes of the bill); empty = 0 (not said). */
function boxNoFor(grn, bill, value) {
  if (!h.has(value) || value === 0 || value === '0') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw httpError('Box number must be 1 or more');
  const count = boxCountOf(grn, bill.bill);
  if (count && n > count) throw httpError(`Only ${count} box${count === 1 ? '' : 'es'} came from ${bill.vendorName || 'this vendor'}`);
  return n;
}

/**
 * POST /receiving/:id/boxes/done { bill, boxNo, done = true } — mark a box as
 * fully unpacked (or open it again). Only a note for the screen; stock is not touched.
 */
async function markBox(req, id, body = {}) {
  const first = await findGRN(req, id);
  await assertMayVerify(req, first);
  assertEntering(first);
  const bills = billsOf(first, await loadPO(first));
  const bill = bills.find((b) => h.sameId(b.bill, body.bill || body.billId));
  if (!bill) throw httpError('Vendor bill not found on this goods receipt', 404);
  const boxNo = boxNoFor(first, bill, body.boxNo);
  if (!boxNo) throw httpError('Choose the box');
  const done = body.done === undefined ? true : body.done === true || body.done === 'true';
  for (let attempt = 1; ; attempt++) {
    const grn = await findGRN(req, id);
    const rest = (grn.boxesDone || []).filter((x) => !(h.sameId(x.bill, bill.bill) && x.boxNo === boxNo));
    grn.boxesDone = done ? [...rest, { bill: bill.bill, boxNo, at: new Date(), by: h.userId(req), byName: h.userName(req) }] : rest;
    try {
      await grn.save();
      break;
    } catch (err) {
      if (err && err.name === 'VersionError' && attempt < 5) continue;
      throw h.friendlyDbError(err);
    }
  }
  return getOne(req, id);
}

/**
 * POST /receiving/:id/entries
 * { bill, productId, variantId?, qty, costPrice, damagedQty?, shelfId?, shelfQty?, requestId? }
 * Good pieces (qty − damaged) go into the warehouse now at costPrice × (1 + chargeRate);
 * shelfId + shelfQty puts some on a shelf straight away.
 * -> { entry, grn, tags: { productId, variantId, copies }, warnings }
 */
async function addEntry(req, id, body = {}) {
  const userId = h.userId(req);
  const first = await findGRN(req, id);
  await assertMayVerify(req, first);

  // A resent request (same requestId) returns the entry it already made.
  const requestId = h.toText(body.requestId, 80);
  const repeat = requestId ? first.entries.find((e) => e.requestId === requestId) : null;
  if (repeat) return entryResult(req, id, first, repeat, { repeated: true });

  assertEntering(first);
  const po = await loadPO(first);
  const bills = billsOf(first, po);
  const billId = body.bill || body.billId || (bills.length === 1 ? bills[0].bill : null);
  const bill = bills.find((b) => h.sameId(b.bill, billId));
  if (!bill) {
    throw billId ? httpError('Vendor bill not found on this goods receipt', 404) : httpError('Choose which vendor bill these goods came from');
  }

  const qty = h.toAmount(body.qty, 'Pieces', { int: true });
  if (!(qty >= 1)) throw httpError('Enter how many pieces you took out of the box');
  const damagedQty = h.toAmount(body.damagedQty, 'Damaged pieces', { int: true });
  if (damagedQty > qty) throw httpError(`Damaged pieces (${damagedQty}) cannot be more than the pieces entered (${qty})`);
  const costPrice = h.toPrice(body.costPrice, 'Cost price');
  if (!(costPrice > 0)) throw httpError('Enter the cost price (what the vendor charged per piece)');
  const unit = await products.loadUnit(body.productId || body.product, body.variantId || null, { branchId: first.branch });
  const stockQty = qty - damagedQty;
  const boxNo = boxNoFor(first, bill, body.boxNo);

  let shelf = null;
  let shelfQty = 0;
  if (h.has(body.shelfId)) {
    shelfQty = h.has(body.shelfQty) ? h.toAmount(body.shelfQty, 'Pieces for the shelf', { int: true }) : stockQty;
    if (shelfQty > stockQty) throw httpError(`Only ${stockQty} good piece(s) can go on the shelf`);
    if (shelfQty > 0) shelf = await locationService.loadShelf(body.shelfId, first.branch);
  }

  // Frozen at send; older GRNs get it now (once).
  const chargeRate = chargeRateFor(first, bills);
  if (typeof first.chargeRate !== 'number') {
    await GoodsReceipt.updateOne({ _id: first._id, chargeRate: null }, { $set: { chargeRate, goodsTotal: sumOf(bills, (b) => b.billTotal) } });
  }
  const landedUnitCost = costing.landedFrom(costPrice, chargeRate);
  await finishStaleEntries(first, userId);

  const { grn, result: entryId } = await mutateEntries(req, id, (doc) => {
    const dup = requestId ? doc.entries.find((e) => e.requestId === requestId) : null;
    if (dup) return dup._id;
    const entryNo = (doc.entrySeq || 0) + 1;
    doc.entrySeq = entryNo;

    // Tick off the typed item of the same bill + product (capped; the rest is extra).
    const candidates = doc.lines.filter((l) => h.sameId(l.bill, bill.bill) && sameUnit(l, unit.productId, unit.variantId));
    const line = candidates.find((l) => l.expectedQty - l.receivedQty > 0) || candidates[0] || null;
    let lineQty = 0;
    let lineDamaged = 0;
    if (line) {
      lineQty = Math.min(qty, Math.max(0, line.expectedQty - line.receivedQty));
      lineDamaged = Math.min(damagedQty, lineQty);
      line.receivedQty += lineQty;
      line.damagedQty += lineDamaged;
    }

    doc.entries.push({
      entryNo,
      requestId,
      bill: bill.bill,
      vendor: bill.vendor,
      vendorName: bill.vendorName,
      billNo: bill.billNo,
      product: unit.productId,
      variantId: unit.variantId || null,
      productName: unit.productName,
      code: unit.code,
      salePrice: unit.salePrice,
      qty,
      boxNo,
      damagedQty,
      stockQty,
      costPrice,
      landedUnitCost,
      value: round2(qty * costPrice),
      line: line ? line._id : null,
      lineQty,
      lineDamaged,
      createdBy: userId,
      createdByName: h.userName(req),
      createdAt: new Date(),
    });
    return doc.entries[doc.entries.length - 1]._id;
  });

  const entry = grn.entries.id(entryId);
  if (!entry.posted) {
    try {
      await postEntry(grn, entry, userId);
    } catch (err) {
      await dropUnpostedEntry(req, id, entryId).catch(() => {});
      throw httpError(`Could not put ${entry.productName} into stock: ${err.message}`, err.status && err.status < 500 ? err.status : 400, 'ENTRY_FAILED');
    }
  }

  // Straight onto a shelf (optional). If it fails the pieces simply stay in the warehouse.
  const warnings = [];
  if (shelf && shelfQty > 0 && entry.stockQty > 0 && !entry.shelved) {
    try {
      await locationService.putaway({
        branchId: grn.branch,
        productId: entry.product,
        variantId: entry.variantId,
        shelfId: shelf._id,
        qty: shelfQty,
        userId,
        note: `${entryTag(entry)} put on shelf while unpacking (${grn.grnNumber})`,
      });
      await GoodsReceipt.updateOne(
        { _id: grn._id, 'entries._id': entry._id },
        { $set: { 'entries.$.shelved': shelfQty, 'entries.$.shelf': shelf._id, 'entries.$.shelfCode': shelf.code } }
      );
      entry.shelved = shelfQty;
      entry.shelf = shelf._id;
      entry.shelfCode = shelf.code;
    } catch (err) {
      warnings.push(`Saved, but could not put the pieces on shelf ${shelf.code}: ${err.message}. They are in the warehouse.`);
    }
  }
  return entryResult(req, id, grn, entry, { warnings });
}

async function entryResult(req, id, grn, entry, { repeated = false, warnings = [] } = {}) {
  // A resend while the first request may still be posting leaves it to that request (or to Finish).
  const stale = Date.now() - new Date(entry.createdAt).getTime() > ENTRY_STALE_MS;
  if (!entry.posted && !entry.undone && (!repeated || stale)) await postEntry(grn, entry, h.userId(req));
  const e = plainEntry(entry);
  return {
    entry: e,
    grn: await getOne(req, id),
    tags: { productId: e.product, variantId: e.variantId || null, copies: e.undone ? 0 : e.stockQty, productName: e.productName, code: e.code, salePrice: e.salePrice },
    warnings,
    ...(repeated ? { repeated: true } : {}),
  };
}

/**
 * DELETE /receiving/:id/entries/:entryId — take the pieces back out (only if
 * they are all still in the warehouse) and roll back the typed line counts.
 * Reversal movement: type `adjustment_out`, note "GRN entry N undone ·".
 */
async function undoEntry(req, id, entryId) {
  const first = await findGRN(req, id);
  await assertMayVerify(req, first);
  const existing = h.isId(entryId) ? first.entries.id(entryId) : null;
  if (!existing) throw httpError('Entry not found on this goods receipt', 404);
  if (existing.undone) return { entry: plainEntry(existing), grn: await getOne(req, id), alreadyUndone: true };
  if (first.status !== 'in_progress') throw httpError('Entries can only be undone while the goods are being entered.', 409, 'GRN_LOCKED');

  const grn = await h.acquireLock(GoodsReceipt, first._id, { status: 'in_progress' });
  if (!grn) throw httpError('This goods receipt is busy right now. Try again in a moment.', 409, 'GRN_BUSY');
  const userId = h.userId(req);
  try {
    const entry = grn.entries.id(entryId);
    if (!entry.posted) await postEntry(grn, entry, userId); // half-saved: make it whole first
    let undoMovement = null;
    if (entry.stockQty > 0) {
      const done = await StockMovement.findOne({ refType: 'GoodsReceipt', refId: grn._id, type: 'adjustment_out', note: tagRx(undoTag(entry)) })
        .select('_id')
        .lean();
      if (done) {
        undoMovement = done._id;
      } else {
        const split = await locationService.unitSplit({ branchId: grn.branch, productId: entry.product, variantId: entry.variantId });
        if (split.warehouse < entry.stockQty) {
          const gone = Math.max(0, entry.stockQty - split.total); // sold / used / taken out
          const missing = entry.stockQty - split.warehouse;
          throw httpError(
            gone > 0
              ? `${gone} of these pieces are no longer in the shop (sold or taken out), so this entry cannot be undone. Use a stock adjustment instead.`
              : `${missing} of these pieces were already put on a shelf — move them back to the warehouse first.`,
            409,
            'NOT_IN_WAREHOUSE'
          );
        }
        const r = await stockService.deductStock({
          productId: entry.product,
          variantId: entry.variantId || undefined,
          quantity: entry.stockQty,
          branchId: grn.branch,
          movement: {
            type: 'adjustment_out',
            strategy: 'warehouse_first',
            refType: 'GoodsReceipt',
            refId: grn._id,
            refNo: grn.grnNumber,
            vendorId: entry.vendor,
            unitCost: entry.landedUnitCost,
            userId,
            note: `${undoTag(entry)} ${entry.productName} entered by mistake (${grn.grnNumber})`,
          },
        });
        undoMovement = r.movement ? r.movement._id : null;
      }
    }
    const line = entry.line ? grn.lines.id(entry.line) : null;
    if (line) {
      line.receivedQty = Math.max(0, line.receivedQty - entry.lineQty);
      line.damagedQty = Math.max(0, line.damagedQty - entry.lineDamaged);
      refreshLine(line);
    }
    entry.undone = true;
    entry.undoneAt = new Date();
    entry.undoneBy = userId;
    entry.undoneByName = h.userName(req);
    entry.undoMovement = undoMovement;
    grn.lockedAt = null;
    grn.history.push(h.historyEntry(req, 'entry_undone', `#${entry.entryNo} ${entry.productName}: ${entry.qty} pcs`));
    await grn.save();
    return { entry: plainEntry(entry), grn: await getOne(req, id) };
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(GoodsReceipt, grn._id);
  }
}

// ---------------------------------------------------------------- complete

/**
 * Post the receipt. Safe to retry: each line is marked `posted` right after
 * its stock went in (and a stock row tagged with the line is looked for
 * first), the vendor claim is a unique ledger row per GRN + bill, and a
 * completed GRN is returned as it is.
 */
async function complete(req, id, body = {}) {
  const grn = await findGRN(req, id);
  if (grn.status === 'completed') {
    // Retry after success: make sure the PO followed, then answer as before.
    await PurchaseOrder.updateOne(
      { _id: grn.purchaseOrder, status: { $in: ['closed', 'receiving'] } },
      { $set: { status: 'received', receivedAt: grn.completedAt }, $inc: { __v: 1 } }
    );
    return { ...(await getOne(req, id)), alreadyCompleted: true };
  }
  await assertMayVerify(req, grn);
  if (grn.status !== 'in_progress') {
    throw httpError(grn.status === 'pending' ? 'Check the boxes first (or press "Start receiving")' : `This goods receipt is ${grn.status}`, 409);
  }
  // Old screens send line counts; GRNs counted line by line finish the old way.
  const oldCounts = h.toList(body.lines).length > 0 || h.has(body.cartonsReceived) || body.claimFromVendor !== undefined;
  if (!liveEntries(grn).length && (modeOf(grn) === 'lines' || oldCounts)) return completeLines(req, id, body, grn);
  return completeEntries(req, id, body, grn);
}

/**
 * New flow: the stock is already in (per entry), so finishing only closes —
 * per bill, the value not entered (bill total − good pieces × cost price) is
 * claimed from the vendor with a debit note when `claim` (default yes).
 * Safe to retry: unique debit note per GRN + bill; a completed GRN is returned as is.
 */
async function completeEntries(req, id, body, current) {
  const grn = await h.acquireLock(GoodsReceipt, current._id, { status: 'in_progress' });
  if (!grn) throw httpError('This goods receipt is being finished right now. Try again in a moment.', 409, 'GRN_BUSY');
  const by = h.userId(req);
  try {
    // 1. Entries cut off half way: finish them (a very fresh one may still be saving).
    for (const e of liveEntries(grn)) {
      if (e.posted) continue;
      if (Date.now() - new Date(e.createdAt).getTime() < ENTRY_STALE_MS) {
        throw httpError('Goods are still being saved on this receipt. Try again in a moment.', 409, 'ENTRY_SAVING');
      }
      await postEntry(grn, e, by);
    }

    // 2. Per bill: claim what was not entered.
    const po = await PurchaseOrder.findById(grn.purchaseOrder);
    const bills = billsOf(grn, po ? po.toObject() : null);
    const closing = closingOf(grn, bills, body.claims);
    const claims = [];
    for (const b of closing.byBill) {
      if (!(b.claim && b.claimAmount > 0)) continue;
      const entry = await vendorLedger.post({
        vendorId: b.vendor,
        type: 'debit_note',
        debit: b.claimAmount,
        branchId: grn.branch,
        reference: b.billNo || '',
        refType: 'GoodsReceipt',
        refId: b.bill,
        refNo: grn.grnNumber,
        description: `Not received / damaged: Rs ${b.claimAmount} · ${grn.grnNumber} (${grn.poNumber})${b.billNo ? ` bill ${b.billNo}` : ''}`,
        userId: by,
        unique: true,
      });
      claims.push({
        bill: b.bill,
        vendor: b.vendor,
        vendorName: b.vendorName,
        billNo: b.billNo,
        shortQty: b.shortQty,
        damagedQty: b.damaged,
        amount: b.claimAmount,
        billTotal: b.billTotal,
        entered: b.entered,
        ledgerEntry: entry._id,
      });
    }

    // 3. Close the documents.
    const live = liveEntries(grn);
    const claimed = round2(sumOf(claims, (c) => c.amount));
    const accepted = sumOf(live, (e) => e.stockQty);
    grn.claims = claims;
    grn.totals = {
      expected: sumOf(grn.lines, (l) => l.expectedQty),
      received: sumOf(live, (e) => e.qty),
      damaged: sumOf(live, (e) => e.damagedQty),
      short: sumOf(grn.lines, (l) => l.shortQty),
      accepted,
      stockValue: round2(sumOf(live, (e) => e.stockQty * e.landedUnitCost)),
      claimed,
      boxesExpected: sumOf(bills, (b) => b.boxesExpected) || grn.expectedCartons || 0,
      boxesReceived: grn.boxesCheckedAt ? sumOf(bills, (b) => b.boxesReceived) : grn.cartonsReceived || 0,
      pieces: sumOf(live, (e) => e.qty),
      entered: closing.totals.entered,
      billTotal: closing.totals.billTotal,
    };
    if (body.notes !== undefined) grn.notes = h.toText(body.notes, 1000);
    grn.status = 'completed';
    grn.completedAt = new Date();
    grn.completedBy = by;
    if (!grn.receiver) {
      grn.receiver = by;
      grn.receiverName = h.userName(req);
    }
    grn.lockedAt = null;
    grn.history.push(
      h.historyEntry(req, 'completed', [`${accepted} pcs entered${claimed ? `, Rs ${claimed} claimed from vendors` : ''}.`, ...closing.warnings].join(' '))
    );
    await grn.save();

    if (po) {
      await PurchaseOrder.updateOne(
        { _id: po._id },
        {
          $set: { status: 'received', receivedAt: grn.completedAt },
          $push: { history: h.historyEntry(req, 'received', `${grn.grnNumber}: ${accepted} pcs entered (Rs ${closing.totals.entered} of Rs ${closing.totals.billTotal})`) },
          $inc: { __v: 1 },
        }
      );
    }
    const damaged = grn.totals.damaged;
    await poService.safeNotify({
      type: 'goods_received',
      title: `Goods received: ${grn.grnNumber}`,
      message: `${accepted} pcs in the warehouse (${grn.poNumber}).${damaged ? ` Damaged ${damaged}.` : ''}${claimed ? ` Rs ${claimed} claimed from vendors.` : ''}`,
      level: damaged || claimed || closing.warnings.length ? 'warning' : 'info',
      link: `/admin/purchasing/receiving/${grn._id}`,
      branchId: grn.branch,
      audience: 'purchase_orders',
      meta: { purchaseOrderId: grn.purchaseOrder, goodsReceiptId: grn._id },
    });
    return { ...(await getOne(req, id)), warnings: closing.warnings };
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(GoodsReceipt, grn._id);
  }
}

/** Old flow: counted lines are posted to stock at the end (GRNs in flight before the new screens). */
async function completeLines(req, id, body, current) {
  let grn = current;
  // Last counts typed on the screen (only before any line was posted).
  const hasCounts = h.toList(body.lines).length || h.has(body.cartonsReceived) || body.notes !== undefined || body.claimFromVendor !== undefined;
  if (hasCounts && !grn.lines.some((l) => l.posted)) await mutateCounting(req, id, (doc) => applyCounts(doc, body));

  grn = await h.acquireLock(GoodsReceipt, grn._id, { status: 'in_progress' });
  if (!grn) throw httpError('This goods receipt is being completed right now. Try again in a moment.', 409, 'GRN_BUSY');

  const po = await PurchaseOrder.findById(grn.purchaseOrder);
  const by = h.userId(req);
  try {
    // 1. Freeze landed costs over the accepted pieces (posted lines keep theirs).
    grn.lines.forEach(refreshLine);
    const calc = costing.receiptCosting(grn);
    const byLine = new Map(calc.lines.map((l) => [String(l.lineId), l]));
    for (const line of grn.lines) {
      if (line.posted) continue;
      const c = byLine.get(String(line._id));
      line.allocatedCharges = c.allocatedCharges;
      line.landedUnitCost = c.landedUnitCost;
      line.claimAmount = c.claimAmount;
    }
    await grn.save();

    // 2. Stock: accepted pieces into the branch warehouse, one line at a time.
    let done = grn.lines.filter((l) => l.posted).length;
    for (const line of grn.lines) {
      if (line.posted) continue;
      let movementId = null;
      if (line.acceptedQty > 0) {
        const existing = await StockMovement.findOne({
          refType: 'GoodsReceipt',
          refId: grn._id,
          note: new RegExp(`^${h.escapeRegex(lineTag(line))}`),
        })
          .select('_id')
          .lean();
        if (existing) {
          movementId = existing._id; // received before a crash: never twice
        } else {
          try {
            const r = await stockService.receiveStock({
              productId: line.product,
              variantId: line.variantId || undefined,
              quantity: line.acceptedQty,
              branchId: grn.branch,
              cost: { unitCost: line.landedUnitCost, purchasePrice: line.unitPrice, vendorId: line.vendor, vendorName: line.vendorName },
              movement: {
                type: 'purchase_receipt',
                refType: 'GoodsReceipt',
                refId: grn._id,
                refNo: grn.grnNumber,
                vendorId: line.vendor,
                userId: by,
                note: `${lineTag(line)} ${line.vendorName}${line.billNo ? ` bill ${line.billNo}` : ''} · ${grn.poNumber}`,
              },
            });
            movementId = r.movement ? r.movement._id : null;
          } catch (err) {
            const e = httpError(
              `Could not receive ${line.productName}: ${err.message}. ${done} of ${grn.lines.length} lines are in stock — fix the problem and press Complete again.`,
              err.status && err.status < 500 ? err.status : 400,
              'LINE_FAILED'
            );
            throw e;
          }
        }
      }
      const postedAt = new Date();
      await GoodsReceipt.updateOne(
        { _id: grn._id, 'lines._id': line._id },
        { $set: { 'lines.$.posted': true, 'lines.$.postedAt': postedAt, 'lines.$.movement': movementId } }
      );
      line.posted = true;
      line.postedAt = postedAt;
      line.movement = movementId;
      done += 1;
    }

    // 3. Vendor claims for short + damaged pieces (one unique debit note per bill).
    const final = costing.receiptCosting(grn);
    const claims = [];
    for (const c of final.claims) {
      const entry = await vendorLedger.post({
        vendorId: c.vendor,
        type: 'debit_note',
        debit: c.amount,
        branchId: grn.branch,
        reference: c.billNo || '',
        refType: 'GoodsReceipt',
        refId: c.bill,
        refNo: grn.grnNumber,
        description: `${grn.grnNumber} (${grn.poNumber}): ${c.shortQty} short, ${c.damagedQty} damaged pcs${c.billNo ? ` on bill ${c.billNo}` : ''}`,
        userId: by,
        unique: true,
      });
      claims.push({ ...c, ledgerEntry: entry._id });
    }

    // 4. Close the documents.
    grn.claims = claims;
    grn.totals = {
      expected: final.totals.expected,
      received: final.totals.received,
      damaged: final.totals.damaged,
      short: final.totals.short,
      accepted: final.totals.accepted,
      stockValue: final.totals.stockValue,
      claimed: final.totals.claimed,
    };
    grn.status = 'completed';
    grn.completedAt = new Date();
    grn.completedBy = by;
    if (!grn.receiver) {
      grn.receiver = by;
      grn.receiverName = h.userName(req);
    }
    grn.lockedAt = null;
    grn.history.push(
      h.historyEntry(req, 'completed', `${final.totals.accepted} pcs to warehouse${final.totals.claimed ? `, Rs ${final.totals.claimed} claimed from vendors` : ''}`)
    );
    await grn.save();

    if (po) {
      await PurchaseOrder.updateOne(
        { _id: po._id },
        {
          $set: { status: 'received', receivedAt: grn.completedAt },
          $push: { history: h.historyEntry(req, 'received', `${grn.grnNumber}: ${final.totals.accepted} of ${final.totals.expected} pcs accepted`) },
          $inc: { __v: 1 },
        }
      );
    }
    await poService.safeNotify({
      type: 'goods_received',
      title: `Goods received: ${grn.grnNumber}`,
      message: `${final.totals.accepted} pcs in the warehouse (${grn.poNumber}). Short ${final.totals.short}, damaged ${final.totals.damaged}.`,
      level: final.totals.short || final.totals.damaged ? 'warning' : 'info',
      link: `/admin/purchasing/receiving/${grn._id}`,
      branchId: grn.branch,
      audience: 'purchase_orders',
      meta: { purchaseOrderId: grn.purchaseOrder, goodsReceiptId: grn._id },
    });
    return getOne(req, id);
  } catch (err) {
    throw h.friendlyDbError(err);
  } finally {
    await h.releaseLock(GoodsReceipt, grn._id);
  }
}

module.exports = { list, getOne, start, saveCounts, scan, addPhotos, checkBoxes, lookup, newProduct, addEntry, undoEntry, markBox, complete };
