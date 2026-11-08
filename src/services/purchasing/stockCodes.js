// src/services/purchasing/stockCodes.js
// One sticker code per received stock (owner, 2026-11-08).
//
// The first stock of a brand-new product keeps the product's own short code
// (e.g. 73062). Every later stock of the same product gets its OWN code, so a
// sold piece shows which stock / vendor / bill / cost it came from:
//
//   73062  -> first stock          (plain: the short code itself)
//   7306202 -> second stock        (short code + 2-digit number)
//   7306203 -> third stock ...     (7306299, then 73062100 ...)
//
// Why digits only: the shop's sticker roll (25 x 15 mm, TSPL Code 128) packs a
// digits-only code in "set C" (2 digits per symbol), so 7306202 is as narrow as
// 73062 and still prints with 2-dot bars; a "73062-2" would need set B and drop
// to 1-dot bars, which the SpeedX scanner reads badly. Digits also type the same
// on any keyboard layout (scanner in keyboard mode) and on the number pad.
// A code is never used twice: it is checked against every product's scanCodes
// (deleted products too) and an undone entry keeps its code reserved.
//
// Records live on product.stockCodes (see models/product.js); every code is in
// product.scanCodes, so all lookups (POS scan / search, offline catalogue,
// receiving / purchasing lookups, "find by code") find the product. Stock stays
// one number per product: codes are only for tracing.
//
// Entries of the same goods receipt, vendor bill, product and cost share one
// code (the same stock unpacked from two boxes). An edited entry keeps its code
// (its stickers are already on the pieces).
const mongoose = require('mongoose');
const Product = require('../../models/product');
const GoodsReceipt = require('../../models/goodsReceipt');
const { normalizeCode, PRODUCT_UNIT, generateShortCode } = require('../../helper/productCodes');

const sameId = (a, b) => !!a && !!b && String(a) === String(b);
const keyOf = (variantId) => (variantId ? String(variantId) : PRODUCT_UNIT);
const rowsOfUnit = (product, variantId) =>
  (product.stockCodes || []).filter((r) => (variantId ? String(r.variantId || '') === String(variantId) : !r.variantId));
const hasEntry = (row, entryId) => (row.entries || []).some((x) => sameId(x, entryId));

function unitOf(product, variantId) {
  if (product.productType !== 'variant') return product;
  return (product.variants || []).find((v) => String(v.variantId) === String(variantId)) || null;
}

const unitStock = (unit) => {
  if (!unit) return 0;
  if (Array.isArray(unit.batches) && unit.batches.length) return unit.batches.reduce((s, b) => s + (Number(b.quantity) || 0), 0);
  return Math.max(0, Number(unit.stock) || 0);
};

/** Is this code free everywhere (all products, deleted ones too)? */
async function isFree(code) {
  return !(await Product.exists({ scanCodes: code }).setOptions({ withDeleted: true }));
}

/** Next free stock code of a unit: short code + 2-digit number (02, 03 ...). */
async function nextCode(product, unit, variantId) {
  let base = normalizeCode(unit && unit.shortCode);
  if (!/^\d+$/.test(base)) base = await generateShortCode(new Set(), product._id); // no digit short code: a fresh number
  const own = new Set((product.scanCodes || []).map(normalizeCode));
  for (const r of product.stockCodes || []) own.add(normalizeCode(r.code));
  let n = rowsOfUnit(product, variantId).filter((r) => !r.plain).length + 2;
  for (let tries = 0; tries < 200; tries++, n++) {
    const code = `${base}${String(n).padStart(2, '0')}`;
    if (own.has(code)) continue;
    if (await isFree(code)) return code;
  }
  throw Object.assign(new Error('Could not make a new code for this stock. Try again.'), { status: 409 });
}

/** Another live entry of this unit on any goods receipt (other than these)? */
async function hasOtherLiveEntry(productId, variantId, exceptIds) {
  return !!(await GoodsReceipt.exists({
    entries: {
      $elemMatch: {
        product: new mongoose.Types.ObjectId(String(productId)),
        variantId: variantId ? String(variantId) : null,
        undone: { $ne: true },
        _id: { $nin: exceptIds.map((x) => new mongoose.Types.ObjectId(String(x))) },
      },
    },
  }));
}

const rowFor = (code, grn, entry, extra = {}) => ({
  code,
  variantId: entry.variantId ? String(entry.variantId) : null,
  plain: false,
  grn: grn._id,
  grnNumber: grn.grnNumber || '',
  bill: entry.bill || null,
  entries: [entry._id],
  entryNo: entry.entryNo || 0,
  vendor: entry.vendor || null,
  vendorName: entry.vendorName || '',
  billNo: entry.billNo || '',
  costPrice: Number(entry.costPrice) || 0,
  landedUnitCost: Number(entry.landedUnitCost) || 0,
  qty: Number(entry.stockQty) || 0,
  createdAt: new Date(),
  undone: false,
  undoneAt: null,
  ...extra,
});

/** Array path of one stockCodes row by code (positional filter `sc`). */
const ROW = 'stockCodes.$[sc]';

/** Add `entry` to the existing row with `code` (live again, pieces added, cost of the newest entry). */
async function joinRow(product, code, grn, entry) {
  await Product.updateOne(
    { _id: product._id },
    {
      $addToSet: { [`${ROW}.entries`]: entry._id },
      $inc: { [`${ROW}.qty`]: Number(entry.stockQty) || 0 },
      $set: {
        [`${ROW}.undone`]: false,
        [`${ROW}.undoneAt`]: null,
        [`${ROW}.costPrice`]: Number(entry.costPrice) || 0,
        [`${ROW}.landedUnitCost`]: Number(entry.landedUnitCost) || 0,
        [`${ROW}.grn`]: grn._id,
        [`${ROW}.grnNumber`]: grn.grnNumber || '',
        [`${ROW}.bill`]: entry.bill || null,
        [`${ROW}.vendor`]: entry.vendor || null,
        [`${ROW}.vendorName`]: entry.vendorName || '',
        [`${ROW}.billNo`]: entry.billNo || '',
      },
    },
    { arrayFilters: [{ 'sc.code': code, 'sc.entries': { $ne: entry._id } }] }
  ).setOptions({ withDeleted: true });
}

async function saveOnEntry(grn, entry, code) {
  await GoodsReceipt.updateOne({ _id: grn._id, 'entries._id': entry._id }, { $set: { 'entries.$.batchCode': code } });
  entry.batchCode = code;
  return code;
}

/**
 * Give a goods-receipt entry its sticker code (once; safe to call again).
 * opts.keepCode: the code of the entry this one replaces (edit).
 * Call BEFORE the entry's stock goes in when you can (the "first stock" check
 * reads the stock); a posted entry's own pieces are left out of the check.
 * -> the code ('' when the product has no code at all).
 */
async function assignForEntry(grn, entry, opts = {}) {
  if (!entry || entry.undone) return entry ? entry.batchCode || '' : '';
  if (entry.batchCode) return entry.batchCode;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const product = await Product.findById(entry.product).setOptions({ withDeleted: true }).lean();
    if (!product) return '';
    const unit = unitOf(product, entry.variantId);
    if (!unit) return '';
    const rows = rowsOfUnit(product, entry.variantId);

    // Already done (crash after the product was written, before the entry was).
    const mine = rows.find((r) => hasEntry(r, entry._id));
    if (mine) return saveOnEntry(grn, entry, mine.code);

    // Edit: the corrected entry keeps the code already on the stickers.
    const keep = normalizeCode(opts.keepCode);
    if (keep && rows.some((r) => normalizeCode(r.code) === keep)) {
      await joinRow(product, keep, grn, entry);
      return saveOnEntry(grn, entry, keep);
    }
    // Edit of an older entry (made before stock codes): keep printing the product code.
    if (keep && (product.scanCodes || []).map(normalizeCode).includes(keep)) return saveOnEntry(grn, entry, keep);

    // Same receipt, same vendor bill, same cost: the same stock from another box.
    const sibling = (grn.entries || []).find(
      (e) =>
        !sameId(e._id, entry._id) &&
        !e.undone &&
        e.batchCode &&
        sameId(e.product, entry.product) &&
        String(e.variantId || '') === String(entry.variantId || '') &&
        sameId(e.bill, entry.bill) &&
        Number(e.costPrice) === Number(entry.costPrice)
    );
    if (sibling && rows.some((r) => normalizeCode(r.code) === normalizeCode(sibling.batchCode))) {
      await joinRow(product, normalizeCode(sibling.batchCode), grn, entry);
      return saveOnEntry(grn, entry, normalizeCode(sibling.batchCode));
    }

    // First stock of a brand-new product: its own short code.
    const shortCode = normalizeCode(unit.shortCode) || normalizeCode(unit.sku);
    const stockBefore = Math.max(0, unitStock(unit) - (entry.posted ? Number(entry.stockQty) || 0 : 0));
    const liveRows = rows.filter((r) => !r.undone);
    const plainRow = rows.find((r) => r.plain);
    const receivedBefore = !!(unit.firstReceivedAt || unit.lastReceivedAt) && !plainRow; // an undone first stock does not count
    const first =
      !!shortCode &&
      !liveRows.length &&
      stockBefore <= 0 &&
      !receivedBefore &&
      !(await hasOtherLiveEntry(entry.product, entry.variantId, [entry._id]));
    if (first) {
      if (plainRow) await joinRow(product, normalizeCode(plainRow.code), grn, entry);
      else {
        const res = await Product.updateOne(
          { _id: product._id, stockCodes: { $not: { $elemMatch: { plain: true, variantId: entry.variantId ? String(entry.variantId) : null } } } },
          { $push: { stockCodes: rowFor(shortCode, grn, entry, { plain: true }) } }
        ).setOptions({ withDeleted: true });
        if (!res.modifiedCount) continue; // someone else just did it: look again
      }
      return saveOnEntry(grn, entry, shortCode);
    }

    // Any later stock: a new code of its own.
    const code = await nextCode(product, unit, entry.variantId);
    const res = await Product.updateOne(
      { _id: product._id, scanCodes: { $ne: code }, 'stockCodes.code': { $ne: code }, 'stockCodes.entries': { $ne: entry._id } },
      { $push: { stockCodes: rowFor(code, grn, entry) }, $addToSet: { scanCodes: code } }
    ).setOptions({ withDeleted: true });
    if (!res.modifiedCount) continue;
    return saveOnEntry(grn, entry, code);
  }
  throw Object.assign(new Error('Could not save the code for this stock. Try again.'), { status: 409 });
}

/** Entry undone: its pieces leave the code; a code with no live entry is marked undone (kept, never reused). */
async function entryUndone(entry) {
  if (!entry || !entry.batchCode) return;
  const code = normalizeCode(entry.batchCode);
  const product = await Product.findById(entry.product).select('stockCodes').setOptions({ withDeleted: true }).lean();
  const row = product && (product.stockCodes || []).find((r) => normalizeCode(r.code) === code && hasEntry(r, entry._id));
  if (!row) return;
  const left = (row.entries || []).filter((x) => !sameId(x, entry._id));
  await Product.updateOne(
    { _id: product._id },
    {
      $pull: { [`${ROW}.entries`]: entry._id },
      $set: {
        [`${ROW}.qty`]: Math.max(0, (Number(row.qty) || 0) - (Number(entry.stockQty) || 0)),
        ...(left.length ? {} : { [`${ROW}.undone`]: true, [`${ROW}.undoneAt`]: new Date() }),
      },
    },
    { arrayFilters: [{ 'sc.code': code, 'sc.entries': entry._id }] }
  ).setOptions({ withDeleted: true });
}

module.exports = { assignForEntry, entryUndone, nextCode, keyOf };
