// productCodes.js — one place for all barcode / short-code / batch rules.
//
// Words used here:
//   "unit"      = something you can sell: a single product, or one variant.
//   shortCode   = small number (5 digits) the cashier can type by hand.
//                 It is also the barcode printed on stickers by default.
//   barcodes[]  = extra codes (maker's EAN, box label...). `qty` = pieces sold per scan.
//   batches[]   = received lots. If a unit has batches, its stock = sum of batch quantities.
//   piecesPerBox (product level) = pieces inside one box. Stock is always in pieces.
//   scanCodes   = every code of the product, uppercased, used for fast exact lookup.
//   branchStock = [{ branch, stock }] pieces per branch (each unit; for a variant
//                 product also the product-level sum per branch). Batches carry
//                 `branch`. Data without a branch belongs to the MAIN branch.
//                 See the "Branch stock" section below.
//
// Code formats generated here:
//   shortCode       "10245"
//   batch           "10245-1", "10245-2" (batchNo and its barcode)
//   full-box code   "10245-BOX"  (one scan sells piecesPerBox pieces)

const mongoose = require('mongoose');
const Product = require('../models/product');
const Branch = require('../models/branch');

const PRODUCT_UNIT = '__product__';

const parseMaybeJSON = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

const normalizeCode = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim().toUpperCase();
};

const toNumberOr = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Branch id as a string, or '' when missing/invalid (accepts ObjectId, string, {_id}).
const toBranchId = (value) => {
  if (value === undefined || value === null || value === '') return '';
  const raw = typeof value === 'object' && value._id ? value._id : value;
  const s = String(raw);
  return mongoose.Types.ObjectId.isValid(s) && /^[0-9a-fA-F]{24}$/.test(s) ? s : '';
};

const codeError = (message, extra = {}) => {
  const err = new Error(message);
  err.status = 409;
  err.code = 'DUPLICATE_CODE';
  Object.assign(err, extra);
  return err;
};

// Accepts ["123", {code:"456", qty:2}] or a JSON string of that. Dedupes by code.
const normalizeBarcodes = (input) => {
  const list = parseMaybeJSON(input);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const raw = typeof item === 'object' && item !== null ? item : { code: item };
    const code = normalizeCode(raw.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const qty = Math.max(1, Math.floor(toNumberOr(raw.qty, 1)));
    out.push({ code, qty, label: raw.label ? String(raw.label).trim() : '' });
  }
  return out;
};

// Accepts [{batchNo?, barcode?, quantity, costPrice?, expiryDate?, ...}].
// Missing batchNo/barcode are filled later by fillUnitCodes (needs the shortCode).
const normalizeBatches = (input) => {
  const list = parseMaybeJSON(input);
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      const quantity = Math.max(0, Math.floor(toNumberOr(b.quantity, 0)));
      const initialQuantity = Math.max(quantity, Math.floor(toNumberOr(b.initialQuantity, quantity)));
      const costPrice = toNumberOr(b.costPrice, undefined);
      const expiry = b.expiryDate ? new Date(b.expiryDate) : undefined;
      const received = b.receivedAt ? new Date(b.receivedAt) : undefined;
      const out = {
        batchNo: normalizeCode(b.batchNo) || undefined,
        barcode: normalizeCode(b.barcode) || undefined,
        quantity,
        initialQuantity,
        costPrice: costPrice !== undefined && costPrice >= 0 ? costPrice : undefined,
        expiryDate: expiry && !isNaN(expiry) ? expiry : undefined,
        receivedAt: received && !isNaN(received) ? received : new Date(),
        note: b.note ? String(b.note).trim() : '',
      };
      if (b._id) out._id = b._id;
      const branch = toBranchId(b.branch);
      if (branch) out.branch = branch;
      return out;
    });
};

// {Storage:"128GB"} or [{name:"Storage", value:"128GB"}] -> plain object, or undefined.
const normalizeAttributes = (input) => {
  let attrs = parseMaybeJSON(input);
  if (!attrs) return undefined;
  if (attrs instanceof Map) attrs = Object.fromEntries(attrs);
  if (Array.isArray(attrs)) {
    attrs = attrs.reduce((acc, a) => {
      if (a && a.name) acc[String(a.name).trim()] = String(a.value ?? '').trim();
      return acc;
    }, {});
  }
  if (typeof attrs !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    // Mongo map keys cannot contain "." or start with "$"
    const key = String(k).trim().replace(/\./g, '_').replace(/^\$/, '');
    const val = v === undefined || v === null ? '' : String(v).trim();
    if (key && val) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
};

// Human label for a variant: "Black / 128GB / L"
const variantLabel = (variant) => {
  if (!variant) return '';
  const parts = [];
  if (variant.color) parts.push(variant.color);
  if (variant.size) parts.push(variant.size);
  let attrs = variant.attributes;
  if (attrs instanceof Map) attrs = Object.fromEntries(attrs);
  if (attrs && typeof attrs === 'object') parts.push(...Object.values(attrs).filter(Boolean));
  return parts.join(' / ');
};

// Sellable units of a product: [{ key, variant|null, unit }]
const listUnits = (product) => {
  if (product.productType === 'variant') {
    return (product.variants || []).map((v) => ({ key: v.variantId, variant: v, unit: v }));
  }
  return [{ key: PRODUCT_UNIT, variant: null, unit: product }];
};

// Every code of one unit with what it means.
const unitCodes = (unit) => {
  const codes = [];
  if (unit.sku) codes.push({ code: normalizeCode(unit.sku), kind: 'sku', qty: 1 });
  if (unit.shortCode) codes.push({ code: normalizeCode(unit.shortCode), kind: 'shortCode', qty: 1 });
  for (const b of unit.barcodes || []) {
    if (b && b.code) codes.push({ code: normalizeCode(b.code), kind: 'barcode', qty: Math.max(1, Number(b.qty) || 1) });
  }
  for (const batch of unit.batches || []) {
    if (batch && batch.barcode) {
      codes.push({ code: normalizeCode(batch.barcode), kind: 'batch', qty: 1, batchNo: normalizeCode(batch.batchNo) });
    }
  }
  return codes.filter((c) => c.code);
};

const buildScanCodes = (product) => {
  const set = new Set();
  for (const { unit } of listUnits(product)) {
    for (const c of unitCodes(unit)) set.add(c.code);
  }
  return [...set];
};

// Given a product doc and the scanned/typed code, say what it means.
// Returns { variant, variantId, batchNo, qty, kind, code } or null.
const resolveScan = (product, rawCode) => {
  const code = normalizeCode(rawCode);
  if (!code || !product) return null;
  for (const { key, variant, unit } of listUnits(product)) {
    const hit = unitCodes(unit).find((c) => c.code === code);
    if (hit) {
      return {
        variant: variant || null,
        variantId: key === PRODUCT_UNIT ? null : key,
        batchNo: hit.batchNo || null,
        qty: hit.qty,
        kind: hit.kind,
        code,
      };
    }
  }
  return null;
};

// Find the product for a scanned/typed code. Exact match on scanCodes first,
// then the old behaviour (variant SKU / product SKU / slug) for products that
// have not been backfilled yet.
const findProductByCode = async (rawCode, extraFilter = {}) => {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  let product = await Product.findOne({ ...extraFilter, scanCodes: code });
  if (!product) {
    const rx = new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    product = await Product.findOne({
      ...extraFilter,
      $or: [{ 'variants.sku': rx }, { sku: rx }, { slug: rx }],
    });
  }
  if (!product) return null;
  const match = resolveScan(product, code) || { variant: null, variantId: null, batchNo: null, qty: 1, kind: 'slug', code };
  return { product, match };
};

// Is this code used by another product?
const isCodeTaken = async (code, excludeId) => {
  const filter = { scanCodes: normalizeCode(code) };
  if (excludeId) filter._id = { $ne: excludeId };
  return !!(await Product.exists(filter));
};

// New 5-digit short code not in `taken` and not in the database.
// Falls back to 6 digits if 5-digit space looks crowded.
const generateShortCode = async (taken = new Set(), excludeId = null) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const digits = attempt < 25 ? 5 : 6;
    const min = 10 ** (digits - 1);
    const code = String(min + Math.floor(Math.random() * 9 * min));
    if (taken.has(code)) continue;
    if (await isCodeTaken(code, excludeId)) continue;
    taken.add(code);
    return code;
  }
  throw new Error('Could not generate a unique short code, please try again');
};

// Fill shortCode, batch numbers/barcodes, full-box code for one unit.
// Batches without a branch get `defaultBranchId` (falls back to mainBranchId).
const fillUnitCodes = async (unit, { taken, excludeId, piecesPerBox, addFullBoxBarcode, defaultBranchId, mainBranchId }) => {
  unit.shortCode = normalizeCode(unit.shortCode) || (await generateShortCode(taken, excludeId));
  taken.add(unit.shortCode);

  unit.barcodes = normalizeBarcodes(unit.barcodes);
  const fullBoxCode = `${unit.shortCode}-BOX`;
  // Keep an existing full-box code in sync with the current box size.
  unit.barcodes = unit.barcodes.map((b) =>
    b.code === fullBoxCode ? { ...b, qty: Math.max(1, piecesPerBox), label: 'full-box' } : b
  );
  if (addFullBoxBarcode && piecesPerBox > 1 && !unit.barcodes.some((b) => b.code === fullBoxCode)) {
    unit.barcodes.push({ code: fullBoxCode, qty: piecesPerBox, label: 'full-box' });
  }
  if (piecesPerBox <= 1) {
    unit.barcodes = unit.barcodes.filter((b) => b.code !== fullBoxCode);
  }

  unit.batches = normalizeBatches(unit.batches);
  const usedBatchNos = new Set(unit.batches.map((b) => b.batchNo).filter(Boolean));
  let n = 1;
  for (const batch of unit.batches) {
    if (!batch.batchNo) {
      while (usedBatchNos.has(`${unit.shortCode}-${n}`)) n++;
      batch.batchNo = `${unit.shortCode}-${n}`;
      usedBatchNos.add(batch.batchNo);
    }
    if (!batch.barcode) batch.barcode = batch.batchNo;
  }
  const fallbackBranch = toBranchId(defaultBranchId) || toBranchId(mainBranchId);
  for (const batch of unit.batches) {
    if (!batch.branch && fallbackBranch) batch.branch = fallbackBranch;
  }
  checkUnitBatches(unit);
  if (unit.batches.length) {
    unit.stock = unit.batches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
  }
};

// One lot may live in several branches (after a transfer) as one batch per
// branch with the SAME batchNo + barcode. Not allowed: the same batchNo twice
// in one branch, or one batchNo with two different barcodes (and vice versa).
const checkUnitBatches = (unit) => {
  const seen = new Set();
  const codeOfNo = new Map();
  const noOfCode = new Map();
  for (const b of unit.batches || []) {
    const no = normalizeCode(b.batchNo);
    const code = normalizeCode(b.barcode) || no;
    const key = `${no}|${toBranchId(b.branch)}`;
    if (seen.has(key)) {
      throw codeError(`Batch "${no}" is listed twice for the same branch`, { duplicateCode: no });
    }
    seen.add(key);
    if (codeOfNo.has(no) && codeOfNo.get(no) !== code) {
      throw codeError(`Batch "${no}" must use the same barcode in every branch`, { duplicateCode: code });
    }
    if (noOfCode.has(code) && noOfCode.get(code) !== no) {
      throw codeError(`Code "${code}" is used by two different batches`, { duplicateCode: code });
    }
    codeOfNo.set(no, code);
    noOfCode.set(code, no);
  }
};

/**
 * Prepare all codes on a plain product object before create/update.
 * Mutates and returns `doc`. Needs on doc: productType, variants (if variant),
 * sku/shortCode/barcodes/batches (if single), piecesPerBox, stock.
 *
 * - generates missing short codes / batch numbers
 * - adds "<shortCode>-BOX" when opts.addFullBoxBarcode and piecesPerBox > 1
 * - stock = sum of batches when a unit has batches; variant product stock = sum of variants
 * - branches: batches / units without a branch get opts.defaultBranchId (default:
 *   main branch); branchStock recomputed (syncProductBranchStock)
 * - sets doc.scanCodes
 * opts: { excludeId, addFullBoxBarcode, allowExistingCodes, mainBranchId, defaultBranchId }
 * - throws (status 409, code DUPLICATE_CODE) if a code is used twice in this
 *   product or by another product
 */
const prepareProductCodes = async (doc, opts = {}) => {
  const excludeId = opts.excludeId || null;
  // Branch of new stock (batches / units without a branch). Default: main branch.
  const mainBranchId = toBranchId(opts.mainBranchId) || (await getMainBranchId());
  const defaultBranchId = toBranchId(opts.defaultBranchId) || mainBranchId;
  const taken = new Set();
  doc.piecesPerBox = Math.max(1, Math.floor(toNumberOr(doc.piecesPerBox, 1)));

  // Reserve codes the user typed so generated ones never clash with them.
  for (const { unit } of listUnits(doc)) {
    if (unit.shortCode) {
      const sc = normalizeCode(unit.shortCode);
      // Short codes are typed by hand at the counter: digits only.
      if (!/^\d{3,8}$/.test(sc)) {
        const err = new Error(`Short code "${sc}" must be 3 to 8 digits`);
        err.status = 400;
        err.code = 'INVALID_SHORT_CODE';
        throw err;
      }
      taken.add(sc);
    }
    if (unit.sku) taken.add(normalizeCode(unit.sku));
    for (const b of normalizeBarcodes(unit.barcodes)) taken.add(b.code);
  }

  for (const { unit } of listUnits(doc)) {
    await fillUnitCodes(unit, {
      taken,
      excludeId,
      piecesPerBox: doc.piecesPerBox,
      addFullBoxBarcode: !!opts.addFullBoxBarcode,
      defaultBranchId,
      mainBranchId,
    });
  }

  if (doc.productType === 'variant') {
    // Product-level code fields are not used for variant products.
    doc.shortCode = undefined;
    doc.barcodes = [];
    doc.batches = [];
  }
  // Per-branch stock + totals (variant product stock = sum of variants).
  syncProductBranchStock(doc, { mainBranchId, defaultBranchId });

  // Same code on two different units of this product?
  const owner = new Map();
  for (const { key, unit } of listUnits(doc)) {
    for (const c of unitCodes(unit)) {
      const prev = owner.get(c.code);
      if (prev !== undefined && prev !== key) {
        throw codeError(`Code "${c.code}" is used on more than one variant of this product`, { duplicateCode: c.code });
      }
      owner.set(c.code, key);
    }
  }

  doc.scanCodes = buildScanCodes(doc);

  // Used by another product? Codes this product already had before the edit
  // (opts.allowExistingCodes) are not re-checked, so old data that shares a
  // SKU can still be edited. New codes must be unique.
  const allowed = new Set((opts.allowExistingCodes || []).map(normalizeCode));
  const toCheck = doc.scanCodes.filter((c) => !allowed.has(c));
  if (toCheck.length) {
    const filter = { scanCodes: { $in: toCheck } };
    if (excludeId) filter._id = { $ne: excludeId };
    const clash = await Product.findOne(filter, { name: 1, scanCodes: 1 }).lean();
    if (clash) {
      const dup = toCheck.find((c) => (clash.scanCodes || []).includes(c));
      throw codeError(`Code "${dup}" is already used by product "${clash.name}"`, {
        duplicateCode: dup,
        conflictProductId: clash._id,
      });
    }
  }

  return doc;
};

// Batches in the order they should be sold: earliest expiry first, then oldest received.
const sortBatchesForSale = (batches) =>
  [...(batches || [])].sort((a, b) => {
    const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
    const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
    if (ea !== eb) return ea - eb;
    return new Date(a.receivedAt || 0).getTime() - new Date(b.receivedAt || 0).getTime();
  });

// ===================================================================
// Branch stock
// ===================================================================
// Every unit has `branchStock: [{ branch, stock }]`, every batch has `branch`.
// Invariants after a write:
//   unit with batches:    branchStock[b] = sum(batch.quantity of branch b); stock = sum of all batches
//   unit without batches: stock = sum(branchStock)
//   variant product:      stock = sum(variant.stock) (TOTAL); branchStock[b] = sum of variants' branchStock[b]
// Old data (no branchStock / batch without branch) belongs to the MAIN branch,
// which is why most helpers take `mainBranchId`.

const MAIN_TTL_MS = 60 * 1000;
let mainCache = { at: 0, id: null };

// Main branch id (string), cached 60s. Creates "Main Branch" if none exists.
const getMainBranchId = async () => {
  if (mainCache.id && Date.now() - mainCache.at < MAIN_TTL_MS) return mainCache.id;
  const main = await Branch.getMain();
  mainCache = { at: Date.now(), id: main ? String(main._id) : null };
  return mainCache.id;
};

// Call after the main branch changes (branchController.setMain).
const clearMainBranchCache = () => {
  mainCache = { at: 0, id: null };
};

const sameBranch = (a, b) => {
  const x = toBranchId(a);
  return !!x && x === toBranchId(b);
};

const hasBatches = (unit) => !!unit && Array.isArray(unit.batches) && unit.batches.length > 0;

const pieces = (n) => Math.max(0, Math.floor(Number(n) || 0));

// Branch holding a batch ('' when unknown and no mainBranchId given).
const batchBranchId = (batch, mainBranchId) => toBranchId(batch && batch.branch) || toBranchId(mainBranchId);

// Total pieces of a unit over all branches.
const unitTotalStock = (unit) => {
  if (!unit) return 0;
  if (hasBatches(unit)) return unit.batches.reduce((s, b) => s + pieces(b && b.quantity), 0);
  return pieces(unit.stock);
};

// Rows -> merged by branch, ids as strings, stock >= 0. Keeps first-seen order.
const mergeRows = (rows) => {
  const map = new Map();
  for (const r of rows || []) {
    const id = toBranchId(r && r.branch);
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + pieces(r.stock));
  }
  return [...map].map(([branch, stock]) => ({ branch, stock }));
};

/**
 * Effective per-branch stock of one unit: [{ branch: '<id>', stock }].
 * Batches decide when present; else branchStock; else (not migrated) all of
 * unit.stock is in the main branch.
 */
const unitBranchRows = (unit, mainBranchId) => {
  if (!unit) return [];
  if (hasBatches(unit)) {
    return mergeRows(unit.batches.map((b) => ({ branch: batchBranchId(b, mainBranchId), stock: b && b.quantity })));
  }
  if (Array.isArray(unit.branchStock) && unit.branchStock.length) return mergeRows(unit.branchStock);
  const stock = pieces(unit.stock);
  const main = toBranchId(mainBranchId);
  return main && stock > 0 ? [{ branch: main, stock }] : [];
};

// Pieces of a unit in one branch. branchId null -> total of all branches.
const unitBranchStock = (unit, branchId, mainBranchId) => {
  if (!unit) return 0;
  if (!toBranchId(branchId)) return unitTotalStock(unit);
  const row = unitBranchRows(unit, mainBranchId).find((r) => sameBranch(r.branch, branchId));
  return row ? row.stock : 0;
};

// Per-branch totals of a whole product (sum over its units).
const productBranchRows = (product, mainBranchId) => {
  if (!product) return [];
  return mergeRows(listUnits(product).flatMap(({ unit }) => unitBranchRows(unit, mainBranchId)));
};

// Pieces of a product in one branch (all units). branchId null -> product.stock.
const productBranchStock = (product, branchId, mainBranchId) => {
  if (!product) return 0;
  if (!toBranchId(branchId)) return pieces(product.stock);
  return listUnits(product).reduce((s, { unit }) => s + unitBranchStock(unit, branchId, mainBranchId), 0);
};

/**
 * Make one unit follow the invariants (mutates, returns unit):
 * - batches without branch -> defaultBranchId || mainBranchId
 * - unit with batches: branchStock from batches, stock = sum
 * - unit without batches: branchStock kept (missing -> all stock in
 *   defaultBranchId || mainBranchId), stock = sum(branchStock)
 * branchStock rows / batch.branch hold ids as strings (Mongoose casts them on save).
 */
const syncUnitBranchStock = (unit, { mainBranchId, defaultBranchId } = {}) => {
  if (!unit) return unit;
  const fallback = toBranchId(defaultBranchId) || toBranchId(mainBranchId);
  if (hasBatches(unit)) {
    for (const b of unit.batches) {
      if (!b) continue;
      const id = toBranchId(b.branch);
      if (id) b.branch = id;
      else if (fallback) b.branch = fallback;
    }
    unit.branchStock = unitBranchRows(unit, fallback);
    unit.stock = unitTotalStock(unit);
    return unit;
  }
  if (!Array.isArray(unit.batches)) unit.batches = [];
  if (Array.isArray(unit.branchStock) && unit.branchStock.length) {
    unit.branchStock = mergeRows(unit.branchStock);
  } else {
    const stock = pieces(unit.stock);
    unit.branchStock = fallback && stock > 0 ? [{ branch: fallback, stock }] : [];
  }
  unit.stock = unit.branchStock.reduce((s, r) => s + r.stock, 0);
  return unit;
};

/**
 * syncUnitBranchStock for every unit, then product totals:
 * variant product -> stock = sum(variant.stock), branchStock = per-branch sum.
 * This is also THE migration step for old products (pass mainBranchId only).
 */
const syncProductBranchStock = (product, opts = {}) => {
  if (!product) return product;
  if (product.productType === 'variant') {
    for (const v of product.variants || []) syncUnitBranchStock(v, opts);
    product.stock = (product.variants || []).reduce((s, v) => s + pieces(v.stock), 0);
    product.branchStock = mergeRows((product.variants || []).flatMap((v) => v.branchStock || []));
  } else {
    syncUnitBranchStock(product, opts);
  }
  return product;
};

// Plain object copy of a product (mongoose doc or lean object), Maps flattened.
const toPlainProduct = (product) => {
  if (!product) return product;
  if (typeof product.toObject === 'function') return product.toObject({ flattenMaps: true });
  return { ...product };
};

/**
 * The product as seen from one branch (POS / admin listings):
 *   stock, variants[i].stock -> pieces in `branchId`
 *   batches (product / variant) -> only that branch's batches (each with `branch`)
 *   branchStock (product / variant) -> effective rows [{ branch, stock }] of all branches
 *   totalStock (product / variant) -> all branches
 *   stockBranch -> branchId (null = all branches)
 * branchId null -> stock stays the total and all batches are kept.
 * opts.restrict (branch staff): branchStock only for `branchId`, no totalStock.
 * Does not mutate the input.
 */
const withBranchStock = (product, branchId, mainBranchId, opts = {}) => {
  if (!product) return product;
  const restrict = !!opts.restrict;
  const branch = toBranchId(branchId) || null;
  const p = toPlainProduct(product);

  const viewUnit = (unit) => {
    const rows = unitBranchRows(unit, mainBranchId);
    const out = { ...unit };
    out.totalStock = unitTotalStock(unit);
    out.branchStock = rows;
    out.batches = (Array.isArray(unit.batches) ? unit.batches : []).map((b) => ({
      ...b,
      branch: batchBranchId(b, mainBranchId) || null,
    }));
    if (branch || restrict) {
      out.stock = branch ? unitBranchStock(unit, branch, mainBranchId) : 0;
      out.batches = out.batches.filter((b) => branch && sameBranch(b.branch, branch));
    }
    if (restrict) {
      out.branchStock = rows.filter((r) => branch && sameBranch(r.branch, branch));
      delete out.totalStock;
    }
    return out;
  };

  const total = pieces(p.stock);
  if (p.productType === 'variant') {
    const rows = productBranchRows(p, mainBranchId); // before batches get filtered
    p.variants = (p.variants || []).map(viewUnit);
    p.branchStock = restrict ? rows.filter((r) => branch && sameBranch(r.branch, branch)) : rows;
    if (branch || restrict) p.stock = p.variants.reduce((s, v) => s + pieces(v.stock), 0);
    if (Array.isArray(p.batches)) p.batches = [];
  } else {
    Object.assign(p, viewUnit(p));
  }
  if (restrict) delete p.totalStock;
  else p.totalStock = total;
  p.stockBranch = branch;
  return p;
};

const toObjectId = (id) => new mongoose.Types.ObjectId(toBranchId(id));

// Products never written since branches arrived: all their stock is main-branch stock.
const legacyStockClause = (cond) => ({
  stock: cond,
  'branchStock.0': { $exists: false },
  'variants.branchStock.0': { $exists: false },
});

/**
 * Mongo filter: products with stock > 0 in `branchId`.
 * Pass mainBranchId so old (not migrated) products count for the main branch.
 * branchId null -> { stock: { $gt: 0 } } (total).
 */
const branchStockQuery = (branchId, mainBranchId) => {
  if (!toBranchId(branchId)) return { stock: { $gt: 0 } };
  const branch = toObjectId(branchId);
  const or = [
    { branchStock: { $elemMatch: { branch, stock: { $gt: 0 } } } },
    { 'variants.branchStock': { $elemMatch: { branch, stock: { $gt: 0 } } } },
  ];
  if (mainBranchId && sameBranch(branchId, mainBranchId)) or.push(legacyStockClause({ $gt: 0 }));
  return { $or: or };
};

/**
 * Mongo filter for a stock level in one branch (product-level stock):
 *   'in' (> 0), 'low' (1..threshold), 'out' (0 / none).
 * branchId null -> same levels on the total `stock`.
 */
const branchStockLevelQuery = (branchId, mainBranchId, level, threshold = 5) => {
  const t = Math.max(1, Number(threshold) || 5);
  if (!toBranchId(branchId)) {
    if (level === 'low') return { stock: { $gt: 0, $lte: t } };
    if (level === 'out') return { stock: { $lte: 0 } };
    return { stock: { $gt: 0 } };
  }
  if (level === 'out') return { $nor: [branchStockQuery(branchId, mainBranchId)] };
  if (level === 'low') {
    const branch = toObjectId(branchId);
    const or = [{ branchStock: { $elemMatch: { branch, stock: { $gt: 0, $lte: t } } } }];
    if (mainBranchId && sameBranch(branchId, mainBranchId)) or.push(legacyStockClause({ $gt: 0, $lte: t }));
    return { $or: or };
  }
  return branchStockQuery(branchId, mainBranchId);
};

module.exports = {
  PRODUCT_UNIT,
  parseMaybeJSON,
  normalizeCode,
  normalizeBarcodes,
  normalizeBatches,
  normalizeAttributes,
  variantLabel,
  listUnits,
  unitCodes,
  buildScanCodes,
  resolveScan,
  findProductByCode,
  isCodeTaken,
  generateShortCode,
  prepareProductCodes,
  sortBatchesForSale,
  checkUnitBatches,
  // branch stock
  toBranchId,
  sameBranch,
  getMainBranchId,
  clearMainBranchCache,
  batchBranchId,
  unitTotalStock,
  unitBranchRows,
  unitBranchStock,
  productBranchRows,
  productBranchStock,
  syncUnitBranchStock,
  syncProductBranchStock,
  withBranchStock,
  branchStockQuery,
  branchStockLevelQuery,
};
