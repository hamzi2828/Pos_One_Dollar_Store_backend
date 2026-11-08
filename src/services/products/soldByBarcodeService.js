// "Sold by barcode" report for one product: how many pieces were sold through
// each of its barcodes (items.scannedCode on POS bills). Lines added by name
// search have no code and are grouped under code ''.
//
// Bills that count = the same rule as the sales reports (reportsController /
// analytics/common.js SALE_MATCH): not deleted, not refunded / cancelled.
// Refunds are whole-bill only (POST /orders/:id/refund), so a returned sale
// simply drops out; there are no per-line returns to subtract.
// Amount = the analytics revenue rule: price x qty - line discount, scaled by
// the bill discount, gifts at 0.
const mongoose = require('mongoose');
const POSOrder = require('../../models/posOrder');
const Product = require('../../models/product');

const SALE_MATCH = {
  isDeleted: { $ne: true },
  orderStatus: { $nin: ['refunded', 'cancelled'] },
  paymentStatus: { $ne: 'refunded' },
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (c) => String(c || '').trim().toUpperCase();

/** Returns null when the product does not exist. */
async function soldByBarcode(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  const product = await Product.findById(productId).select('barcodes variants.barcodes stockCodes').lean();
  if (!product) return null;
  const pid = new mongoose.Types.ObjectId(String(productId));

  const rows = await POSOrder.aggregate([
    { $match: { ...SALE_MATCH, 'items.product': pid } },
    {
      $project: {
        when: { $ifNull: ['$completedAt', '$createdAt'] },
        items: { product: 1, quantity: 1, price: 1, discount: 1, isGift: 1, scannedCode: 1 },
        factor: {
          $cond: [
            { $gt: ['$subtotal', 0] },
            { $max: [0, { $min: [1, { $divide: [{ $subtract: ['$subtotal', { $ifNull: ['$discount', 0] }] }, '$subtotal'] }] }] },
            1,
          ],
        },
      },
    },
    { $unwind: '$items' },
    { $match: { 'items.product': pid } },
    {
      $group: {
        _id: { $toUpper: { $trim: { input: { $ifNull: ['$items.scannedCode', ''] } } } },
        qty: { $sum: '$items.quantity' },
        orders: { $addToSet: '$_id' },
        amount: {
          $sum: {
            $cond: [
              { $eq: ['$items.isGift', true] },
              0,
              {
                $multiply: [
                  { $max: [0, { $subtract: [{ $multiply: ['$items.price', '$items.quantity'] }, { $ifNull: ['$items.discount', 0] }] }] },
                  '$factor',
                ],
              },
            ],
          },
        },
        lastSoldAt: { $max: '$when' },
      },
    },
  ]);

  const byCode = new Map(
    rows.map((r) => [
      r._id || '',
      { code: r._id || '', qty: r.qty || 0, sales: (r.orders || []).length, amount: round2(r.amount), lastSoldAt: r.lastSoldAt || null },
    ])
  );

  // Every barcode of the product shows, even with 0 sold.
  const own = [
    ...(product.barcodes || []),
    ...(product.variants || []).flatMap((v) => v.barcodes || []),
  ].map((b) => norm(b && b.code));
  for (const code of own) {
    if (code && !byCode.has(code)) byCode.set(code, { code, qty: 0, sales: 0, amount: 0, lastSoldAt: null });
  }
  // Own code of a received stock: show which stock it is (vendor, bill, cost), even with 0 sold.
  for (const r of product.stockCodes || []) {
    const code = norm(r.code);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, { code, qty: 0, sales: 0, amount: 0, lastSoldAt: null });
    byCode.get(code).stock = {
      plain: !!r.plain,
      vendorName: r.vendorName || '',
      billNo: r.billNo || '',
      grnNumber: r.grnNumber || '',
      costPrice: Number(r.costPrice) || 0,
      landedUnitCost: Number(r.landedUnitCost) || 0,
      pieces: Number(r.qty) || 0,
      receivedAt: r.createdAt || null,
      undone: !!r.undone,
    };
    own.push(code);
  }
  // A row for searched lines always shows too.
  if (!byCode.has('')) byCode.set('', { code: '', qty: 0, sales: 0, amount: 0, lastSoldAt: null });

  const ownOrder = new Map(own.map((c, i) => [c, i]));
  const data = [...byCode.values()].sort((a, b) => {
    if (!a.code !== !b.code) return a.code ? -1 : 1; // '' last
    if (b.qty !== a.qty) return b.qty - a.qty;
    const ai = ownOrder.has(a.code) ? ownOrder.get(a.code) : Infinity;
    const bi = ownOrder.has(b.code) ? ownOrder.get(b.code) : Infinity;
    return ai - bi || a.code.localeCompare(b.code);
  });

  return { data, meta: { totalQty: data.reduce((s, r) => s + r.qty, 0) } };
}

module.exports = { soldByBarcode };
