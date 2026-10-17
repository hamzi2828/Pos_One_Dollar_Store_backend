// stockService.js — every stock change (sale, return, receiving, branch transfer) goes through here.
//
// Stock is always counted in pieces. A "unit" is a single product or one variant.
// If a unit has batches, its stock = sum of the batches' `quantity`, and sales
// take pieces out of batches (scanned batch first, then earliest expiry /
// oldest received — see sortBatchesForSale).
//
// Branches: every unit has `branchStock: [{ branch, stock }]` and every batch a
// `branch`. Each function works on ONE branch (`branchId`); a missing branchId
// means the main branch. Old data without branch info is the main branch's and
// is converted on the first write (syncUnitBranchStock). Every write keeps the
// invariants of helper/productCodes.js (unit stock, product total, branchStock,
// batch.branch) in ONE guarded update.
//
// Safe against two counters selling the same item at once WITHOUT transactions
// (the DB may not be a replica set): optimistic locking on `updatedAt`.
//   1. load the product
//   2. compute the new state in memory
//   3. Product.updateOne({ _id, updatedAt: <loaded> }, { $set: ... })
//   4. nobody matched => someone else changed it in between => reload and retry

const mongoose = require('mongoose');
const Product = require('../models/product');
const Branch = require('../models/branch');
const {
  PRODUCT_UNIT,
  normalizeCode,
  normalizeBatches,
  variantLabel,
  buildScanCodes,
  isCodeTaken,
  generateShortCode,
  sortBatchesForSale,
  toBranchId,
  sameBranch,
  getMainBranchId,
  unitTotalStock,
  unitBranchStock,
  productBranchRows,
  syncUnitBranchStock,
} = require('../helper/productCodes');

const MAX_ATTEMPTS = 5;

const stockError = (message, status = 400, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  err.isStockError = true;
  Object.assign(err, extra);
  return err;
};

const toInt = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

const idStr = (id) => (id === undefined || id === null ? '' : String(id));

/**
 * Pieces of a unit available in a branch. branchId null -> all branches
 * (old behaviour). Pass mainBranchId so un-migrated data counts as main.
 */
const unitAvailable = (unit, branchId, mainBranchId) => unitBranchStock(unit, branchId || null, mainBranchId);

// ---------- branch names (for error messages), cached 5 min ----------
const NAME_TTL_MS = 5 * 60 * 1000;
const nameCache = new Map(); // id -> { at, name }

const branchName = async (branchId) => {
  const id = toBranchId(branchId);
  if (!id) return 'this branch';
  const hit = nameCache.get(id);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  let name = null;
  try {
    let q = Branch.findById(id);
    if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
    if (q && typeof q.select === 'function') q = q.select('name code');
    if (q && typeof q.lean === 'function') q = q.lean();
    const b = await q;
    name = b && b.name ? String(b.name) : null;
  } catch (_) {
    /* fall through */
  }
  if (!name) return 'this branch';
  nameCache.set(id, { at: Date.now(), name });
  return name;
};

const clearBranchNameCache = () => nameCache.clear();

// Branch to work on: the given one (must be a valid id) or the main branch.
const resolveBranch = async (branchId, label = 'branchId') => {
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    const id = toBranchId(branchId);
    if (!id) throw stockError(`Invalid ${label}`, 400, { code: 'INVALID_BRANCH' });
    return id;
  }
  const main = await getMainBranchId();
  if (!main) throw stockError('No branch found. Create a branch first.', 400, { code: 'INVALID_BRANCH' });
  return main;
};

const loadProduct = (productId, { withDeleted = false } = {}) => {
  let q = Product.findById(productId);
  if (withDeleted && q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  return q && typeof q.lean === 'function' ? q.lean() : q;
};

const invalidateProductCache = () => {
  try {
    const { invalidate } = require('../middleware/cache');
    [
      'products:featured',
      'products:by-make',
      'products:by-model',
      'categories:featured-with-products',
      'car-makes:stats',
      'car-models:by-make',
    ].forEach((tag) => Promise.resolve(invalidate(tag)).catch(() => {}));
  } catch (_) {
    /* noop */
  }
};

// Which unit of `product` is meant. Returns { unit, index, variant } where
// index is the position in product.variants (-1 for a single product).
// `required=false` returns null instead of throwing when not found.
const pickUnit = (product, variantId, { required = true } = {}) => {
  if (product.productType === 'variant') {
    const variants = product.variants || [];
    let index = -1;
    if (variantId) {
      index = variants.findIndex((v) => idStr(v.variantId) === idStr(variantId));
      // also accept the variant's Mongo _id
      if (index === -1) index = variants.findIndex((v) => idStr(v._id) === idStr(variantId));
    } else if (variants.length === 1) {
      index = 0;
    }
    if (index === -1) {
      if (!required) return null;
      if (variantId) throw stockError(`Variant ${variantId} not found for ${product.name}`, 404);
      throw stockError(`Please choose a variant of ${product.name}`, 400);
    }
    return { unit: variants[index], index, variant: variants[index] };
  }
  return { unit: product, index: -1, variant: null };
};

const unitName = (product, variant) => {
  const label = variant ? variantLabel(variant) : '';
  return label ? `${product.name} (${label})` : product.name;
};

// Row of unit.branchStock for a branch (created when missing). Unit must be synced.
const branchRow = (unit, branchId) => {
  unit.branchStock = unit.branchStock || [];
  let row = unit.branchStock.find((r) => sameBranch(r.branch, branchId));
  if (!row) {
    row = { branch: toBranchId(branchId), stock: 0 };
    unit.branchStock.push(row);
  }
  return row;
};

const batchesIn = (unit, branchId) => (unit.batches || []).filter((b) => sameBranch(b.branch, branchId));

/**
 * The batch of `branchId` that holds the same lot as `template` (same batchNo).
 * Created when missing, with the same batchNo / barcode / cost / expiry, so the
 * printed sticker scans in every branch.
 */
const branchBatchFor = (unit, template, branchId, note) => {
  const no = normalizeCode(template.batchNo);
  let target = (unit.batches || []).find((b) => normalizeCode(b.batchNo) === no && sameBranch(b.branch, branchId));
  if (target) return { batch: target, created: false };
  target = {
    _id: new mongoose.Types.ObjectId(),
    batchNo: no,
    barcode: normalizeCode(template.barcode) || no,
    quantity: 0,
    initialQuantity: 0,
    receivedAt: template.receivedAt ? new Date(template.receivedAt) : new Date(),
    note: note || '',
    branch: toBranchId(branchId),
  };
  if (template.costPrice !== undefined && template.costPrice !== null) target.costPrice = template.costPrice;
  if (template.expiryDate) target.expiryDate = new Date(template.expiryDate);
  unit.batches.push(target);
  return { batch: target, created: true };
};

// After changing a unit: recompute unit stock / branchStock, product total,
// product branchStock (variant products) and status.
const recompute = (product, unit, { allowRepublish, mainBranchId }) => {
  syncUnitBranchStock(unit, { mainBranchId });
  if (product.productType === 'variant') {
    product.stock = (product.variants || []).reduce((s, v) => s + unitTotalStock(v), 0);
    product.branchStock = productBranchRows(product, mainBranchId);
  }
  product.stock = Math.max(0, Number(product.stock) || 0);
  if (product.stock === 0) {
    product.status = 'out_of_stock';
  } else if (allowRepublish && product.status === 'out_of_stock') {
    product.status = 'published';
  }
};

// $set for the changed unit + product-level stock fields.
const buildSet = (product, index, unit, extra = {}) => {
  const set = { stock: product.stock, status: product.status, branchStock: product.branchStock || [], ...extra };
  if (index === -1) {
    set.batches = unit.batches || [];
  } else {
    set[`variants.${index}.stock`] = unit.stock;
    set[`variants.${index}.batches`] = unit.batches || [];
    set[`variants.${index}.branchStock`] = unit.branchStock || [];
  }
  return set;
};

/**
 * Load → mutate(product) → guarded write, retried on concurrent change.
 * `mutate` gets a fresh plain product each attempt and returns
 * { set, result } (set = $set object) or throws.
 */
const withOptimisticLock = async (productId, mutate, { withDeleted = false } = {}) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const product = await loadProduct(productId, { withDeleted });
    if (!product) throw stockError(`Product not found: ${productId}`, 404);

    const { set, result } = await mutate(product);

    const loadedAt = product.updatedAt ? new Date(product.updatedAt) : null;
    // Always move updatedAt forward, even if two writes land in the same ms.
    const nextAt = new Date(Math.max(Date.now(), loadedAt ? loadedAt.getTime() + 1 : 0));
    const options = { timestamps: false };
    if (withDeleted) options.withDeleted = true;

    const res = await Product.updateOne(
      { _id: product._id, updatedAt: loadedAt },
      { $set: { ...set, updatedAt: nextAt } },
      options
    );
    const matched = res && (res.matchedCount !== undefined ? res.matchedCount : res.n);
    if (matched > 0) {
      product.updatedAt = nextAt;
      invalidateProductCache();
      return { ...result, product };
    }
    // Someone else changed this product between our read and write — retry.
  }
  throw stockError('This product is being updated by another sale right now. Please try again.', 409, {
    code: 'STOCK_CONFLICT',
  });
};

const insufficient = async (product, variant, branchId, available, requested) =>
  stockError(
    `Insufficient stock for ${unitName(product, variant)} in ${await branchName(branchId)}. Available: ${available}, Requested: ${requested}`,
    400,
    { code: 'INSUFFICIENT_STOCK', available, requested, branchId: toBranchId(branchId) }
  );

/**
 * Take `quantity` pieces out of a unit in ONE branch (its plain stock or its
 * batches — the scanned batch of that branch first).
 * Returns { allocations: [{batchNo, quantity}], product, branchId }.
 * Throws 400 when the branch has not enough, 404 when product/variant missing.
 */
const deductStock = async ({ productId, variantId, quantity, batchNo, branchId }) => {
  const qty = toInt(quantity, 0);
  if (qty <= 0) throw stockError('Quantity must be at least 1', 400);
  const wantedBatch = normalizeCode(batchNo);
  const mainBranchId = await getMainBranchId();
  const branch = await resolveBranch(branchId);

  return withOptimisticLock(productId, async (product) => {
    const { unit, index, variant } = pickUnit(product, variantId);
    syncUnitBranchStock(unit, { mainBranchId });
    const available = unitBranchStock(unit, branch, mainBranchId);
    if (available < qty) throw await insufficient(product, variant, branch, available, qty);

    const allocations = [];
    if (unit.batches && unit.batches.length) {
      const here = batchesIn(unit, branch);
      const first = wantedBatch ? here.find((b) => normalizeCode(b.batchNo) === wantedBatch) : null;
      const order = [...(first ? [first] : []), ...sortBatchesForSale(here.filter((b) => b !== first))];
      let remaining = qty;
      for (const b of order) {
        if (remaining <= 0) break;
        const have = Math.max(0, Number(b.quantity) || 0);
        if (!have) continue;
        const take = Math.min(have, remaining);
        b.quantity = have - take;
        remaining -= take;
        allocations.push({ batchNo: b.batchNo, quantity: take });
      }
    } else {
      const row = branchRow(unit, branch);
      row.stock = Math.max(0, (Number(row.stock) || 0) - qty);
    }

    recompute(product, unit, { allowRepublish: false, mainBranchId });
    return { set: buildSet(product, index, unit), result: { allocations, branchId: branch } };
  });
};

/**
 * Put pieces back into ONE branch (order deleted / refunded / failed to save).
 * Pieces go back into that branch's batches with the same batchNo; if the
 * branch no longer has that batch, it is re-created there (same batchNo and
 * barcode). Unknown batch → first batch of the branch (or a copy of the unit's
 * first batch); plain stock when the unit has no batches.
 * Works on soft-deleted products too. Returns { product, restored, branchId } or
 * { product: null, restored: 0, skipped: reason } when the unit is gone.
 */
const restoreStock = async ({ productId, variantId, quantity, allocations, branchId }) => {
  const qty = toInt(quantity, 0);
  const allocs = (allocations || [])
    .map((a) => ({ batchNo: normalizeCode(a && a.batchNo), quantity: Math.max(0, toInt(a && a.quantity, 0)) }))
    .filter((a) => a.quantity > 0);
  const allocated = allocs.reduce((s, a) => s + a.quantity, 0);
  const total = Math.max(qty, allocated);
  if (total <= 0) return { product: null, restored: 0 };
  const mainBranchId = await getMainBranchId();
  const branch = await resolveBranch(branchId);

  try {
    return await withOptimisticLock(
      productId,
      (product) => {
        const picked = pickUnit(product, variantId, { required: false });
        if (!picked) {
          const err = stockError(
            variantId
              ? `Variant ${variantId} no longer exists on ${product.name}`
              : `No variant given for ${product.name}; cannot tell where to put stock back`,
            404
          );
          err.skip = true;
          throw err;
        }
        const { unit, index } = picked;
        syncUnitBranchStock(unit, { mainBranchId });
        const batches = unit.batches || [];
        if (batches.length) {
          let fallback = null;
          const getFallback = () => {
            if (!fallback) {
              const here = batchesIn(unit, branch);
              fallback = here.length ? here[0] : branchBatchFor(unit, batches[0], branch, 'Returned stock').batch;
            }
            return fallback;
          };
          for (const a of allocs) {
            let target = batches.find((b) => normalizeCode(b.batchNo) === a.batchNo && sameBranch(b.branch, branch));
            if (!target) {
              const template = batches.find((b) => normalizeCode(b.batchNo) === a.batchNo);
              if (template) {
                const made = branchBatchFor(unit, template, branch, 'Returned stock');
                target = made.batch;
                if (made.created) target.initialQuantity = a.quantity;
              }
            }
            if (!target) target = getFallback();
            target.quantity = (Number(target.quantity) || 0) + a.quantity;
          }
          const rest = total - allocated;
          if (rest > 0) {
            const target = getFallback();
            target.quantity = (Number(target.quantity) || 0) + rest;
          }
        } else {
          const row = branchRow(unit, branch);
          row.stock = (Number(row.stock) || 0) + total;
        }
        recompute(product, unit, { allowRepublish: true, mainBranchId });
        return { set: buildSet(product, index, unit), result: { restored: total, branchId: branch } };
      },
      { withDeleted: true }
    );
  } catch (err) {
    if (err.skip || (err.isStockError && err.status === 404)) {
      console.warn('[stock] restore skipped:', err.message);
      return { product: null, restored: 0, skipped: err.message };
    }
    throw err;
  }
};

/**
 * Add stock to a unit in ONE branch.
 *   quantity = quantity  OR  boxes * piecesPerBox + loosePieces
 * When `batch` is given ({batchNo?, barcode?, costPrice?, expiryDate?, note?})
 * or the unit already has batches (in any branch), a new batch is created in
 * that branch (batchNo "<shortCode>-<n>", barcode = batchNo by default).
 * First batch on a unit with plain stock: each branch's pieces become an
 * "Opening stock" batch of that branch.
 * Returns { product (fresh document), batch|null, quantity, variantId, branchId }.
 */
const receiveStock = async ({ productId, variantId, quantity, boxes, loosePieces, batch, branchId }) => {
  const batchInput = batch && typeof batch === 'object' ? batch : null;
  const mainBranchId = await getMainBranchId();
  const branch = await resolveBranch(branchId);

  // Validate a typed barcode against other products once, outside the retry loop.
  const typedBarcode = normalizeCode(batchInput && (batchInput.barcode || batchInput.batchNo));
  if (typedBarcode && (await isCodeTaken(typedBarcode, productId))) {
    throw stockError(`Code "${typedBarcode}" is already used by another product`, 409, {
      code: 'DUPLICATE_CODE',
      duplicateCode: typedBarcode,
    });
  }

  let generatedShortCode = null; // reuse across retries

  const out = await withOptimisticLock(productId, async (product) => {
    const { unit, index } = pickUnit(product, variantId);
    syncUnitBranchStock(unit, { mainBranchId });
    const perBox = Math.max(1, toInt(product.piecesPerBox, 1));

    let qty = toInt(quantity, 0) || toInt(batchInput && batchInput.quantity, 0);
    if (!(qty > 0)) {
      const b = Math.max(0, toInt(boxes, 0));
      const loose = Math.max(0, toInt(loosePieces, 0));
      qty = b * perBox + loose;
    }
    if (!(qty > 0)) throw stockError('Enter a quantity, or a number of boxes / loose pieces greater than 0', 400);

    const extra = {};
    let newBatch = null;
    unit.batches = unit.batches || [];

    if (batchInput || unit.batches.length) {
      // A unit needs a short code to number its batches.
      if (!unit.shortCode) {
        if (!generatedShortCode) generatedShortCode = await generateShortCode(new Set(), product._id);
        unit.shortCode = generatedShortCode;
        extra[index === -1 ? 'shortCode' : `variants.${index}.shortCode`] = unit.shortCode;
      }
      const shortCode = normalizeCode(unit.shortCode);
      const usedNos = new Set(unit.batches.map((b) => normalizeCode(b.batchNo)));
      const nextNo = () => {
        let n = 1;
        while (usedNos.has(`${shortCode}-${n}`)) n++;
        const no = `${shortCode}-${n}`;
        usedNos.add(no);
        return no;
      };

      // First batch on a unit that already had loose stock: keep each branch's
      // stock as an "opening" batch, otherwise stock = sum(batches) would lose it.
      if (!unit.batches.length) {
        for (const row of unit.branchStock || []) {
          const loose = Math.max(0, Number(row.stock) || 0);
          if (!loose) continue;
          const openingNo = nextNo();
          unit.batches.push({
            _id: new mongoose.Types.ObjectId(),
            batchNo: openingNo,
            barcode: openingNo,
            quantity: loose,
            initialQuantity: loose,
            receivedAt: product.createdAt ? new Date(product.createdAt) : new Date(0),
            note: 'Opening stock',
            branch: toBranchId(row.branch),
          });
        }
      }

      const [norm] = normalizeBatches([
        { ...(batchInput || {}), quantity: qty, initialQuantity: qty, receivedAt: (batchInput && batchInput.receivedAt) || new Date() },
      ]);
      if (norm.batchNo && usedNos.has(norm.batchNo)) {
        throw stockError(`Batch "${norm.batchNo}" already exists on this item`, 409, {
          code: 'DUPLICATE_CODE',
          duplicateCode: norm.batchNo,
        });
      }
      if (norm.batchNo) usedNos.add(norm.batchNo);
      norm.batchNo = norm.batchNo || nextNo();
      norm.barcode = norm.barcode || norm.batchNo;
      norm._id = new mongoose.Types.ObjectId();
      norm.branch = branch;
      Object.keys(norm).forEach((k) => norm[k] === undefined && delete norm[k]);

      // Code must be unique inside this product too...
      const ownCodes = new Set(buildScanCodes(product));
      if (ownCodes.has(norm.barcode)) {
        throw stockError(`Code "${norm.barcode}" is already used on this product`, 409, {
          code: 'DUPLICATE_CODE',
          duplicateCode: norm.barcode,
        });
      }
      // ...and across products (auto-generated codes were not checked above).
      if (norm.barcode !== typedBarcode && (await isCodeTaken(norm.barcode, product._id))) {
        throw stockError(`Code "${norm.barcode}" is already used by another product`, 409, {
          code: 'DUPLICATE_CODE',
          duplicateCode: norm.barcode,
        });
      }

      unit.batches.push(norm);
      newBatch = norm;
      extra.scanCodes = buildScanCodes(product);
    } else {
      const row = branchRow(unit, branch);
      row.stock = (Number(row.stock) || 0) + qty;
    }

    recompute(product, unit, { allowRepublish: true, mainBranchId });
    return {
      set: buildSet(product, index, unit, extra),
      result: { batch: newBatch, quantity: qty, variantId: index === -1 ? null : unit.variantId, branchId: branch },
    };
  });

  // Return a full document (what the admin UI expects).
  const fresh = await loadProduct(productId);
  return { ...out, product: fresh || out.product };
};

/**
 * Move `quantity` pieces of one unit from one branch to another, in ONE write.
 * Units with batches: pieces leave the source branch's batches FIFO (earliest
 * expiry, then oldest received) — or only `batchNo` when given — and land in
 * target-branch batches with the SAME batchNo / barcode / cost / expiry
 * (created when missing), so printed stickers keep scanning.
 * Returns { product, allocations: [{batchNo, quantity}], quantity, variantId,
 * fromBranchId, toBranchId }. Totals do not change.
 */
const transferStock = async ({ productId, variantId, quantity, fromBranchId, toBranchId: toBranch, batchNo }) => {
  const qty = toInt(quantity, 0);
  if (qty <= 0) throw stockError('Quantity must be at least 1', 400);
  const from = toBranchId(fromBranchId);
  const to = toBranchId(toBranch);
  if (!from || !to) throw stockError('fromBranchId and toBranchId must be valid branch ids', 400, { code: 'INVALID_BRANCH' });
  if (from === to) throw stockError('Choose two different branches', 400, { code: 'INVALID_BRANCH' });
  const wantedBatch = normalizeCode(batchNo);
  const mainBranchId = await getMainBranchId();
  const fromName = await branchName(from);

  return withOptimisticLock(productId, async (product) => {
    const { unit, index, variant } = pickUnit(product, variantId);
    syncUnitBranchStock(unit, { mainBranchId });

    const allocations = [];
    if (unit.batches && unit.batches.length) {
      const here = batchesIn(unit, from);
      let order;
      let available;
      if (wantedBatch) {
        order = here.filter((b) => normalizeCode(b.batchNo) === wantedBatch);
        if (!order.length) {
          throw stockError(`Batch "${wantedBatch}" of ${unitName(product, variant)} is not in ${fromName}`, 404, {
            code: 'BATCH_NOT_FOUND',
          });
        }
        available = order.reduce((s, b) => s + Math.max(0, Number(b.quantity) || 0), 0);
      } else {
        order = sortBatchesForSale(here);
        available = unitBranchStock(unit, from, mainBranchId);
      }
      if (available < qty) throw await insufficient(product, variant, from, available, qty);

      let remaining = qty;
      for (const b of order) {
        if (remaining <= 0) break;
        const have = Math.max(0, Number(b.quantity) || 0);
        if (!have) continue;
        const take = Math.min(have, remaining);
        b.quantity = have - take;
        remaining -= take;
        const { batch: target } = branchBatchFor(unit, b, to, `Transfer from ${fromName}`);
        target.quantity = (Number(target.quantity) || 0) + take;
        target.initialQuantity = (Number(target.initialQuantity) || 0) + take;
        allocations.push({ batchNo: b.batchNo, quantity: take });
      }
    } else {
      const available = unitBranchStock(unit, from, mainBranchId);
      if (available < qty) throw await insufficient(product, variant, from, available, qty);
      const src = branchRow(unit, from);
      src.stock = Math.max(0, (Number(src.stock) || 0) - qty);
      const dst = branchRow(unit, to);
      dst.stock = (Number(dst.stock) || 0) + qty;
    }

    recompute(product, unit, { allowRepublish: false, mainBranchId });
    return {
      set: buildSet(product, index, unit),
      result: {
        allocations,
        quantity: qty,
        variantId: index === -1 ? null : unit.variantId,
        fromBranchId: from,
        toBranchId: to,
      },
    };
  });
};

const isStockItem = (item) => item && !item.isLabour && !item.isOutsource && item.product;

const itemProductId = (item) => (item.product && item.product._id ? item.product._id : item.product);

/**
 * Deduct every stock item of an order from ONE branch (opts.branchId, default
 * main). Returns an array aligned with `items` ({allocations} or null for
 * labour/outsource). If one item fails, items already deducted are put back
 * and the error is rethrown.
 */
const deductOrderItems = async (items, { branchId } = {}) => {
  const branch = await resolveBranch(branchId);
  const done = [];
  const results = [];
  try {
    for (const item of items || []) {
      if (!isStockItem(item)) {
        results.push(null);
        continue;
      }
      const r = await deductStock({
        productId: itemProductId(item),
        variantId: item.variantId,
        quantity: item.quantity,
        batchNo: item.batchNo,
        branchId: branch,
      });
      done.push({ item, allocations: r.allocations });
      results.push({ allocations: r.allocations });
    }
    return results;
  } catch (err) {
    for (const d of done.reverse()) {
      try {
        await restoreStock({
          productId: itemProductId(d.item),
          variantId: d.item.variantId,
          quantity: d.item.quantity,
          allocations: d.allocations,
          branchId: branch,
        });
      } catch (e) {
        console.error('[stock] rollback failed for', idStr(itemProductId(d.item)), e.message);
      }
    }
    throw err;
  }
};

/**
 * Put back every stock item of an order into ONE branch (opts.branchId = the
 * order's branch; default main) using item.batchAllocations.
 * Best effort: one failing item does not stop the others (so stock is never
 * restored twice by a retry). Returns { restored, errors: [{product, message}] }.
 */
const restoreOrderItems = async (items, { branchId } = {}) => {
  const branch = await resolveBranch(branchId);
  let restored = 0;
  const errors = [];
  for (const item of items || []) {
    if (!isStockItem(item)) continue;
    try {
      const r = await restoreStock({
        productId: itemProductId(item),
        variantId: item.variantId,
        quantity: item.quantity,
        allocations: item.batchAllocations,
        branchId: branch,
      });
      restored += r.restored || 0;
      if (r.skipped) errors.push({ product: idStr(itemProductId(item)), message: r.skipped });
    } catch (e) {
      console.error('[stock] restore failed for', idStr(itemProductId(item)), e.message);
      errors.push({ product: idStr(itemProductId(item)), message: e.message });
    }
  }
  return { restored, errors };
};

module.exports = {
  MAX_ATTEMPTS,
  PRODUCT_UNIT,
  deductStock,
  restoreStock,
  receiveStock,
  transferStock,
  deductOrderItems,
  restoreOrderItems,
  unitAvailable,
  pickUnit,
  branchName,
  clearBranchNameCache,
};
