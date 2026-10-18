// src/controller/store/locationsController.js
// Where stock sits inside the request's branch: warehouse vs shelves.
//
//   GET  /api/locations/shelves?search=          shelf picker list
//   GET  /api/locations/shelves/:shelfId         what is on a shelf
//   GET  /api/locations/scan/:code               shelf label | product code | rack code
//   GET  /api/locations/products?search=         product units + their shelves (lookup)
//   GET  /api/locations/products/:productId      one product's units + shelves
//   GET  /api/locations/warehouse                units with pieces still in the warehouse
//   GET  /api/locations/activity                 latest put-aways / moves
//   POST /api/locations/putaway                  warehouse -> shelf (single, or { lines: [...] })
//   POST /api/locations/move                     shelf -> shelf / warehouse
//   POST /api/locations/home-shelf               mark / unmark a unit's home shelf
//
// Stock is only changed through services/inventory/locationService.js
// (which writes the StockMovement ledger: putaway / location_move).
const mongoose = require('mongoose');
const Product = require('../../models/product');
const Rack = require('../../models/rack');
const Shelf = require('../../models/shelf');
const LocationStock = require('../../models/locationStock');
const StockMovement = require('../../models/stockMovement');
const loc = require('../../services/inventory/locationService');
const racksService = require('../../services/inventory/racksService');
const { findProductByCode, normalizeCode, unitBranchStock, getMainBranchId } = require('../../helper/productCodes');
const { escapeRegex } = require('../../helper/paginate');
const { httpError, moduleBranch, userIdOf } = require('./racksCommon');

const MAX_LINES = 200;
const MAX_QTY = 1000000;
const DAY_MS = 24 * 60 * 60 * 1000;

const isId = (v) => typeof v === 'string' ? /^[0-9a-fA-F]{24}$/.test(v) : !!v && mongoose.isValidObjectId(v);
const requireProductId = (v) => {
  if (!isId(v)) throw httpError('Choose a product (productId is missing or invalid)');
  return String(v);
};
const parseQty = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw httpError('Quantity must be a whole number of pieces (1 or more)');
  return n;
};
const cleanNote = (v) => String(v ?? '').trim().slice(0, 300);
const variantOf = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / DAY_MS)) : null);

const shelfSummary = (s, rack) => ({
  _id: String(s._id),
  code: s.code,
  rackId: String(s.rack),
  rackCode: s.rackCode,
  rackName: (rack && rack.name) || '',
  level: s.level,
  name: s.name || '',
  capacity: s.capacity ?? null,
  isActive: s.isActive !== false,
});

/**
 * Units (product / each variant) of plain products with this branch's
 * total, shelved, warehouse and shelf rows. One LocationStock query.
 */
async function unitsWithLocations(products, branchId) {
  if (!products.length) return [];
  const mainBranchId = await getMainBranchId();
  const rows = await LocationStock.find({
    branch: new mongoose.Types.ObjectId(branchId),
    product: { $in: products.map((p) => p._id) },
    $or: [{ qty: { $gt: 0 } }, { isHome: true }],
  })
    .sort({ firstPlacedAt: 1, _id: 1 })
    .lean();
  const out = [];
  for (const p of products) {
    const units = p.productType === 'variant' ? (p.variants || []).map((v) => ({ u: v, key: String(v.variantId) })) : [{ u: p, key: null }];
    for (const { u, key } of units) {
      const mine = rows.filter((r) => String(r.product) === String(p._id) && (r.variantId || null) === key);
      const total = Math.max(0, Number(unitBranchStock(u, branchId, mainBranchId)) || 0);
      const shelved = mine.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      out.push({
        productId: String(p._id),
        variantId: key,
        name: p.name,
        variantLabel: key ? loc.unitLabel(u) : '',
        category: p.category || '',
        code: u.shortCode || u.sku || '',
        price: u.price ?? p.price ?? null,
        thumbnailUrl: p.thumbnailUrl || null,
        total,
        shelved,
        warehouse: Math.max(0, total - shelved),
        lastReceivedAt: u.lastReceivedAt || p.lastReceivedAt || null,
        shelves: mine.map((r) => ({
          shelfId: String(r.shelf),
          code: r.shelfCode,
          qty: Number(r.qty) || 0,
          isHome: !!r.isHome,
          firstPlacedAt: r.firstPlacedAt,
          daysOnShelf: Number(r.qty) > 0 ? daysSince(r.firstPlacedAt) : null,
        })),
      });
    }
  }
  return out;
}

const loadPlainProduct = async (productId) => {
  const p = await Product.findById(productId).select(loc.WAREHOUSE_PRODUCT_FIELDS).lean();
  if (!p) throw httpError('Product not found', 404);
  return p;
};

/** Items on one shelf (with variant names and days on the shelf). */
async function shelfItems(shelfId) {
  const rows = await LocationStock.find({ shelf: shelfId, $or: [{ qty: { $gt: 0 } }, { isHome: true }] })
    .sort({ firstPlacedAt: 1, _id: 1 })
    .lean();
  if (!rows.length) return [];
  const products = await Product.find({ _id: { $in: [...new Set(rows.map((r) => String(r.product)))] } })
    .setOptions({ withDeleted: true })
    .select('name category price shortCode sku thumbnailUrl productType variants.variantId variants.color variants.size variants.attributes variants.price variants.shortCode variants.sku')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return rows.map((r) => {
    const p = byId.get(String(r.product)) || {};
    const v = r.variantId ? (p.variants || []).find((x) => String(x.variantId) === String(r.variantId)) : null;
    const unit = v || p;
    return {
      productId: String(r.product),
      variantId: r.variantId || null,
      name: p.name || '(deleted product)',
      variantLabel: v ? loc.unitLabel(v) : '',
      category: p.category || '',
      code: unit.shortCode || unit.sku || '',
      price: unit.price ?? p.price ?? null,
      thumbnailUrl: p.thumbnailUrl || null,
      qty: Number(r.qty) || 0,
      isHome: !!r.isHome,
      firstPlacedAt: r.firstPlacedAt,
      lastMovedAt: r.lastMovedAt,
      daysOnShelf: Number(r.qty) > 0 ? daysSince(r.firstPlacedAt) : null,
    };
  });
}

async function shelfDetail(shelf) {
  const [rack, items] = await Promise.all([
    Rack.findById(shelf.rack).select('code name categories isActive').lean(),
    shelfItems(shelf._id),
  ]);
  return {
    shelf: {
      ...shelfSummary(shelf, rack),
      rackCategories: (rack && rack.categories) || [],
      pieces: items.reduce((s, x) => s + x.qty, 0),
      products: new Set(items.filter((x) => x.qty > 0).map((x) => x.productId)).size,
    },
    items,
  };
}

/** Product search: name words, or code prefix (barcode / short code / SKU). */
function productSearchFilter(search) {
  const term = String(search || '').trim();
  const words = term.split(/\s+/).filter(Boolean).map(escapeRegex);
  return {
    $or: [
      { name: { $regex: words.map((w) => `(?=.*${w})`).join(''), $options: 'i' } },
      { scanCodes: { $regex: `^${escapeRegex(term.toUpperCase())}` } },
    ],
  };
}

/** One put-away line: resolve the shelf (id or scanned code), then locationService.putaway. */
async function putawayLine(branchId, line, userId) {
  const productId = requireProductId(line.productId);
  const qty = parseQty(line.qty);
  const shelf = await loc.findShelf({ branchId, shelfId: line.shelfId || null, shelfCode: line.shelfCode || null });
  const r = await loc.putaway({
    branchId,
    productId,
    variantId: variantOf(line.variantId),
    shelfId: shelf._id,
    qty,
    userId,
    note: cleanNote(line.note),
  });
  return { productId, variantId: variantOf(line.variantId), shelf: { _id: String(shelf._id), code: shelf.code }, qty: r.qty, split: r.split };
}

const locationsController = {
  // GET /api/locations/shelves?search=&rackId=&includeInactive=&limit=
  async shelves(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const q = req.query || {};
    const data = await racksService.listShelves({
      branchId,
      search: q.search,
      rackId: q.rackId,
      includeInactive: q.includeInactive,
      limit: q.limit,
    });
    res.json({ success: true, data, meta: { total: data.length, branch } });
  },

  // GET /api/locations/shelves/:shelfId
  async shelf(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    if (!isId(req.params.shelfId)) throw httpError('Invalid shelf id');
    const shelf = await Shelf.findOne({ _id: req.params.shelfId, branch: branchId }).lean();
    if (!shelf) throw httpError('Shelf not found', 404);
    res.json({ success: true, data: await shelfDetail(shelf), meta: { branch } });
  },

  // GET /api/locations/scan/:code — shelf label first, then any product code, then rack code.
  async scan(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const code = normalizeCode(req.params.code);
    if (!code) throw httpError('Scan or type a code');

    const shelf = await Shelf.findOne({ branch: branchId, code }).lean();
    if (shelf) {
      const detail = await shelfDetail(shelf);
      return res.json({ success: true, data: { kind: 'shelf', code, ...detail }, meta: { branch } });
    }

    const found = await findProductByCode(code);
    if (found) {
      const doc = found.product;
      const plain = typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc;
      let variantId = found.match.variantId || null;
      if (!variantId && plain.productType === 'variant' && (plain.variants || []).length === 1) variantId = String(plain.variants[0].variantId);
      const units = await unitsWithLocations([plain], branchId);
      const unit = units.find((u) => u.variantId === (variantId ? String(variantId) : null)) || (units.length === 1 ? units[0] : null);
      return res.json({
        success: true,
        data: {
          kind: 'product',
          code,
          match: { variantId: variantId ? String(variantId) : null, kind: found.match.kind, qty: found.match.qty || 1, batchNo: found.match.batchNo || null },
          product: { _id: String(plain._id), name: plain.name, category: plain.category || '', productType: plain.productType, thumbnailUrl: plain.thumbnailUrl || null },
          unit, // null when a variant still has to be chosen
          units,
        },
        meta: { branch },
      });
    }

    const rack = await Rack.findOne({ branch: branchId, code }).select('_id').lean();
    if (rack) {
      const view = await racksService.getRack({ branchId, rackId: rack._id });
      return res.json({ success: true, data: { kind: 'rack', code, rack: view }, meta: { branch } });
    }
    throw httpError(`Nothing found for "${code}" in ${branch.name}`, 404, { code: 'NOT_FOUND' });
  },

  // GET /api/locations/products?search=&limit=20
  async searchProducts(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const term = String(req.query.search || '').trim();
    if (!term) return res.json({ success: true, data: [], meta: { total: 0, branch } });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const products = await Product.find(productSearchFilter(term))
      .select(loc.WAREHOUSE_PRODUCT_FIELDS)
      .sort({ name: 1 })
      .limit(limit)
      .lean();
    const data = await unitsWithLocations(products, branchId);
    res.json({ success: true, data, meta: { total: data.length, branch } });
  },

  // GET /api/locations/products/:productId
  async product(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const product = await loadPlainProduct(requireProductId(req.params.productId));
    const units = await unitsWithLocations([product], branchId);
    res.json({
      success: true,
      data: {
        product: { _id: String(product._id), name: product.name, category: product.category || '', productType: product.productType, thumbnailUrl: product.thumbnailUrl || null },
        units,
      },
      meta: { branch },
    });
  },

  // GET /api/locations/warehouse?search=&category=&sort=name|qty|newest|oldest&page=&limit=
  async warehouse(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const q = req.query || {};
    const out = await loc.listWarehouse({ branchId, search: q.search, category: q.category, sort: q.sort, page: q.page, limit: q.limit });
    res.json({
      success: true,
      data: out.items.map((x) => ({ ...x, daysSinceReceived: daysSince(x.lastReceivedAt) })),
      meta: {
        page: out.page,
        limit: out.limit,
        total: out.total,
        pages: Math.max(1, Math.ceil(out.total / out.limit)),
        totalPieces: out.totalPieces,
        branch,
      },
    });
  },

  // GET /api/locations/activity?limit=20 — latest put-aways / moves in this branch
  async activity(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rows = await StockMovement.find({ branch: branchId, type: { $in: ['putaway', 'location_move'] } })
      .sort({ occurredAt: -1, _id: -1 })
      .limit(limit)
      .populate('user', 'firstName lastName')
      .lean();
    const data = rows.map((m) => ({
      _id: String(m._id),
      type: m.type,
      productId: String(m.product),
      variantId: m.variantId || null,
      name: m.productName,
      code: m.code,
      quantity: m.quantity,
      from: m.from && m.from.code,
      to: m.to && m.to.code,
      user: m.user ? [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') : '',
      note: m.note || '',
      occurredAt: m.occurredAt,
    }));
    res.json({ success: true, data, meta: { branch } });
  },

  // POST /api/locations/putaway
  //   { productId, variantId?, shelfId | shelfCode, qty, note? }
  //   or { lines: [ {...same} ] }  (each line on its own; result per line)
  async putaway(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const body = req.body || {};
    const userId = userIdOf(req);

    if (!Array.isArray(body.lines)) {
      const r = await putawayLine(branchId, body, userId);
      return res.status(201).json({ success: true, data: r, message: `${r.qty} piece(s) put on ${r.shelf.code}`, meta: { branch } });
    }

    if (!body.lines.length) throw httpError('Add at least one line');
    if (body.lines.length > MAX_LINES) throw httpError(`At most ${MAX_LINES} lines at a time`);
    const results = [];
    for (let i = 0; i < body.lines.length; i++) {
      try {
        results.push({ index: i, ok: true, ...(await putawayLine(branchId, body.lines[i] || {}, userId)) });
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        results.push({ index: i, ok: false, message: err.message, code: err.code || undefined, available: err.available });
      }
    }
    const done = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const pieces = done.reduce((s, r) => s + r.qty, 0);
    if (!done.length) {
      return res.status(400).json({ success: false, message: `Nothing was put away. Line 1: ${failed[0].message}`, data: { results, done: 0, failed: failed.length, pieces: 0 } });
    }
    return res.status(201).json({
      success: true,
      data: { results, done: done.length, failed: failed.length, pieces },
      message: `${pieces} piece(s) put away on ${done.length} line(s)${failed.length ? `, ${failed.length} line(s) failed` : ''}`,
      meta: { branch },
    });
  },

  // POST /api/locations/move
  //   { productId, variantId?, fromShelfId | fromShelfCode, toShelfId | toShelfCode | null (= warehouse), qty, note? }
  async move(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const b = req.body || {};
    const productId = requireProductId(b.productId);
    const qty = parseQty(b.qty);
    const from = await loc.findShelf({ branchId, shelfId: b.fromShelfId || null, shelfCode: b.fromShelfCode || null });
    const to = b.toShelfId || b.toShelfCode ? await loc.findShelf({ branchId, shelfId: b.toShelfId || null, shelfCode: b.toShelfCode || null }) : null;
    const r = await loc.moveStock({
      branchId,
      productId,
      variantId: variantOf(b.variantId),
      fromShelfId: from._id,
      toShelfId: to ? to._id : null,
      qty,
      userId: userIdOf(req),
      note: cleanNote(b.note),
    });
    const where = to ? to.code : 'the warehouse';
    res.json({
      success: true,
      data: { productId, variantId: variantOf(b.variantId), qty: r.qty, from: { _id: String(from._id), code: from.code }, to: to ? { _id: String(to._id), code: to.code } : null },
      message: `${r.qty} piece(s) moved from ${from.code} to ${where}`,
      meta: { branch },
    });
  },

  // POST /api/locations/home-shelf { productId, variantId?, shelfId | shelfCode, isHome = true }
  // A unit has one home shelf: marking a new one clears the old one.
  async homeShelf(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const b = req.body || {};
    const productId = requireProductId(b.productId);
    const isHome = b.isHome === undefined ? true : b.isHome === true || b.isHome === 'true' || b.isHome === 1;
    const shelf = await loc.findShelf({ branchId, shelfId: b.shelfId || null, shelfCode: b.shelfCode || null });
    const product = await loadPlainProduct(productId);
    const variantKey = loc.unitVariantKey(product, variantOf(b.variantId));
    if (product.productType === 'variant' && !variantKey) throw httpError('Choose a variant');
    await loc.setHomeShelf({ branchId, productId, variantId: variantKey, shelfId: shelf._id, isHome });
    if (isHome) await racksService.clearOtherHomeShelves({ branchId, productId, variantKey, keepShelfId: shelf._id });
    res.json({
      success: true,
      data: { productId, variantId: variantKey, shelf: { _id: String(shelf._id), code: shelf.code }, isHome },
      message: isHome ? `${shelf.code} is now the home shelf of ${product.name}` : `${shelf.code} is no longer the home shelf`,
      meta: { branch },
    });
  },
};

module.exports = locationsController;
