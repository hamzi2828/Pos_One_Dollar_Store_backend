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
async function listForProduct(productId, { variantId = null, limit = 50 } = {}) {
  if (!mongoose.isValidObjectId(productId)) throw bad('Invalid product');
  const q = { product: new mongoose.Types.ObjectId(String(productId)) };
  if (variantId) q.variantId = String(variantId);
  const [rows, sum] = await Promise.all([
    LabelPrint.find(q).sort({ createdAt: -1 }).limit(Math.min(200, Math.max(1, Number(limit) || 50))).lean(),
    LabelPrint.aggregate([{ $match: q }, { $group: { _id: null, stickers: { $sum: '$count' }, runs: { $sum: 1 } } }]),
  ]);
  return {
    totalStickers: sum[0]?.stickers || 0,
    runs: sum[0]?.runs || 0,
    prints: rows.map((r) => ({
      id: String(r._id),
      count: r.count,
      total: r.total,
      mode: r.mode,
      piecesPerSale: r.piecesPerSale,
      via: r.via,
      size: r.size,
      userName: r.userName,
      at: r.createdAt,
    })),
  };
}

module.exports = { makeTicket, record, listForProduct };
