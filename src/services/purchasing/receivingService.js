// src/services/purchasing/receivingService.js
// Goods receiving (GRN): the receiver counts what arrived, then completes the
// receipt — accepted pieces go into the branch WAREHOUSE at landed cost and
// short / damaged pieces are claimed back from the vendor (debit note).
// See models/goodsReceipt.js for the workflow.
const GoodsReceipt = require('../../models/goodsReceipt');
const PurchaseOrder = require('../../models/purchaseOrder');
const Product = require('../../models/product');
const StockMovement = require('../../models/stockMovement');
const { branchFilter } = require('../../middleware/access');
const stockService = require('../stockService');
const vendorLedger = require('../vendorLedgerService');
const { normalizeCode, resolveScan } = require('../../helper/productCodes');
const costing = require('./costing');
const products = require('./productLookup');
const poService = require('./purchaseOrderService');
const h = require('./helpers');

const { httpError } = h;

const STATUS_ORDER = ['pending', 'in_progress', 'completed', 'cancelled'];

// Movement note that ties a stock row to its GRN line (used to never receive a line twice).
const lineTag = (line) => `GRN line ${line.lineNo} ·`;

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
};

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
    base.$or = [{ grnNumber: rx }, { poNumber: rx }, { 'builty.builtyNo': rx }, { 'lines.vendorName': rx }, { receiverName: rx }];
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
          vendors: { $setUnion: ['$lines.vendorName', []] },
        },
      },
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
  const po = await PurchaseOrder.findById(grn.purchaseOrder)
    .select('poNumber status buyerName notes totals charges bills._id bills.vendorName bills.billNo bills.cartons bills.billTotal bills.photos')
    .lean();
  plain.purchaseOrder = po || { _id: grn.purchaseOrder, poNumber: grn.poNumber };
  plain.summary = costing.receiptCosting(grn);
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

// ---------------------------------------------------------------- complete

/**
 * Post the receipt. Safe to retry: each line is marked `posted` right after
 * its stock went in (and a stock row tagged with the line is looked for
 * first), the vendor claim is a unique ledger row per GRN + bill, and a
 * completed GRN is returned as it is.
 */
async function complete(req, id, body = {}) {
  let grn = await findGRN(req, id);
  if (grn.status === 'completed') {
    // Retry after success: make sure the PO followed, then answer as before.
    await PurchaseOrder.updateOne(
      { _id: grn.purchaseOrder, status: { $in: ['closed', 'receiving'] } },
      { $set: { status: 'received', receivedAt: grn.completedAt }, $inc: { __v: 1 } }
    );
    return { ...(await getOne(req, id)), alreadyCompleted: true };
  }
  await assertMayVerify(req, grn);
  if (grn.status !== 'in_progress') throw httpError(grn.status === 'pending' ? 'Press "Start receiving" first' : `This goods receipt is ${grn.status}`, 409);

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

module.exports = { list, getOne, start, saveCounts, scan, addPhotos, complete };
