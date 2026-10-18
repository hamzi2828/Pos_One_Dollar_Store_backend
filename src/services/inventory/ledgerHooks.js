// src/services/inventory/ledgerHooks.js
// Called by services/stockService.js right after a successful stock write:
// takes pieces off shelves (outs), puts receipts on a shelf when asked (ins)
// and writes the stock ledger row. Never throws — the stock change already
// happened and must not be reported as failed because of bookkeeping.
//
// `movement` context accepted by every stockService function:
//   {
//     type,                 // models/stockMovement.js TYPES (defaults per function)
//     refType, refId, refNo,// source document
//     userId, note, vendorId, occurredAt,
//     unitCost,             // cost per piece (default: unit's average cost)
//     unitPrice,            // sale price per piece (sales)
//     fromShelfId,          // outs: pieces came from this shelf first
//     toShelfId,            // ins: put the pieces straight on this shelf
//     strategy,             // outs: 'shelf_first' | 'warehouse_first' (default by type)
//   }
// Pass `movement: false` to skip the ledger (internal rollbacks).
const movementService = require('./movementService');
const locationService = require('./locationService');
const { unitBranchStock, getMainBranchId } = require('../../helper/productCodes');

const findUnit = movementService.findUnit;

const balanceOf = async (product, variantId, branchId) => {
  const unit = findUnit(product, variantId);
  if (!unit) return null;
  const mainBranchId = await getMainBranchId();
  return Math.max(0, Number(unitBranchStock(unit, branchId, mainBranchId)) || 0);
};

const variantKey = (product, variantId) => {
  if (!product || product.productType !== 'variant') return null;
  const unit = findUnit(product, variantId);
  return unit ? String(unit.variantId) : variantId ? String(variantId) : null;
};

/** Pieces LEFT the shop (sale, gift, damage, vendor return, shop use...). */
async function onOut({ product, variantId, branchId, quantity, allocations = [], movement = {}, defaultType = 'adjustment_out' }) {
  if (movement === false || !product) return null;
  try {
    const ctx = movement || {};
    const type = ctx.type || defaultType;
    const key = variantKey(product, variantId);
    const balanceAfter = await balanceOf(product, key, branchId);
    const strategy = ctx.strategy || (locationService.SHELF_FIRST_TYPES.includes(type) ? 'shelf_first' : 'warehouse_first');
    let shelves = [];
    try {
      shelves = await locationService.consumeShelves({
        branchId,
        productId: product._id,
        variantId: key,
        qty: quantity,
        branchTotalAfter: balanceAfter ?? 0,
        strategy,
        fromShelfId: ctx.fromShelfId || null,
      });
    } catch (e) {
      console.error('[ledger] shelf update failed:', e.message);
    }
    const fromShelves = shelves.reduce((s, x) => s + x.qty, 0);
    const from =
      shelves.length === 1 && fromShelves === Number(quantity)
        ? { kind: 'shelf', shelf: shelves[0].shelf, code: shelves[0].code }
        : fromShelves > 0
        ? { kind: 'shelf', code: shelves.map((s) => s.code).join(', ') }
        : { kind: 'warehouse', code: locationService.WAREHOUSE_CODE };
    const to =
      type === 'sale' || type === 'gift'
        ? { kind: 'customer' }
        : type === 'vendor_return' || type === 'consignment_return'
        ? { kind: 'vendor' }
        : { kind: 'none' };
    return await movementService.record({
      ...ctx,
      type,
      branchId,
      productId: product._id,
      variantId: key,
      product,
      quantity,
      balanceAfter,
      from,
      to,
      shelves,
      batchAllocations: allocations,
    });
  } catch (err) {
    console.error('[ledger] onOut failed:', err.message);
    return null;
  }
}

/** Pieces ENTERED the shop (receipt, consignment in, sale return...). */
async function onIn({ product, variantId, branchId, quantity, batch = null, movement = {}, defaultType = 'receive' }) {
  if (movement === false || !product) return null;
  try {
    const ctx = movement || {};
    const type = ctx.type || defaultType;
    const key = variantKey(product, variantId);
    const balanceAfter = await balanceOf(product, key, branchId);
    let to = { kind: 'warehouse', code: locationService.WAREHOUSE_CODE };
    const shelves = [];
    if (ctx.toShelfId) {
      try {
        const shelf = await locationService.loadShelf(ctx.toShelfId, branchId);
        const placed = await locationService.addToShelf({ branchId, productId: product._id, variantId: key, shelf, qty: quantity });
        if (placed) shelves.push(placed);
        to = { kind: 'shelf', shelf: shelf._id, code: shelf.code };
      } catch (e) {
        console.error('[ledger] could not place on shelf, left in warehouse:', e.message);
      }
    }
    const from =
      type === 'purchase_receipt' || type === 'consignment_in'
        ? { kind: 'vendor' }
        : type === 'sale_return'
        ? { kind: 'customer' }
        : { kind: 'none' };
    return await movementService.record({
      ...ctx,
      type,
      branchId,
      productId: product._id,
      variantId: key,
      product,
      quantity,
      balanceAfter,
      from,
      to,
      shelves,
      batchAllocations: batch && batch.batchNo ? [{ batchNo: batch.batchNo, quantity }] : ctx.batchAllocations || [],
    });
  } catch (err) {
    console.error('[ledger] onIn failed:', err.message);
    return null;
  }
}

module.exports = { onOut, onIn };
