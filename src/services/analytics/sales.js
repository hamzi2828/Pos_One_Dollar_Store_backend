// src/services/analytics/sales.js
// POS bills -> product sale lines, grouped (used by trends and category performance).
//
// Per product line:
//   qty      pieces (gifts included — they leave the shop too)
//   revenue  (price × qty − line discount) × bill factor, 0 for gifts.
//            bill factor = (subtotal − bill discount) / subtotal, so bill-level
//            discounts are shared over the lines. Tax is not revenue.
//   cost     costPrice snapshot × qty; old lines without a snapshot use the
//            product's current costPrice.
//   category the snapshot on the line, else the product's category.
//
//   const rows = await salesLines({ orderMatch, lineMatch, groupBy: { m: monthExpr } });
//   // [{ key: { m }, productId, name, category, qty, giftQty, revenue, cost, profit }]
//
// `groupBy` expressions are evaluated on the BILL (createdAt, branch...), once
// per bill. MongoDB does the heavy part (unwind + group); the product fallback
// (name / category / cost) is one Product query for the products that sold,
// instead of a $lookup per group.
const Product = require('../../models/product');
const POSOrder = require('../../models/posOrder');
const { PRODUCT_LINE_MATCH } = require('./common');
const { TZ } = require('./time');

const monthExpr = { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: TZ } };
const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } };
// Bills saved before branches existed belong to the main branch.
const branchExpr = (mainBranchOid) => ({ $ifNull: ['$branch', mainBranchOid || null] });

function lineStages({ orderMatch, lineMatch = {}, groupBy = {} }) {
  const keys = Object.keys(groupBy);
  const isGift = { $eq: ['$items.isGift', true] };
  const hasCost = { $isNumber: '$items.costPrice' };
  return [
    { $match: orderMatch },
    {
      $project: {
        ...(keys.length ? { k: groupBy } : {}),
        items: { product: 1, quantity: 1, price: 1, discount: 1, costPrice: 1, isGift: 1, category: 1 },
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
    { $match: { ...PRODUCT_LINE_MATCH, ...lineMatch } },
    {
      $group: {
        _id: {
          ...Object.fromEntries(keys.map((k) => [k, `$k.${k}`])),
          p: '$items.product',
          c: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$items.category', ''] } }, 0] }, '$items.category', null] },
        },
        qty: { $sum: '$items.quantity' },
        giftQty: { $sum: { $cond: [isGift, '$items.quantity', 0] } },
        revenue: {
          $sum: {
            $cond: [
              isGift,
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
        snapCost: { $sum: { $cond: [hasCost, { $multiply: ['$items.costPrice', '$items.quantity'] }, 0] } },
        noCostQty: { $sum: { $cond: [hasCost, 0, '$items.quantity'] } },
      },
    },
  ];
}

/** Grouped sale lines with product name / category / cost filled in (see header). */
async function salesLines({ orderMatch, lineMatch, groupBy }) {
  const groups = await POSOrder.aggregate(lineStages({ orderMatch, lineMatch, groupBy })).allowDiskUse(true);
  const ids = [...new Set(groups.map((g) => String(g._id.p)))];
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } }).setOptions({ withDeleted: true }).select('name category costPrice').lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return groups.map((g) => {
    const p = byId.get(String(g._id.p));
    const cost = g.snapCost + g.noCostQty * ((p && Number(p.costPrice)) || 0);
    const { p: pid, c, ...key } = g._id;
    return {
      key,
      productId: String(pid),
      name: (p && p.name) || 'Deleted product',
      category: c || (p && p.category) || 'Uncategorized',
      qty: g.qty,
      giftQty: g.giftQty,
      revenue: g.revenue,
      cost,
      profit: g.revenue - cost,
    };
  });
}

/** Adds a line's numbers into an accumulator { qty, giftQty, revenue, cost }. */
function addTo(acc, r) {
  acc.qty += r.qty;
  acc.giftQty += r.giftQty;
  acc.revenue += r.revenue;
  acc.cost += r.cost;
  return acc;
}
const zero = () => ({ qty: 0, giftQty: 0, revenue: 0, cost: 0 });

module.exports = { lineStages, salesLines, addTo, zero, monthExpr, dayExpr, branchExpr };
