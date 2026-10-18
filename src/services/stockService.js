// stockService.js — every stock change (sale, return, receiving, damage...) goes through here.
//
// Stock is always counted in pieces. A "unit" is a single product or one variant.
// If a unit has batches, its stock = sum of the batches' `quantity`, and sales
// take pieces out of batches (scanned batch first, then earliest expiry /
// oldest received — see sortBatchesForSale).
//
// The shop: every unit has `branchStock: [{ branch, stock }]` and every batch a
// `branch` (the shop = the main branch, see models/branch.js). A missing
// branchId means the shop. Old data without branch info is converted on the
// first write (syncUnitBranchStock). Every write keeps the invariants of
// helper/productCodes.js (unit stock, product total, branchStock, batch.branch)
// in ONE guarded update.
//
// Safe against two counters selling the same item at once WITHOUT transactions
// (the DB may not be a replica set): optimistic locking on `updatedAt`.
//   1. load the product
//   2. compute the new state in memory
//   3. Product.updateOne({ _id, updatedAt: <loaded> }, { $set: ... })
//   4. nobody matched => someone else changed it in between => reload and retry

const mongoose = require('mongoose');
const Product = require('../models/product');
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

// Ledger + shelf bookkeeping after each successful write (lazy: avoids a
// require cycle). See services/inventory/ledgerHooks.js for the `movement`
// context every function below accepts (`movement: false` = no ledger row).
const hooks = () => require('./inventory/ledgerHooks');

const stockError =(message, status = 400, extra = {}) => {
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

// Branch to work on: the given one (must be a valid id) or the shop.
const resolveBranch = async (branchId, label = 'branchId') => {
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    const id = toBranchId(branchId);
    if (!id) throw stockError(`Invalid ${label}`, 400, { code: 'INVALID_BRANCH' });
    return id;
  }
  const main = await getMainBranchId();
  if (!main) throw stockError('Shop not found', 400, { code: 'INVALID_BRANCH' });
  return main;
};

const loadProduct = (productId, { withDeleted = false } = {}) => {
  let q = Product.findById(productId);
  if (withDeleted && q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  return q && typeof q.lean === 'function' ? q.lean() : q;
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
 * Created when missing (stock put back after the batch was emptied), with the
 * same batchNo / barcode / cost / expiry, so the printed sticker still scans.
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
      return { ...result, product };
    }
    // Someone else changed this product between our read and write — retry.
  }
  throw stockError('This product is being updated by another sale right now. Please try again.', 409, {
    code: 'STOCK_CONFLICT',
  });
};

const insufficient = (product, variant, branchId, available, requested) =>
  stockError(`Insufficient stock for ${unitName(product, variant)}. Available: ${available}, Requested: ${requested}`, 400, {
    code: 'INSUFFICIENT_STOCK',
    available,
    requested,
    branchId: toBranchId(branchId),
  });

/**
 * Take `quantity` pieces out of a unit in ONE branch (its plain stock or its
 * batches — the scanned batch of that branch first).
 * Returns { allocations: [{batchNo, quantity}], product, branchId }.
 * Throws 400 when the branch has not enough, 404 when product/variant missing.
 * `movement` (optional): ledger context, default type 'adjustment_out'. Use it
 * for every non-sale removal too: damage, internal_use, vendor_return,
 * consignment_return, adjustment_out.
 */
const deductStock = async ({ productId, variantId, quantity, batchNo, branchId, movement }) => {
  const qty = toInt(quantity, 0);
  if (qty <= 0) throw stockError('Quantity must be at least 1', 400);
  const wantedBatch = normalizeCode(batchNo);
  const mainBranchId = await getMainBranchId();
  const branch = await resolveBranch(branchId);

  const out = await withOptimisticLock(productId, async (product) => {
    const { unit, index, variant } = pickUnit(product, variantId);
    syncUnitBranchStock(unit, { mainBranchId });
    const available = unitBranchStock(unit, branch, mainBranchId);
    if (available < qty) throw insufficient(product, variant, branch, available, qty);

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

  if (movement !== false) {
    out.movement = await hooks().onOut({
      product: out.product,
      variantId,
      branchId: branch,
      quantity: qty,
      allocations: out.allocations,
      movement: movement || {},
      defaultType: 'adjustment_out',
    });
  }
  return out;
};

/**
 * Put pieces back into ONE branch (order deleted / refunded / failed to save).
 * Pieces go back into that branch's batches with the same batchNo; if the
 * branch no longer has that batch, it is re-created there (same batchNo and
 * barcode). Unknown batch → first batch of the branch (or a copy of the unit's
 * first batch); plain stock when the unit has no batches.
 * Works on soft-deleted products too. Returns { product, restored, branchId } or
 * { product: null, restored: 0, skipped: reason } when the unit is gone.
 * `movement` (optional): ledger context, default type 'adjustment_in'
 * (sale refunds pass type 'sale_return').
 */
const restoreStock = async ({ productId, variantId, quantity, allocations, branchId, movement }) => {
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
    const out = await withOptimisticLock(
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
    if (movement !== false) {
      out.movement = await hooks().onIn({
        product: out.product,
        variantId,
        branchId: branch,
        quantity: total,
        movement: { batchAllocations: allocs, ...(movement || {}) },
        defaultType: 'adjustment_in',
      });
    }
    return out;
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
 *
 * `cost` (optional, landed costing — purchase orders / consignment):
 *   { unitCost,        // landed cost per piece of THIS receipt (required to cost)
 *     purchasePrice,   // vendor price per piece before charges (for history)
 *     vendorId, vendorName,
 *     updateAverage }  // default true: unit.costPrice becomes the moving
 *                      // weighted average (stock across all branches)
 * Also stamps lastPurchasePrice / lastLandedCost / lastVendor / lastReceivedAt /
 * lastReceivedQty (+ first* on the first costed receipt) in the same write.
 * `movement` (optional): ledger context, default type 'receive'
 * (purchase orders pass 'purchase_receipt', consignment 'consignment_in').
 */
const receiveStock = async ({ productId, variantId, quantity, boxes, loosePieces, batch, branchId, cost, movement }) => {
  const batchInput = batch && typeof batch === 'object' ? batch : null;
  const costInput =
    cost && typeof cost === 'object' && Number.isFinite(Number(cost.unitCost)) && Number(cost.unitCost) >= 0 ? cost : null;
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
    const stockBefore = unitTotalStock(unit); // all branches, for the weighted average
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
        {
          ...(costInput ? { costPrice: Number(costInput.unitCost) } : {}),
          ...(batchInput || {}),
          quantity: qty,
          initialQuantity: qty,
          receivedAt: (batchInput && batchInput.receivedAt) || new Date(),
        },
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

    if (costInput) Object.assign(extra, costFields(product, unit, index, stockBefore, qty, costInput));

    recompute(product, unit, { allowRepublish: true, mainBranchId });
    return {
      set: buildSet(product, index, unit, extra),
      result: { batch: newBatch, quantity: qty, variantId: index === -1 ? null : unit.variantId, branchId: branch },
    };
  });

  // Return a full document (what the admin UI expects).
  const fresh = await loadProduct(productId);
  const result = { ...out, product: fresh || out.product };
  if (movement !== false) {
    const ctx = { ...(movement || {}) };
    if (costInput) {
      if (ctx.unitCost === undefined) ctx.unitCost = Number(costInput.unitCost);
      if (ctx.purchasePrice === undefined) {
        ctx.purchasePrice = Number.isFinite(Number(costInput.purchasePrice)) ? Number(costInput.purchasePrice) : Number(costInput.unitCost);
      }
      if (ctx.vendorId === undefined && costInput.vendorId) ctx.vendorId = costInput.vendorId;
    }
    result.movement = await hooks().onIn({
      product: result.product,
      variantId: out.variantId || variantId,
      branchId: branch,
      quantity: out.quantity,
      batch: out.batch,
      movement: ctx,
      defaultType: 'receive',
    });
  }
  return result;
};

/**
 * $set fields for a costed receipt of `qty` pieces at cost.unitCost, given
 * `stockBefore` pieces (all branches) at the unit's current costPrice.
 */
const costFields = (product, unit, index, stockBefore, qty, cost) => {
  const { weightedAverage, round4 } = require('./inventory/costingService');
  const p = (field) => (index === -1 ? field : `variants.${index}.${field}`);
  const unitCost = round4(Number(cost.unitCost));
  const purchasePrice =
    cost.purchasePrice !== undefined && cost.purchasePrice !== null && Number.isFinite(Number(cost.purchasePrice))
      ? round4(Number(cost.purchasePrice))
      : unitCost;
  const now = new Date();
  const set = {
    [p('lastPurchasePrice')]: purchasePrice,
    [p('lastLandedCost')]: unitCost,
    [p('lastReceivedAt')]: now,
    [p('lastReceivedQty')]: qty,
  };
  if (cost.updateAverage !== false) {
    const avg = weightedAverage(stockBefore, unit.costPrice, qty, unitCost);
    set[p('costPrice')] = avg;
    unit.costPrice = avg;
  }
  if (unit.firstPurchasePrice === undefined || unit.firstPurchasePrice === null) {
    set[p('firstPurchasePrice')] = purchasePrice;
    set[p('firstReceivedAt')] = now;
  }
  const vendorId = toBranchId(cost.vendorId); // same 24-hex id check
  if (vendorId) {
    set[p('lastVendor')] = new mongoose.Types.ObjectId(vendorId);
    set[p('lastVendorName')] = cost.vendorName ? String(cost.vendorName) : '';
    if (index !== -1) {
      // Product-level "last vendor" too, for lists.
      set.lastVendor = set[p('lastVendor')];
      set.lastVendorName = set[p('lastVendorName')];
      set.lastReceivedAt = now;
    }
  }
  return set;
};

// Every order line is a product line (no service lines in the dollar store).
const isStockItem = (item) => !!(item && item.product);

const itemProductId = (item) => (item.product && item.product._id ? item.product._id : item.product);

/**
 * Deduct every stock item of an order from ONE branch (opts.branchId, default
 * main). Returns an array aligned with `items` ({allocations} or null for a
 * line without a product). If one item fails, items already deducted are put
 * back and the error is rethrown.
 * `movement` (optional): ledger context for the whole order, e.g.
 *   { refType: 'POSOrder', refId, refNo: orderNumber, userId }
 * Each item gets type 'sale' (or 'gift' when item.isGift), unitPrice =
 * item.price and unitCost = item.costPrice when set. Ledger rows are written
 * only after EVERY item was deducted (a failed order leaves no rows).
 */
const deductOrderItems = async (items, { branchId, movement } = {}) => {
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
        movement: false,
      });
      done.push({ item, allocations: r.allocations, product: r.product });
      results.push({ allocations: r.allocations });
    }
    if (movement !== false) {
      const ctx = movement || {};
      for (const d of done) {
        await hooks().onOut({
          product: d.product,
          variantId: d.item.variantId,
          branchId: branch,
          quantity: toInt(d.item.quantity, 0),
          allocations: d.allocations,
          movement: {
            ...ctx,
            type: d.item.isGift ? 'gift' : ctx.type || 'sale',
            unitPrice: d.item.isGift ? 0 : d.item.price,
            ...(d.item.costPrice !== undefined && d.item.costPrice !== null ? { unitCost: d.item.costPrice } : {}),
          },
          defaultType: 'sale',
        });
      }
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
          movement: false,
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
 * `movement` (optional): ledger context, default type 'sale_return'.
 */
const restoreOrderItems = async (items, { branchId, movement } = {}) => {
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
        movement:
          movement === false
            ? false
            : {
                type: 'sale_return',
                ...(movement || {}),
                unitPrice: item.isGift ? 0 : item.price,
                ...(item.costPrice !== undefined && item.costPrice !== null ? { unitCost: item.costPrice } : {}),
              },
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
  deductOrderItems,
  restoreOrderItems,
  unitAvailable,
  pickUnit,
};
