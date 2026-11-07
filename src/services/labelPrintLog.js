// Sticker print history.
// The sticker page is plain HTML (opened in a blob window without the sign-in
// header), so the server puts a signed "log ticket" in the page when it makes
// it. The page's Print buttons send the ticket + how many were printed to the
// public endpoint; the ticket says who made the page and what is on it.
// The ticket is signed with a key derived from JWT_SECRET, so it can never be
// used as a sign-in token.
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const LabelPrint = require('../models/labelPrint');

const TICKET_LIFE = '3d';
const MAX_ITEMS = 200;

const keyOf = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw Object.assign(new Error('Server misconfiguration: missing JWT secret'), { status: 500 });
  return `${s}|label-print-log`;
};

const userIdOf = (req) => (req.access && req.access.userId) || (req.user && (req.user.id || req.user._id)) || null;
const userNameOf = (req) => {
  const u = req.user || {};
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '';
};

/** Ticket for one sticker page. labels = [{ productId, variantId, name, code, copies, pps, kind }]. */
function makeTicket(req, labels, size) {
  try {
    const items = labels.slice(0, MAX_ITEMS).map((l) => ({
      p: String(l.productId),
      v: l.variantId || null,
      n: String(l.name || '').slice(0, 120),
      c: String(l.code || '').slice(0, 60),
      k: Math.max(0, Math.floor(Number(l.copies) || 0)),
      s: l.kind === 'box' ? 1 : Math.max(1, Math.floor(Number(l.pps) || 1)),
      b: l.bill && mongoose.isValidObjectId(l.bill) ? String(l.bill) : null,
    }));
    const u = userIdOf(req);
    return jwt.sign({ t: 'lp', u: u ? String(u) : null, un: userNameOf(req).slice(0, 80), z: size || '', i: items }, keyOf(), { expiresIn: TICKET_LIFE });
  } catch {
    return ''; // never block printing because of the log
  }
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });

/** POST body { ticket, count, mode, via }: the first `count` stickers of the page were printed. */
async function record(body = {}) {
  let t;
  try {
    t = jwt.verify(String(body.ticket || ''), keyOf());
  } catch {
    throw bad('Print log ticket is invalid or old. Open the stickers again.');
  }
  if (!t || t.t !== 'lp' || !Array.isArray(t.i)) throw bad('Print log ticket is invalid.');
  const pageTotal = t.i.reduce((s, x) => s + (x.k || 0), 0);
  let left = Math.min(pageTotal, Math.max(0, Math.floor(Number(body.count) || 0)));
  if (left < 1) throw bad('Nothing printed.');
  const mode = ['sale', 'piece', 'custom'].includes(body.mode) ? body.mode : 'custom';
  const via = body.via === 'printer' ? 'printer' : 'browser';

  // The page prints its stickers in order: split the count over the products.
  const docs = [];
  for (const x of t.i) {
    if (left <= 0) break;
    const n = Math.min(left, x.k || 0);
    left -= n;
    if (n < 1 || !mongoose.isValidObjectId(x.p)) continue;
    docs.push({
      product: x.p,
      variantId: x.v || null,
      bill: x.b && mongoose.isValidObjectId(x.b) ? x.b : null,
      productName: x.n,
      code: x.c,
      count: n,
      total: x.k,
      mode: t.i.length === 1 ? mode : 'custom',
      piecesPerSale: x.s || 1,
      via,
      size: t.z || '',
      user: t.u && mongoose.isValidObjectId(t.u) ? t.u : null,
      userName: t.un || '',
    });
  }
  if (!docs.length) throw bad('Nothing printed.');
  await LabelPrint.insertMany(docs);
  return { logged: docs.reduce((s, d) => s + d.count, 0) };
}

/** Latest prints of one product (newest first) and the total stickers printed. */
/** Stickers printed per product / variant / vendor bill, for many products at once. */
async function printedSummary(productIds) {
  const ids = [...new Set((productIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 500);
  if (!ids.length) return [];
  const rows = await LabelPrint.aggregate([
    { $match: { product: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, ignored: { $ne: true } } },
    {
      $group: {
        _id: { p: '$product', v: '$variantId', b: '$bill' },
        printed: { $sum: '$count' },
        scanned: { $sum: { $cond: [{ $eq: ['$mode', 'scanned'] }, '$count', 0] } },
      },
    },
  ]);
  // printed = all covered pieces (stickers + own barcode); scanned = the own-barcode part.
  return rows.map((r) => ({ productId: String(r._id.p), variantId: r._id.v || null, bill: r._id.b ? String(r._id.b) : null, printed: r.printed, scanned: r.scanned }));
}

async function listForProduct(productId, { variantId = null, bill = null, limit = 50 } = {}) {
  if (!mongoose.isValidObjectId(productId)) throw bad('Invalid product');
  const q = { product: new mongoose.Types.ObjectId(String(productId)), ignored: { $ne: true } };
  if (variantId) q.variantId = String(variantId);
  if (bill && mongoose.isValidObjectId(bill)) q.bill = new mongoose.Types.ObjectId(String(bill));
  const [rows, sum] = await Promise.all([
    LabelPrint.find(q).sort({ createdAt: -1 }).limit(Math.min(200, Math.max(1, Number(limit) || 50))).lean(),
    LabelPrint.aggregate([
      { $match: q },
      { $group: { _id: null, stickers: { $sum: '$count' }, scanned: { $sum: { $cond: [{ $eq: ['$mode', 'scanned'] }, '$count', 0] } } } },
    ]),
  ]);
  return {
    totalStickers: sum[0]?.stickers || 0,
    totalScanned: sum[0]?.scanned || 0,
    runs: rows.filter((r) => r.mode !== 'moved' && r.mode !== 'scanned' && r.mode !== 'removed').length,
    prints: rows.map((r) => ({
      id: String(r._id),
      count: r.count,
      total: r.total,
      mode: r.mode,
      piecesPerSale: r.piecesPerSale,
      via: r.via,
      size: r.size,
      userName: r.userName,
      note: r.note || '',
      codes: r.codes || null,
      at: r.createdAt,
    })),
  };
}

/** Stickers already printed for a page of ONE product / variant (ignored prints left out). null = mixed page or no log. */
async function printedFor(labels) {
  try {
    const keys = new Set(labels.map((l) => `${l.productId}|${l.variantId || ''}`));
    if (keys.size !== 1 || !labels.length) return null;
    const { productId, variantId } = labels[0];
    if (!mongoose.isValidObjectId(productId)) return null;
    const q = { product: new mongoose.Types.ObjectId(String(productId)), ignored: { $ne: true }, variantId: variantId ? String(variantId) : null };
    if (labels[0].bill && mongoose.isValidObjectId(labels[0].bill)) q.bill = new mongoose.Types.ObjectId(String(labels[0].bill));
    const sum = await LabelPrint.aggregate([{ $match: q }, { $group: { _id: null, n: { $sum: '$count' } } }]);
    return sum[0]?.n || 0;
  } catch {
    return null; // never block printing because of the log
  }
}

/**
 * Pieces moved from one vendor bill to another took their stickers with them:
 * up to `count` printed stickers go with them (never more than were printed on fromBill).
 * -> number moved
 */
async function moveBetweenBills({ productId, variantId = null, fromBill, toBill, count, userName = '', fromName = '', toName = '' }) {
  const product = new mongoose.Types.ObjectId(String(productId));
  const v = variantId ? String(variantId) : null;
  const from = new mongoose.Types.ObjectId(String(fromBill));
  const to = new mongoose.Types.ObjectId(String(toBill));
  const sum = await LabelPrint.aggregate([{ $match: { product, variantId: v, bill: from, ignored: { $ne: true } } }, { $group: { _id: null, n: { $sum: '$count' } } }]);
  const n = Math.min(Math.max(0, Math.floor(Number(count) || 0)), Math.max(0, sum[0]?.n || 0));
  if (n < 1) return 0;
  const p = await LabelPrint.findOne({ product, variantId: v }).sort({ createdAt: -1 }).lean();
  const base = { product, variantId: v, productName: p?.productName || '', code: p?.code || '', total: 0, mode: 'moved', piecesPerSale: p?.piecesPerSale || 1, via: 'browser', size: '', userName };
  await LabelPrint.insertMany([
    { ...base, bill: from, count: -n, note: `Moved to ${toName || 'another vendor'} with the pieces` },
    { ...base, bill: to, count: n, note: `Moved from ${fromName || 'another vendor'} with the pieces` },
  ]);
  return n;
}

/**
 * Pieces that already carry their own (manufacturer) barcode: no sticker needed.
 * Counted like printed stickers, so the entry shows done. body { productId, variantId, bill, count, total }.
 */
async function markScanned(req, body = {}) {
  if (!mongoose.isValidObjectId(body.productId)) throw bad('Invalid product');
  if (body.bill && !mongoose.isValidObjectId(body.bill)) throw bad('Invalid vendor bill');
  const count = Math.floor(Number(body.count) || 0);
  // Pieces per barcode (optional); a row may only update this breakdown (count 0).
  let codes = null;
  if (body.codes && typeof body.codes === 'object') {
    codes = {};
    for (const [k, v] of Object.entries(body.codes)) {
      const n = Math.floor(Number(v) || 0);
      if (n > 0 && String(k).length <= 64) codes[String(k)] = n;
    }
    if (!Object.keys(codes).length) codes = null;
  }
  if (count < (codes ? 0 : 1) || count > 1000000) throw bad('Enter how many pieces have their own barcode');
  const product = await mongoose.connection.db.collection('products').findOne(
    { _id: new mongoose.Types.ObjectId(String(body.productId)) },
    { projection: { name: 1, shortCode: 1 } }
  );
  if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
  const u = userIdOf(req);
  const doc = await LabelPrint.create({
    product: product._id,
    variantId: body.variantId ? String(body.variantId) : null,
    bill: body.bill || null,
    productName: product.name || '',
    code: product.shortCode || '',
    count,
    total: Math.max(0, Math.floor(Number(body.total) || 0)),
    mode: 'scanned',
    codes,
    note: (typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : 'Own barcode on the pack (scanned), no sticker needed'),
    piecesPerSale: 1,
    via: 'browser',
    user: u && mongoose.isValidObjectId(u) ? u : null,
    userName: userNameOf(req),
  });
  return { id: String(doc._id), count };
}

/**
 * Printed more stickers than the entry's pieces (e.g. 469 for 461): take the extra off the log.
 * Keyed like the log: this entry's product / variant / vendor bill, against the pieces of all its
 * live entries there. Never goes below the pieces; own-barcode rows are left alone. Kept as a
 * "removed" row (who / when) so the history shows it. Calling it again removes nothing.
 * -> { removed, printed, need }
 */
async function removeExtra(req, grnId, entryId) {
  if (!mongoose.isValidObjectId(grnId) || !mongoose.isValidObjectId(entryId)) throw bad('Invalid entry');
  const GoodsReceipt = require('../models/goodsReceipt');
  const grn = await GoodsReceipt.findById(grnId, { entries: 1 }).lean();
  const e = grn && (grn.entries || []).find((x) => String(x._id) === String(entryId) && !x.undone);
  if (!e) throw Object.assign(new Error('Entry not found'), { status: 404 });
  const v = e.variantId ? String(e.variantId) : null;
  // Pieces of this product from this vendor (same as the bar on the entry).
  const need = (grn.entries || [])
    .filter((x) => !x.undone && String(x.product) === String(e.product) && (x.variantId ? String(x.variantId) : null) === v && String(x.bill) === String(e.bill))
    .reduce((n, x) => n + (x.stockQty || 0) * Math.max(1, x.piecesPerSale || 1), 0);
  const q = { product: new mongoose.Types.ObjectId(String(e.product)), variantId: v, bill: new mongoose.Types.ObjectId(String(e.bill)), ignored: { $ne: true } };
  const sumOf = async () => {
    const s = await LabelPrint.aggregate([
      { $match: q },
      { $group: { _id: null, n: { $sum: '$count' }, scanned: { $sum: { $cond: [{ $eq: ['$mode', 'scanned'] }, '$count', 0] } } } },
    ]);
    return { n: s[0]?.n || 0, scanned: s[0]?.scanned || 0 };
  };
  const was = await sumOf();
  // Only printed stickers can go (not the own-barcode part).
  const n = Math.min(was.n - need, was.n - was.scanned);
  if (n < 1) return { removed: 0, printed: was.n, need };
  const p = await LabelPrint.findOne({ product: q.product, variantId: v }).sort({ createdAt: -1 }).lean();
  const u = userIdOf(req);
  const row = await LabelPrint.create({
    product: q.product,
    variantId: v,
    bill: q.bill,
    productName: p?.productName || e.productName || '',
    code: p?.code || e.code || '',
    count: -n,
    total: need,
    mode: 'removed',
    note: `Removed ${n} extra sticker${n === 1 ? '' : 's'} (printed more than the ${need} pieces)`,
    piecesPerSale: p?.piecesPerSale || 1,
    via: 'browser',
    user: u && mongoose.isValidObjectId(u) ? u : null,
    userName: userNameOf(req),
  });
  // Two clicks at once: never end below the pieces.
  const now = await sumOf();
  if (now.n < need) {
    const keep = n - (need - now.n);
    if (keep < 1) await LabelPrint.deleteOne({ _id: row._id });
    else await LabelPrint.updateOne({ _id: row._id }, { $set: { count: -keep, note: `Removed ${keep} extra sticker${keep === 1 ? '' : 's'} (printed more than the ${need} pieces)` } });
    const fixed = await sumOf();
    return { removed: Math.max(0, keep), printed: fixed.n, need };
  }
  return { removed: n, printed: now.n, need };
}

/** Ignore (or bring back) one print: test / wrong prints are not counted. */
async function setIgnored(req, id, ignored) {
  if (!mongoose.isValidObjectId(id)) throw bad('Invalid print');
  const on = ignored !== false;
  const r = await LabelPrint.findByIdAndUpdate(
    id,
    { $set: { ignored: on, ignoredBy: on ? userNameOf(req) : '', ignoredAt: on ? new Date() : null } },
    { new: true }
  ).lean();
  if (!r) throw Object.assign(new Error('Print not found'), { status: 404 });
  return { id: String(r._id), ignored: r.ignored };
}

module.exports = { makeTicket, record, listForProduct, printedSummary, setIgnored, printedFor, moveBetweenBills, markScanned, removeExtra };
