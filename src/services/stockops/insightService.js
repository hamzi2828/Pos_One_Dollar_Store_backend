// src/services/stockops/insightService.js
// Everything about one product on one screen (ProductInsightPanel):
//   product  : codes, category, sale price, price tier, avg landed cost, margin
//   price    : first / last vendor price, landed cost per receipt, sale price changes
//   vendors  : per vendor first / last / min / avg price, qty, receipts, last date
//   recommendation : another vendor supplied it cheaper than the current vendor
//   stock    : per branch total / shelved / warehouse + shelf codes
//   sales    : pieces sold in the last 7 / 30 / 90 days + last sold date (POSOrder)
//   movements: last 10 ledger rows
// Vendor prices are compared on the vendor's price per piece (purchasePrice,
// before shipment charges); landed cost is shown next to it.
const mongoose = require('mongoose');
const StockMovement = require('../../models/stockMovement');
const PriceChange = require('../../models/priceChange');
const POSOrder = require('../../models/posOrder');
const Vendor = require('../../models/vendor');
const Branch = require('../../models/branch');
const User = require('../../models/user');
const locationService = require('../inventory/locationService');
const { variantLabel, getMainBranchId } = require('../../helper/productCodes');
const { rowView, nameMaps } = require('./movementLedgerService');
const { round2, round4, toObjectId, DAY_MS, loadProductLean, pickUnit, branchMatch, userName } = require('./common');

const RECEIPT_TYPES = ['purchase_receipt', 'consignment_in'];
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const loadPriceTier = async (id) => {
  if (!id) return null;
  try {
    const PriceTier = mongoose.models.PriceTier || require('../../models/priceTier');
    const t = await PriceTier.findById(id).lean();
    return t ? { id: String(t._id), name: t.name || '', price: num(t.price) } : { id: String(id) };
  } catch (_) {
    return { id: String(id) }; // price tier module not installed yet
  }
};

/** Vendor stats from receipt rows (oldest first). */
function vendorStats(receipts, vendorNames) {
  const map = new Map();
  for (const r of receipts) {
    if (!r.vendor || num(r.purchasePrice) === null) continue;
    const key = String(r.vendor);
    let v = map.get(key);
    if (!v) {
      v = { vendorId: key, name: vendorNames.get(key) || 'Vendor', firstPrice: r.purchasePrice, firstDate: r.occurredAt, lastPrice: r.purchasePrice, minPrice: r.purchasePrice, totalQty: 0, value: 0, receipts: 0, lastDate: r.occurredAt, lastLandedCost: r.unitCost };
      map.set(key, v);
    }
    v.lastPrice = r.purchasePrice;
    v.lastDate = r.occurredAt;
    v.lastLandedCost = r.unitCost;
    v.minPrice = Math.min(v.minPrice, r.purchasePrice);
    v.totalQty += r.quantity;
    v.value += r.quantity * r.purchasePrice;
    v.receipts += 1;
  }
  return [...map.values()]
    .map(({ value, ...v }) => ({ ...v, avgPrice: v.totalQty ? round4(value / v.totalQty) : v.lastPrice }))
    .sort((a, b) => new Date(b.lastDate) - new Date(a.lastDate));
}

/** Cheapest other vendor whose last price beats the current vendor's last price. */
function recommend(vendors, currentVendorId) {
  const current = vendors.find((v) => v.vendorId === currentVendorId);
  if (!current) return null;
  const cheaper = vendors
    .filter((v) => v.vendorId !== currentVendorId && v.lastPrice < current.lastPrice)
    .sort((a, b) => a.lastPrice - b.lastPrice)[0];
  if (!cheaper) return null;
  const saving = round4(current.lastPrice - cheaper.lastPrice);
  return {
    vendor: { vendorId: cheaper.vendorId, name: cheaper.name },
    price: cheaper.lastPrice,
    currentVendor: { vendorId: current.vendorId, name: current.name },
    currentPrice: current.lastPrice,
    savingPerPiece: saving,
    savingPct: current.lastPrice > 0 ? round2((saving / current.lastPrice) * 100) : 0,
    lastDate: cheaper.lastDate,
  };
}

/** Pieces sold (not gifts) in the last 7/30/90 days from POS orders. */
async function salesStats(productId, variantId, branchId) {
  const now = Date.now();
  const d7 = new Date(now - 7 * DAY_MS);
  const d30 = new Date(now - 30 * DAY_MS);
  const d90 = new Date(now - 90 * DAY_MS);
  const orderMatch = {
    isDeleted: { $ne: true },
    orderStatus: { $nin: ['refunded', 'cancelled'] },
    paymentStatus: { $ne: 'refunded' },
    'items.product': productId,
    ...(await branchMatch(branchId)),
  };
  const itemMatch = { 'items.product': productId, 'items.isGift': { $ne: true } };
  if (variantId) itemMatch['items.variantId'] = String(variantId);
  const sumIf = (since, expr) => ({ $sum: { $cond: [{ $gte: ['$createdAt', since] }, expr, 0] } });
  const revenue = { $multiply: [{ $ifNull: ['$items.price', 0] }, '$items.quantity'] };
  const [agg] = await POSOrder.aggregate([
    { $match: { ...orderMatch, createdAt: { $gte: d90 } } },
    { $unwind: '$items' },
    { $match: itemMatch },
    {
      $group: {
        _id: null,
        q7: sumIf(d7, '$items.quantity'),
        q30: sumIf(d30, '$items.quantity'),
        q90: { $sum: '$items.quantity' },
        r7: sumIf(d7, revenue),
        r30: sumIf(d30, revenue),
        r90: { $sum: revenue },
        o90: { $addToSet: '$_id' },
      },
    },
  ]);

  // Last sold: the ledger first (indexed), else the newest POS order.
  const mv = { product: productId, type: 'sale' };
  if (variantId) mv.variantId = String(variantId);
  if (branchId) mv.branch = toObjectId(branchId);
  const lastMove = await StockMovement.findOne(mv).sort({ occurredAt: -1 }).select('occurredAt').lean();
  let lastSoldAt = lastMove ? lastMove.occurredAt : null;
  if (!lastSoldAt) {
    const q = { ...orderMatch };
    if (variantId) q.items = { $elemMatch: { product: productId, variantId: String(variantId) } };
    const last = await POSOrder.findOne(q).sort({ createdAt: -1 }).select('createdAt').maxTimeMS(3000).lean().catch(() => null);
    lastSoldAt = last ? last.createdAt : null;
  }
  const a = agg || {};
  return {
    d7: { qty: a.q7 || 0, revenue: round2(a.r7 || 0) },
    d30: { qty: a.q30 || 0, revenue: round2(a.r30 || 0) },
    d90: { qty: a.q90 || 0, revenue: round2(a.r90 || 0), orders: (a.o90 || []).length },
    avgPerDay30: round2((a.q30 || 0) / 30),
    lastSoldAt,
  };
}

/**
 * Insight for a product (or one variant). `branchId` scopes stock, sales and
 * movements (null = all branches); vendor prices are always company-wide.
 */
async function getInsights(productId, { variantId = null, branchId = null } = {}) {
  const product = await loadProductLean(productId);
  // Variant product without a variant: whole-product view (first variant for prices).
  const picked = pickUnit(product, variantId, { required: false }) || { unit: (product.variants || [])[0] || product, variant: null, variantId: null };
  const unit = picked.unit;
  const unitFilter = { product: product._id };
  if (picked.variantId) unitFilter.variantId = picked.variantId;

  const receipts = await StockMovement.find({
    ...unitFilter,
    $or: [{ type: { $in: RECEIPT_TYPES } }, { type: 'receive', purchasePrice: { $ne: null } }],
  })
    .sort({ occurredAt: 1, _id: 1 })
    .limit(2000)
    .lean();

  const vendorIds = [...new Set([...receipts.map((r) => r.vendor && String(r.vendor)), unit.lastVendor && String(unit.lastVendor), product.lastVendor && String(product.lastVendor)].filter(Boolean))];
  const vendorDocs = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select('name phone').lean() : [];
  const vendorNames = new Map(vendorDocs.map((v) => [String(v._id), v.name]));
  const vendors = vendorStats(receipts, vendorNames);

  // Current vendor = vendor of the newest receipt (else the product's last vendor).
  const lastWithVendor = [...receipts].reverse().find((r) => r.vendor && num(r.purchasePrice) !== null);
  const currentVendorId = lastWithVendor
    ? String(lastWithVendor.vendor)
    : unit.lastVendor
    ? String(unit.lastVendor)
    : product.lastVendor
    ? String(product.lastVendor)
    : null;

  const salePrice = num(unit.price) ?? num(product.price) ?? 0;
  const avgCost = num(unit.costPrice) ?? num(product.costPrice);
  const marginAmount = avgCost !== null ? round2(salePrice - avgCost) : null;
  const first = receipts.find((r) => num(r.purchasePrice) !== null);
  const last = [...receipts].reverse().find((r) => num(r.purchasePrice) !== null);

  const changeFilter = { product: product._id };
  if (picked.variantId) changeFilter.variantId = picked.variantId;
  const changes = await PriceChange.find(changeFilter).sort({ changedAt: 1 }).limit(300).lean();
  const changeUsers = [...new Set(changes.map((c) => c.user && String(c.user)).filter(Boolean))];
  const users = changeUsers.length ? await User.find({ _id: { $in: changeUsers } }).setOptions({ withDeleted: true }).select('firstName lastName email').lean() : [];
  const userNames = new Map(users.map((u) => [String(u._id), userName(u)]));
  const saleChanges = changes.filter((c) => c.field === 'price');

  // Stock per branch (+ shelves)
  let locations = await locationService.getProductLocations(product._id, { branchId: branchId || null });
  if (picked.variantId) locations = locations.filter((l) => l.variantId === picked.variantId);
  const branchIds = [...new Set(locations.map((l) => l.branchId))];
  const branchDocs = branchIds.length ? await Branch.find({ _id: { $in: branchIds } }).select('name code').lean() : [];
  const branchById = new Map(branchDocs.map((b) => [String(b._id), b]));

  // Last 10 movements (branch scoped)
  const mvFilter = { ...unitFilter };
  if (branchId) mvFilter.branch = toObjectId(branchId);
  const recent = await StockMovement.find(mvFilter).sort({ occurredAt: -1, _id: -1 }).limit(10).lean();
  const names = await nameMaps(recent);

  const mainBranchId = await getMainBranchId();
  const codes = {
    shortCode: unit.shortCode || product.shortCode || '',
    sku: unit.sku || product.sku || '',
    barcodes: [...new Set((unit.barcodes || []).map((b) => b.code).filter(Boolean))],
  };

  return {
    product: {
      id: String(product._id),
      name: product.name,
      category: product.category,
      thumbnailUrl: product.thumbnailUrl || null,
      productType: product.productType,
      isDeleted: !!product.isDeleted,
      variantId: picked.variantId,
      variantLabel: picked.variant ? variantLabel(picked.variant) : '',
      variants: product.productType === 'variant' ? (product.variants || []).map((v) => ({ variantId: String(v.variantId), label: variantLabel(v), price: v.price })) : [],
      codes,
      salePrice,
      discountedPrice: num(unit.discountedPrice) ?? num(product.discountedPrice),
      priceTier: await loadPriceTier(product.priceTier),
      avgCost: avgCost !== null ? round4(avgCost) : null,
      lastLandedCost: num(unit.lastLandedCost),
      lastPurchasePrice: num(unit.lastPurchasePrice),
      margin: marginAmount !== null ? { amount: marginAmount, pct: salePrice > 0 ? round2((marginAmount / salePrice) * 100) : null } : null,
      isConsignment: !!product.isConsignment,
      totalStock: locations.reduce((s, l) => s + l.total, 0),
    },
    price: {
      firstPurchasePrice: first ? first.purchasePrice : num(unit.firstPurchasePrice),
      firstLandedCost: first ? first.unitCost : null,
      firstReceivedAt: first ? first.occurredAt : unit.firstReceivedAt || null,
      lastPurchasePrice: last ? last.purchasePrice : num(unit.lastPurchasePrice),
      lastLandedCost: last ? last.unitCost : num(unit.lastLandedCost),
      lastReceivedAt: last ? last.occurredAt : unit.lastReceivedAt || null,
      avgCost: avgCost !== null ? round4(avgCost) : null,
      firstSalePrice: saleChanges.length ? saleChanges[0].oldValue ?? saleChanges[0].newValue : salePrice,
      salePrice,
      receipts: receipts
        .slice(-30)
        .reverse()
        .map((r) => ({
          at: r.occurredAt,
          type: r.type,
          vendorId: r.vendor ? String(r.vendor) : null,
          vendorName: r.vendor ? vendorNames.get(String(r.vendor)) || '' : '',
          qty: r.quantity,
          purchasePrice: r.purchasePrice,
          landedCost: r.unitCost,
          refNo: r.refNo,
          branchId: String(r.branch),
        })),
      changes: changes
        .slice(-50)
        .reverse()
        .map((c) => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, changedAt: c.changedAt, source: c.source, userName: c.user ? userNames.get(String(c.user)) || '' : '' })),
    },
    vendors: vendors.map((v) => ({ ...v, isCurrent: v.vendorId === currentVendorId })),
    currentVendor: currentVendorId ? { vendorId: currentVendorId, name: vendorNames.get(currentVendorId) || unit.lastVendorName || product.lastVendorName || '' } : null,
    recommendation: recommend(vendors, currentVendorId),
    stock: locations.map((l) => {
      const b = branchById.get(l.branchId);
      return {
        branchId: l.branchId,
        branchName: b ? b.name : '',
        branchCode: b ? b.code : '',
        isMain: mainBranchId ? String(mainBranchId) === l.branchId : false,
        variantId: l.variantId,
        total: l.total,
        shelved: l.shelved,
        warehouse: l.warehouse,
        shelves: l.shelves.filter((s) => s.qty > 0 || s.isHome).map((s) => ({ code: s.code, qty: s.qty, isHome: s.isHome })),
      };
    }),
    sales: await salesStats(product._id, picked.variantId, branchId),
    movements: recent.map((r) => rowView(r, names)),
  };
}

module.exports = { getInsights, vendorStats, recommend, salesStats };
