// src/services/inventory/movementService.js
// Writes the stock ledger (models/stockMovement.js). Never throws: a failed
// ledger write is logged and must not break the sale / receipt that caused it.
//
//   await movementService.record({
//     type: 'damage', branchId, productId, variantId, quantity: 2,
//     product,            // optional plain product (saves a read; post-change values)
//     balanceAfter,       // branch total after the change (optional)
//     unitCost, unitPrice, from, to, shelves, batchAllocations,
//     vendorId, refType, refId, refNo, userId, note, occurredAt,
//   });
const mongoose = require('mongoose');
const StockMovement = require('../../models/stockMovement');
const Product = require('../../models/product');

const toId = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const raw = typeof v === 'object' && v._id ? v._id : v;
  return mongoose.Types.ObjectId.isValid(String(raw)) && /^[0-9a-fA-F]{24}$/.test(String(raw))
    ? new mongoose.Types.ObjectId(String(raw))
    : null;
};

const directionOf = (type) => {
  if (StockMovement.IN_TYPES.includes(type)) return 'in';
  if (StockMovement.OUT_TYPES.includes(type)) return 'out';
  if (StockMovement.MOVE_TYPES.includes(type)) return 'move';
  return null;
};

const numOrNull = (n) => (n === undefined || n === null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n));

// The unit (product or variant) of a plain product.
const findUnit = (product, variantId) => {
  if (!product) return null;
  if (product.productType === 'variant') {
    const vs = product.variants || [];
    if (!variantId) return vs.length === 1 ? vs[0] : null;
    return vs.find((v) => String(v.variantId) === String(variantId) || String(v._id) === String(variantId)) || null;
  }
  return product;
};

const loadProduct = async (productId) => {
  let q = Product.findById(productId);
  if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
  q = q.select('name category productType shortCode sku costPrice variants.variantId variants._id variants.shortCode variants.sku variants.costPrice');
  return q.lean();
};

const cleanLocation = (loc) => {
  if (!loc || typeof loc !== 'object') return { kind: 'none' };
  return {
    kind: loc.kind || 'none',
    shelf: toId(loc.shelf),
    branch: toId(loc.branch),
    code: loc.code ? String(loc.code) : '',
  };
};

/** Record one movement. Returns the saved row (plain) or null on failure. */
async function record(input = {}) {
  try {
    const type = input.type;
    const direction = directionOf(type);
    if (!direction) throw new Error(`Unknown movement type "${type}"`);
    const quantity = Math.abs(Number(input.quantity) || 0);
    if (!quantity) return null;
    const branch = toId(input.branchId);
    const product = toId(input.productId || (input.product && input.product._id));
    if (!branch || !product) throw new Error('branchId and productId are required');

    const plain = input.product && input.product.name ? input.product : await loadProduct(product);
    const unit = findUnit(plain, input.variantId);
    const unitCost = numOrNull(input.unitCost) ?? numOrNull(unit && unit.costPrice) ?? numOrNull(plain && plain.costPrice);
    const unitPrice = numOrNull(input.unitPrice);
    const variantId = plain && plain.productType === 'variant' && unit ? String(unit.variantId) : null;

    const row = await StockMovement.create({
      branch,
      product,
      variantId,
      productName: (plain && plain.name) || '',
      category: (plain && plain.category) || '',
      code: (unit && (unit.shortCode || unit.sku)) || '',
      type,
      direction,
      quantity,
      qtyChange: direction === 'in' ? quantity : direction === 'out' ? -quantity : 0,
      balanceAfter: numOrNull(input.balanceAfter),
      from: cleanLocation(input.from),
      to: cleanLocation(input.to),
      shelves: (input.shelves || [])
        .filter((s) => s && Number(s.qty) > 0)
        .map((s) => ({ shelf: toId(s.shelf), code: s.code || '', qty: Number(s.qty) })),
      batchAllocations: (input.batchAllocations || [])
        .filter((a) => a && Number(a.quantity) > 0)
        .map((a) => ({ batchNo: String(a.batchNo || ''), quantity: Number(a.quantity) })),
      unitCost,
      totalCost: unitCost === null ? null : Math.round(unitCost * quantity * 100) / 100,
      unitPrice,
      purchasePrice: numOrNull(input.purchasePrice),
      vendor: toId(input.vendorId),
      refType: input.refType || '',
      refId: toId(input.refId),
      refNo: input.refNo ? String(input.refNo) : '',
      user: toId(input.userId),
      note: input.note ? String(input.note) : '',
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    });
    return row.toObject();
  } catch (err) {
    console.error('[movement] record failed:', err.message);
    return null;
  }
}

/** Movements of one unit, newest first (for the product timeline). */
async function listForUnit(productId, { variantId = null, branchId = null, limit = 200, types = null } = {}) {
  const match = { product: toId(productId) };
  if (variantId) match.variantId = String(variantId);
  if (branchId) match.branch = toId(branchId);
  if (Array.isArray(types) && types.length) match.type = { $in: types };
  return StockMovement.find(match).sort({ occurredAt: -1, _id: -1 }).limit(Math.min(1000, limit)).lean();
}

module.exports = { record, listForUnit, directionOf, findUnit, toId };
