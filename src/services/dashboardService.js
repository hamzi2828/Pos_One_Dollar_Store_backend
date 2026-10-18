// src/services/dashboardService.js
// Admin dashboard numbers (GET /dashboard?timeRange=today|week|month|year).
// Sales = POS bills of the shop; refunded / cancelled / deleted bills are not sales.
const User = require('../models/user');
const Product = require('../models/product');
const POSOrder = require('../models/posOrder');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_STOCK = 10; // pieces: "low stock" below this

const SALE_MATCH = {
  isDeleted: { $ne: true },
  orderStatus: { $nin: ['refunded', 'cancelled'] },
  paymentStatus: { $ne: 'refunded' },
};

// POS customers (staff logins are not customers).
const CUSTOMER_FILTER = { role: 'user', isSuperAdmin: { $ne: true }, staffRole: null };

/** Start of the time range (today = since midnight, server time). */
function rangeStart(timeRange) {
  const now = Date.now();
  switch (timeRange) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'month':
      return new Date(now - 30 * DAY_MS);
    case 'year':
      return new Date(now - 365 * DAY_MS);
    case 'week':
    default:
      return new Date(now - 7 * DAY_MS);
  }
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const customerName = (o) => {
  const c = o.customer && typeof o.customer === 'object' ? o.customer : null;
  const name = c ? `${c.firstName || ''} ${c.lastName || ''}`.trim() : '';
  return name || (o.customerInfo && o.customerInfo.name) || 'Walk-in';
};

class DashboardService {
  /** Everything the dashboard page shows, for one time range. */
  async getDashboardData(timeRange = 'week') {
    const since = rangeStart(timeRange);
    const [stats, quickStats, salesTrend, topProducts, recentOrders] = await Promise.all([
      this.getStats(since),
      this.getQuickStats(since),
      this.getSalesTrend(since, timeRange === 'year' ? '%Y-%m' : '%Y-%m-%d'),
      this.getTopProducts(since, 10),
      this.getRecentOrders(10),
    ]);
    return { timeRange, stats, quickStats, salesTrend, topProducts, recentOrders };
  }

  async getStats(since) {
    const [sales, allBills, refunded, today, totalUsers, totalProducts] = await Promise.all([
      POSOrder.aggregate([
        { $match: { ...SALE_MATCH, createdAt: { $gte: since } } },
        { $group: { _id: null, bills: { $sum: 1 }, revenue: { $sum: '$total' } } },
      ]),
      POSOrder.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: since } }),
      POSOrder.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: since }, orderStatus: 'refunded' }),
      POSOrder.countDocuments({ ...SALE_MATCH, createdAt: { $gte: startOfToday() } }),
      User.countDocuments(CUSTOMER_FILTER),
      Product.countDocuments({ status: 'published' }),
    ]);
    const s = sales[0] || { bills: 0, revenue: 0 };
    return {
      totalSales: s.bills, // number of sale bills in the range
      totalRevenue: s.revenue,
      avgOrderValue: s.bills ? s.revenue / s.bills : 0,
      ordersToday: today,
      refundRate: allBills ? (refunded / allBills) * 100 : 0,
      totalUsers, // POS customers
      totalProducts, // published products
    };
  }

  async getQuickStats(since) {
    const [pendingOrders, lowStockItems, newCustomers, returnedItems] = await Promise.all([
      // Credit sales not fully paid yet.
      POSOrder.countDocuments({ ...SALE_MATCH, paymentStatus: { $in: ['pending', 'partial'] } }),
      Product.countDocuments({ status: 'published', stock: { $lt: LOW_STOCK } }),
      User.countDocuments({ ...CUSTOMER_FILTER, createdAt: { $gte: since } }),
      POSOrder.countDocuments({ isDeleted: { $ne: true }, orderStatus: 'refunded', createdAt: { $gte: since } }),
    ]);
    return { pendingOrders, lowStockItems, newCustomers, returnedItems };
  }

  /** [{ date, sales, orders }] per day (per month for 'year'). */
  async getSalesTrend(since, format) {
    const rows = await POSOrder.aggregate([
      { $match: { ...SALE_MATCH, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          sales: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({ date: r._id, sales: r.sales, orders: r.orders }));
  }

  /** Best sellers by revenue: [{ id, name, sales (pieces), revenue, stock }]. Gifts excluded. */
  async getTopProducts(since, limit) {
    const rows = await POSOrder.aggregate([
      { $match: { ...SALE_MATCH, createdAt: { $gte: since } } },
      { $unwind: '$items' },
      { $match: { 'items.product': { $ne: null }, 'items.isGift': { $ne: true } } },
      {
        $group: {
          _id: '$items.product',
          sales: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
    ]);
    return rows.map((r) => ({
      id: String(r._id),
      name: r.product.name,
      sales: r.sales,
      revenue: r.revenue,
      stock: r.product.stock || 0,
    }));
  }

  /** Latest bills: [{ id, orderNumber, customerId, customerName, amount, status, createdAt }]. */
  async getRecentOrders(limit) {
    const orders = await POSOrder.find({ isDeleted: { $ne: true } })
      .select('orderNumber total orderStatus paymentStatus createdAt customer customerInfo')
      .populate('customer', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return orders.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber,
      customerId: o.customer && o.customer._id ? String(o.customer._id) : '',
      customerName: customerName(o),
      amount: o.total,
      status: o.orderStatus,
      createdAt: o.createdAt,
    }));
  }
}

module.exports = new DashboardService();
