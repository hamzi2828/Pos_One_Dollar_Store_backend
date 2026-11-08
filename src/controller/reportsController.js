// Reports Controller — server-side aggregation for the admin Reports section.
// Sales come from POS orders (the shop's counter sales).
//
// The cash-in-hand report is the critical one. All figures are computed here
// so the frontend displays a single trusted snapshot. Dates are interpreted in
// the server's local timezone at the day boundary (start: 00:00:00, end:
// 23:59:59.999) — the client sends YYYY-MM-DD strings.
const POSOrder = require('../models/posOrder');
const Expense = require('../models/expense');
const Salary = require('../models/salary');
const Purchase = require('../models/purchase');
const Product = require('../models/product');
// Force-register schemas referenced only through populate() so isolated test
// runs (that don't touch these models directly) don't crash with
// "Schema hasn't been registered for model X".
require('../models/user');
require('../models/employee');
require('../models/vendor');

// Read pagination params off the query with sane defaults + upper bound so a
// bad client can't exfil the whole collection.
function parsePagination(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  let limit = parseInt(String(query.limit || defaultLimit), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(maxLimit, limit);
  return { page, limit, skip: (page - 1) * limit };
}

function buildPagination(page, limit, total) {
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Bills that count as sales (refunded / cancelled / deleted bills do not).
const SALE_MATCH = {
  isDeleted: { $ne: true },
  orderStatus: { $nin: ['refunded', 'cancelled'] },
  paymentStatus: { $ne: 'refunded' },
};

// Cost of goods of one bill: each line's cost snapshot (taken at sale time,
// gifts included) x qty; old lines without a snapshot use the product's
// current cost (needs items.product populated with costPrice).
const billCost = (items) =>
  (items || []).reduce((sum, it) => {
    const qty = Number(it.quantity) || 0;
    const snapshot = Number(it.costPrice);
    if (it.costPrice !== undefined && it.costPrice !== null && Number.isFinite(snapshot)) return sum + snapshot * qty;
    const prod = it.product && typeof it.product === 'object' ? it.product : null;
    const current = prod ? Number(prod.costPrice) : NaN;
    return Number.isFinite(current) && current > 0 ? sum + current * qty : sum;
  }, 0);

// Parse YYYY-MM-DD → Date set to local start/end of day. Invalid input returns null.
const toStartOfDay = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};
const toEndOfDay = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

// Normalize expense paymentMethod string → 'cash' | 'bank' | 'other'.
const normalizeExpenseMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'bank transfer' || v === 'bank_transfer' || v === 'bank' || v === 'debit card' || v === 'credit card' || v === 'cheque' || v === 'check') return 'bank';
  return 'other';
};

// Normalize salary / purchase payment method → 'cash' | 'bank' | 'other'.
const normalizeFinanceMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'bank' || v === 'bank_transfer' || v === 'card' || v === 'cheque' || v === 'check') return 'bank';
  return 'other';
};

// Normalize POS payment method → 'cash' | 'card' | 'bank' | 'other'.
// Card is split out for sales because cards settle through bank but operators
// often want to see the card slice independently.
const normalizePOSMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'card') return 'card';
  if (v === 'bank_transfer' || v === 'bank') return 'bank';
  return 'other';
};

const reportsController = {
  // GET /api/reports/cash-in-hand?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  cashInHand: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);

      if (!start || !end) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate (YYYY-MM-DD) are required',
        });
      }

      // ---------- 1. POS orders in window ----------
      const periodOrders = await POSOrder.find({
        isDeleted: { $ne: true },
        createdAt: { $gte: start, $lte: end },
      }).lean();

      // Full-paid orders = sales that settled at the register. Their totals go
      // straight to "Total Sales" bucketed by payment method.
      const salesBreakdown = { totalSales: 0, cashSales: 0, cardSales: 0, bankTransfer: 0 };
      const fullPaidOrders = periodOrders.filter((o) => o.paymentStatus === 'full' || o.paymentStatus === 'completed');
      for (const o of fullPaidOrders) {
        salesBreakdown.totalSales += o.total || 0;
        const m = normalizePOSMethod(o.paymentMethod);
        if (m === 'cash') salesBreakdown.cashSales += o.total || 0;
        else if (m === 'card') salesBreakdown.cardSales += o.total || 0;
        else if (m === 'bank') salesBreakdown.bankTransfer += o.total || 0;
      }

      // Receivables snapshot = pending + partial orders as of now (not date
      // filtered: receivables are a balance, not a flow).
      const openOrders = await POSOrder.find({
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
      })
        .select('paymentStatus pendingAmount total')
        .lean();

      const pendingOrders = openOrders.filter((o) => o.paymentStatus === 'pending');
      const partialOrders = openOrders.filter((o) => o.paymentStatus === 'partial');
      const receivableData = {
        totalReceivable:
          pendingOrders.reduce((s, o) => s + (o.pendingAmount ?? o.total ?? 0), 0) +
          partialOrders.reduce((s, o) => s + (o.pendingAmount ?? 0), 0),
        pendingCount: pendingOrders.length,
        partialCount: partialOrders.length,
      };

      // ---------- 2. Payments received (installments on pending/partial orders) ----------
      // Any order whose paymentHistory is not a single "full at register" entry
      // contributes individual payments to this flow when the payment date falls
      // within the window. This captures initial partials + later catch-up
      // payments without double-counting full-paid sales.
      const ordersWithHistory = await POSOrder.find({
        isDeleted: { $ne: true },
        'paymentHistory.0': { $exists: true },
      })
        .select('total paymentHistory')
        .lean();

      const paymentsReceived = { total: 0, cash: 0, card: 0, bank: 0, count: 0 };
      for (const o of ordersWithHistory) {
        const history = o.paymentHistory || [];
        const isDirectFullPayment =
          history.length === 1 && (history[0].amount || 0) >= (o.total || 0);
        if (isDirectFullPayment) continue;

        for (const p of history) {
          const paidAt = p.paidAt ? new Date(p.paidAt) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(p.amount) || 0;
          paymentsReceived.count += 1;
          const m = normalizePOSMethod(p.paymentMethod);
          if (m === 'cash') paymentsReceived.cash += amt;
          else if (m === 'card') paymentsReceived.card += amt;
          else if (m === 'bank') paymentsReceived.bank += amt;
        }
      }
      paymentsReceived.total = paymentsReceived.cash + paymentsReceived.card + paymentsReceived.bank;

      // ---------- 3. Expenses in window ----------
      // Shop use (own stock) and personal-money expenses never take shop cash.
      const expenses = await Expense.find({
        isDeleted: { $ne: true },
        date: { $gte: start, $lte: end },
        source: { $ne: 'shop_use' },
        fromPersonal: { $ne: true },
      })
        .select('amount paymentMethod')
        .lean();

      const expenseSummary = { totalExpenses: 0, cashExpenses: 0, bankExpenses: 0 };
      for (const e of expenses) {
        const amt = Number(e.amount) || 0;
        expenseSummary.totalExpenses += amt;
        const m = normalizeExpenseMethod(e.paymentMethod);
        if (m === 'cash') expenseSummary.cashExpenses += amt;
        else if (m === 'bank') expenseSummary.bankExpenses += amt;
      }

      // ---------- 4. Vendor payments (purchase.payments) in window ----------
      const purchases = await Purchase.find({
        isDeleted: { $ne: true },
        'payments.0': { $exists: true },
      })
        .select('payments')
        .lean();

      const vendorSummary = { totalPaid: 0, cashPaid: 0, bankPaid: 0 };
      for (const p of purchases) {
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          vendorSummary.totalPaid += amt;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') vendorSummary.cashPaid += amt;
          else if (m === 'bank') vendorSummary.bankPaid += amt;
        }
      }

      // Vendor payments are saved in vendorpayments (Purchasing → Vendor payments).
      // Easypaisa / JazzCash / cheque leave from the bank side.
      const db = Expense.db.db;
      const vps = await db.collection('vendorpayments')
        .find({ status: 'active', date: { $gte: start, $lte: end } })
        .project({ amount: 1, method: 1 })
        .toArray();
      for (const v of vps) {
        const amt = Number(v.amount) || 0;
        vendorSummary.totalPaid += amt;
        if (String(v.method) === 'cash') vendorSummary.cashPaid += amt;
        else vendorSummary.bankPaid += amt;
      }
      vendorSummary.payments = vps.length;
      // Trip costs on purchase trips (freight, fare...) are paid in cash.
      vendorSummary.tripCosts = 0;
      const tripPos = await db.collection('purchaseorders')
        .find({ charges: { $elemMatch: { createdAt: { $gte: start, $lte: end } } } })
        .project({ charges: 1 })
        .toArray();
      for (const po of tripPos)
        for (const c of po.charges || [])
          if (c.createdAt && c.createdAt >= start && c.createdAt <= end) vendorSummary.tripCosts += Number(c.amount) || 0;
      vendorSummary.totalPaid += vendorSummary.tripCosts;
      vendorSummary.cashPaid += vendorSummary.tripCosts;

      // ---------- Loans: money borrowed in, paid back out ----------
      // A loan that paid an expense straight away (personal money) never came in.
      const loanSummary = { received: 0, cashIn: 0, bankIn: 0, paidBack: 0, cashOut: 0, bankOut: 0 };
      const loanSide = (m) => (String(m || '').toLowerCase() === 'cash' ? 'cash' : 'bank');
      const loanRows = await db.collection('loans')
        .find({ isDeleted: { $ne: true }, $or: [{ date: { $gte: start, $lte: end } }, { 'repayments.date': { $gte: start, $lte: end } }] })
        .project({ amount: 1, method: 1, date: 1, expense: 1, repayments: 1 })
        .toArray();
      for (const l of loanRows) {
        if (!l.expense && l.date >= start && l.date <= end) {
          const amt = Number(l.amount) || 0;
          loanSummary.received += amt;
          if (loanSide(l.method) === 'cash') loanSummary.cashIn += amt;
          else loanSummary.bankIn += amt;
        }
        for (const r of l.repayments || []) {
          if (!r.date || r.date < start || r.date > end) continue;
          const amt = Number(r.amount) || 0;
          loanSummary.paidBack += amt;
          if (loanSide(r.method) === 'cash') loanSummary.cashOut += amt;
          else loanSummary.bankOut += amt;
        }
      }

      // ---------- 5. Salary payments in window ----------
      const salaries = await Salary.find({
        isDeleted: { $ne: true },
        'payments.0': { $exists: true },
      })
        .select('payments remainingBalance')
        .lean();

      const salarySummary = { totalPaid: 0, cashPaid: 0, bankPaid: 0, totalRemaining: 0 };
      for (const s of salaries) {
        salarySummary.totalRemaining += Number(s.remainingBalance) || 0;
        for (const pay of s.payments || []) {
          const paidAt = pay.date ? new Date(pay.date) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          salarySummary.totalPaid += amt;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') salarySummary.cashPaid += amt;
          else if (m === 'bank') salarySummary.bankPaid += amt;
        }
      }

      // ---------- 6. Derived balances ----------
      const cashBalance =
        salesBreakdown.cashSales +
        paymentsReceived.cash -
        expenseSummary.cashExpenses -
        vendorSummary.cashPaid -
        salarySummary.cashPaid +
        loanSummary.cashIn -
        loanSummary.cashOut;

      const bankBalance =
        salesBreakdown.bankTransfer +
        salesBreakdown.cardSales +
        paymentsReceived.bank +
        paymentsReceived.card -
        expenseSummary.bankExpenses -
        vendorSummary.bankPaid -
        salarySummary.bankPaid +
        loanSummary.bankIn -
        loanSummary.bankOut;

      return res.status(200).json({
        success: true,
        data: {
          period: { start: start.toISOString(), end: end.toISOString() },
          salesBreakdown,
          paymentsReceived,
          expenseSummary,
          vendorSummary,
          salarySummary,
          loanSummary,
          receivableData,
          balances: {
            cashBalance,
            bankBalance,
            totalBalance: cashBalance + bankBalance,
          },
        },
        message: 'Cash in hand report generated',
      });
    } catch (error) {
      console.error('Cash in hand report error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate cash-in-hand report',
        error: error.message,
      });
    }
  },

  // GET /api/reports/sales-summary?startDate=&endDate=&page=&limit=
  // Every POS bill of the window with cost / profit and payment-method totals.
  salesSummary: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const orders = await POSOrder.find({
        isDeleted: { $ne: true },
        createdAt: { $gte: start, $lte: end },
      })
        .select('orderNumber total paidAmount pendingAmount paymentMethod paymentStatus orderStatus createdAt items customerInfo customer counter cashSession')
        .populate('customer', 'firstName lastName phone')
        .populate('items.product', 'name costPrice')
        .sort({ createdAt: -1 })
        .lean();

      // Counter each bill was rung on ("Counter 1"...): the bill's counter, else its till's.
      const counterNames = new Map(
        (await require('../models/saleCounter').find({}).select('name').lean()).map((c) => [String(c._id), c.name])
      );
      const noCounter = [...new Set(orders.filter((o) => !o.counter && o.cashSession).map((o) => String(o.cashSession)))];
      const sessionCounter = new Map(
        noCounter.length
          ? (await require('../models/cashSession').find({ _id: { $in: noCounter } }).select('counter counterName').lean()).map((s) => [
              String(s._id),
              (s.counter && counterNames.get(String(s.counter))) || s.counterName || null,
            ])
          : []
      );
      const counterOf = (o) =>
        (o.counter && counterNames.get(String(o.counter))) || (o.cashSession && sessionCounter.get(String(o.cashSession))) || null;

      const summary = {
        totalOrders: 0,
        totalSales: 0,
        totalPaid: 0,
        totalPending: 0,
        totalCost: 0,
        totalProfit: 0,
        cashSales: 0,
        cardSales: 0,
        bankSales: 0,
        itemsSold: 0,
        avgOrderValue: 0,
      };

      const rows = orders.map((o) => {
        const orderCost = billCost(o.items);
        const profit = (o.total || 0) - orderCost;
        summary.totalCost += orderCost;
        summary.totalProfit += profit;
        summary.totalSales += o.total || 0;
        summary.totalPaid += o.paidAmount || 0;
        summary.totalPending += o.pendingAmount || 0;
        // Pieces on the bill (quantity), not lines.
        const itemCount = (o.items || []).reduce((n, it) => n + (Number(it.quantity) || 0), 0);
        summary.itemsSold += itemCount;
        const m = normalizePOSMethod(o.paymentMethod);
        if (m === 'cash') summary.cashSales += o.total || 0;
        else if (m === 'card') summary.cardSales += o.total || 0;
        else if (m === 'bank') summary.bankSales += o.total || 0;
        return { ...o, costPrice: orderCost, profit, itemCount, counterName: counterOf(o) };
      });

      // Same totals split by counter (owner, 2026-11-08).
      const byCounterMap = new Map();
      for (const r of rows) {
        const name = r.counterName || 'No counter';
        const c =
          byCounterMap.get(name) ||
          { name, orders: 0, sales: 0, paid: 0, pending: 0, cost: 0, profit: 0, cash: 0, card: 0, bank: 0, items: 0 };
        c.orders += 1;
        c.sales += r.total || 0;
        c.paid += r.paidAmount || 0;
        c.pending += r.pendingAmount || 0;
        c.cost += r.costPrice || 0;
        c.profit += r.profit || 0;
        c.items += r.itemCount || 0;
        const m = normalizePOSMethod(r.paymentMethod);
        if (m === 'cash') c.cash += r.total || 0;
        else if (m === 'card') c.card += r.total || 0;
        else if (m === 'bank') c.bank += r.total || 0;
        byCounterMap.set(name, c);
      }
      summary.byCounter = [...byCounterMap.values()].sort((a, b) => a.name.localeCompare(b.name));

      summary.totalOrders = rows.length;
      summary.avgOrderValue = summary.totalOrders ? summary.totalSales / summary.totalOrders : 0;

      // Summary covers every bill of the window; only the rows are paginated.
      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });

      return res.status(200).json({
        success: true,
        data: { summary, orders: rows.slice(skip, skip + limit) },
        pagination: buildPagination(page, limit, rows.length),
        message: 'Sales summary generated',
      });
    } catch (error) {
      console.error('Sales summary error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate sales summary', error: error.message });
    }
  },

  // GET /api/reports/purchases-summary?startDate=&endDate=
  purchasesSummary: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const purchases = await Purchase.find({
        isDeleted: { $ne: true },
        purchaseDate: { $gte: start, $lte: end },
      })
        .select('invoiceNumber vendorName vendorId purchaseDate total paidAmount pendingAmount paymentStatus items payments')
        .sort({ purchaseDate: -1 })
        .lean();

      const summary = {
        totalPurchases: purchases.length,
        totalAmount: 0,
        totalPaid: 0,
        totalPending: 0,
        cashPaid: 0,
        bankPaid: 0,
      };
      for (const p of purchases) {
        summary.totalAmount += p.total || 0;
        summary.totalPaid += p.paidAmount || 0;
        summary.totalPending += p.pendingAmount || 0;
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') summary.cashPaid += amt;
          else if (m === 'bank') summary.bankPaid += amt;
        }
      }

      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
      const pagePurchases = purchases.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: { summary, purchases: pagePurchases },
        pagination: buildPagination(page, limit, purchases.length),
        message: 'Purchases summary generated',
      });
    } catch (error) {
      console.error('Purchases summary error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate purchases summary', error: error.message });
    }
  },

  // GET /api/reports/stock?filter=all|low|out&threshold=10
  // Snapshot of current product inventory. Not date-filtered — stock is a
  // balance, not a flow.
  stock: async (req, res) => {
    try {
      const filter = String(req.query.filter || 'all').toLowerCase();
      const threshold = Math.max(0, parseInt(String(req.query.threshold || '10'), 10) || 10);
      const search = String(req.query.search || '').trim();
      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });

      // Build stock-status filter via query expressions so the DB does the work.
      const baseQuery = { isDeleted: { $ne: true } };
      if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        baseQuery.$or = [{ name: rx }, { category: rx }, { slug: rx }];
      }
      const stockFilteredQuery = { ...baseQuery };
      if (filter === 'out') stockFilteredQuery.stock = { $lte: 0 };
      else if (filter === 'low') stockFilteredQuery.stock = { $gt: 0, $lte: threshold };

      // Summary aggregated across all products (ignores status filter so the
      // tiles give a shop-wide view) — fast single pipeline.
      const [summaryAgg, total, pageProducts] = await Promise.all([
        Product.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              totalProducts: { $sum: 1 },
              totalInStock: {
                $sum: { $cond: [{ $gt: ['$stock', threshold] }, 1, 0] },
              },
              totalLowStock: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', threshold] }] },
                    1,
                    0,
                  ],
                },
              },
              totalOutOfStock: {
                $sum: { $cond: [{ $lte: ['$stock', 0] }, 1, 0] },
              },
              totalUnits: { $sum: { $ifNull: ['$stock', 0] } },
              totalInventoryValue: {
                $sum: {
                  $multiply: [
                    { $ifNull: ['$stock', 0] },
                    { $ifNull: ['$costPrice', 0] },
                  ],
                },
              },
            },
          },
        ]),
        Product.countDocuments(stockFilteredQuery),
        Product.find(stockFilteredQuery)
          .select('name slug category status productType stock variants price costPrice discountedPrice thumbnailUrl updatedAt')
          .sort({ category: 1, name: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      const rows = pageProducts.map((p) => {
        const stock = Number(p.stock) || 0;
        const costPrice = Number(p.costPrice) || 0;
        const inventoryValue = stock * costPrice;
        let stockStatus = 'in_stock';
        if (stock <= 0) stockStatus = 'out_of_stock';
        else if (stock <= threshold) stockStatus = 'low_stock';
        return {
          _id: p._id,
          name: p.name,
          slug: p.slug,
          category: p.category,
          status: p.status,
          productType: p.productType,
          stock,
          variantCount: Array.isArray(p.variants) ? p.variants.length : 0,
          price: Number(p.price) || 0,
          costPrice,
          discountedPrice: p.discountedPrice ?? null,
          thumbnailUrl: p.thumbnailUrl || null,
          inventoryValue,
          stockStatus,
          updatedAt: p.updatedAt,
        };
      });

      const sa = summaryAgg[0] || {
        totalProducts: 0,
        totalInStock: 0,
        totalLowStock: 0,
        totalOutOfStock: 0,
        totalUnits: 0,
        totalInventoryValue: 0,
      };

      return res.status(200).json({
        success: true,
        data: { summary: { ...sa, threshold }, products: rows },
        pagination: buildPagination(page, limit, total),
        message: 'Stock report generated',
      });
    } catch (error) {
      console.error('Stock report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate stock report', error: error.message });
    }
  },

  // GET /api/reports/expenses?startDate=&endDate=&category=&method=
  expensesReport: async (req, res) => {
    try {
      const { startDate, endDate, category, method, search } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const query = { isDeleted: { $ne: true }, date: { $gte: start, $lte: end } };
      if (category && category !== 'all') query.category = category;
      if (method && method !== 'all') query.paymentMethod = method;
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ title: rx }, { reference: rx }, { category: rx }];
      }

      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });

      // Summary aggregation — runs on indexed fields, independent of pagination.
      const [summaryAgg, byCategoryAgg, byMethodAgg, total, pageRows] = await Promise.all([
        Expense.aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              cashTotal: {
                $sum: {
                  $cond: [{ $eq: [{ $toLower: '$paymentMethod' }, 'cash'] }, '$amount', 0],
                },
              },
              bankTotal: {
                $sum: {
                  $cond: [
                    { $in: [{ $toLower: '$paymentMethod' }, ['bank transfer', 'bank_transfer', 'bank', 'debit card', 'credit card', 'cheque', 'check']] },
                    '$amount',
                    0,
                  ],
                },
              },
            },
          },
        ]),
        Expense.aggregate([
          { $match: query },
          { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ]),
        Expense.aggregate([
          { $match: query },
          { $group: { _id: { $ifNull: ['$paymentMethod', 'Other'] }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ]),
        Expense.countDocuments(query),
        Expense.find(query)
          .select('title amount category categories date paymentMethod reference notes')
          .sort({ date: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      const s = summaryAgg[0] || { total: 0, count: 0, cashTotal: 0, bankTotal: 0 };

      return res.status(200).json({
        success: true,
        data: {
          summary: {
            total: s.total || 0,
            count: s.count || 0,
            cashTotal: s.cashTotal || 0,
            bankTotal: s.bankTotal || 0,
            avgExpense: s.count ? s.total / s.count : 0,
          },
          byCategory: byCategoryAgg.map((b) => ({ category: b._id, amount: b.amount })),
          byMethod: byMethodAgg.map((b) => ({ method: b._id, amount: b.amount })),
          expenses: pageRows,
        },
        pagination: buildPagination(page, limit, total),
        message: 'Expense report generated',
      });
    } catch (error) {
      console.error('Expense report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate expense report', error: error.message });
    }
  },

  // GET /api/reports/vendor-payments?startDate=&endDate=&vendorId=
  vendorPaymentsReport: async (req, res) => {
    try {
      const { startDate, endDate, vendorId } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      // Pull all non-deleted purchases (not just ones with payments) so the
      // page can also surface unpaid invoices as outstanding obligations.
      const query = { isDeleted: { $ne: true } };
      if (vendorId) query.vendorId = vendorId;

      const purchases = await Purchase.find(query)
        .select('invoiceNumber vendorId vendorName purchaseDate dueDate total paidAmount pendingAmount paymentStatus payments')
        .populate('vendorId', 'name email phone')
        .lean();

      const payments = [];
      const byVendor = new Map();
      const byMethod = new Map();
      let total = 0;
      let cashTotal = 0;
      let bankTotal = 0;

      for (const p of purchases) {
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          total += amt;
          const n = normalizeFinanceMethod(pay.paymentMethod);
          if (n === 'cash') cashTotal += amt;
          else if (n === 'bank') bankTotal += amt;

          const vendorName = p.vendorName || (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') || 'Unknown vendor';
          const vKey = vendorName.toLowerCase();
          if (!byVendor.has(vKey)) {
            byVendor.set(vKey, { vendor: vendorName, count: 0, amount: 0 });
          }
          const vStat = byVendor.get(vKey);
          vStat.count += 1;
          vStat.amount += amt;

          const mKey = String(pay.paymentMethod || 'other').toLowerCase();
          byMethod.set(mKey, (byMethod.get(mKey) || 0) + amt);

          payments.push({
            _id: pay._id,
            date: pay.paymentDate,
            amount: amt,
            paymentMethod: pay.paymentMethod,
            reference: pay.reference || '',
            notes: pay.notes || '',
            invoiceNumber: p.invoiceNumber,
            purchaseId: p._id,
            vendorName,
            vendorId: p.vendorId && typeof p.vendorId === 'object' ? p.vendorId._id : p.vendorId,
            invoiceTotal: Number(p.total) || 0,
            invoicePaid: Number(p.paidAmount) || 0,
            invoicePending: Number(p.pendingAmount) || 0,
          });
        }
      }

      payments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Server-side search filter on payments (by vendor / invoice / reference).
      const searchRaw = String(req.query.search || '').trim();
      let filteredPayments = payments;
      if (searchRaw) {
        const q = searchRaw.toLowerCase();
        filteredPayments = payments.filter(
          (p) =>
            (p.vendorName || '').toLowerCase().includes(q) ||
            (p.invoiceNumber || '').toLowerCase().includes(q) ||
            (p.reference || '').toLowerCase().includes(q),
        );
      }

      // Per-vendor roll-up across ALL of their invoices (not just the ones
      // with a payment in the window). Gives operators a full AP picture
      // side-by-side with the window payment totals.
      const vendorRollup = new Map();
      for (const p of purchases) {
        const vendorName =
          p.vendorName ||
          (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') ||
          'Unknown vendor';
        const key = vendorName.toLowerCase();
        if (!vendorRollup.has(key)) {
          vendorRollup.set(key, {
            vendor: vendorName,
            invoiceCount: 0,
            invoiceTotal: 0,
            invoicePaid: 0,
            invoicePending: 0,
          });
        }
        const r = vendorRollup.get(key);
        r.invoiceCount += 1;
        r.invoiceTotal += Number(p.total) || 0;
        r.invoicePaid += Number(p.paidAmount) || 0;
        r.invoicePending += Number(p.pendingAmount) || 0;
      }

      // Merge payment-window stats with the lifetime roll-up. Every vendor
      // shows up regardless of whether they had activity in the window.
      const byVendorRows = Array.from(vendorRollup.values()).map((r) => {
        const key = r.vendor.toLowerCase();
        const windowStats = byVendor.get(key) || { count: 0, amount: 0 };
        return {
          vendor: r.vendor,
          count: windowStats.count,
          amount: windowStats.amount,
          invoiceCount: r.invoiceCount,
          invoiceTotal: r.invoiceTotal,
          invoicePaid: r.invoicePaid,
          invoicePending: r.invoicePending,
        };
      });

      // Outstanding invoices — unpaid balance across all non-deleted invoices,
      // regardless of whether any payment has been made inside the window.
      // This is what owners usually want to see on "vendor payments".
      const outstandingInvoices = purchases
        .filter((p) => (Number(p.pendingAmount) || 0) > 0)
        .map((p) => ({
          _id: p._id,
          invoiceNumber: p.invoiceNumber,
          vendorName:
            p.vendorName ||
            (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') ||
            'Unknown vendor',
          vendorId: p.vendorId && typeof p.vendorId === 'object' ? p.vendorId._id : p.vendorId,
          purchaseDate: p.purchaseDate,
          dueDate: p.dueDate || null,
          total: Number(p.total) || 0,
          paidAmount: Number(p.paidAmount) || 0,
          pendingAmount: Number(p.pendingAmount) || 0,
          paymentStatus: p.paymentStatus,
        }))
        .sort((a, b) => b.pendingAmount - a.pendingAmount);

      const outstandingSummary = outstandingInvoices.reduce(
        (acc, inv) => {
          acc.count += 1;
          acc.totalPending += inv.pendingAmount;
          acc.totalInvoiced += inv.total;
          acc.totalPaid += inv.paidAmount;
          return acc;
        },
        { count: 0, totalPending: 0, totalInvoiced: 0, totalPaid: 0 },
      );

      // Payments tab is the one the user paginates; Outstanding + By Vendor
      // are small aggregations and stay full. The `count` summary reflects
      // the window-level total regardless of search so the summary tiles
      // don't shift when the user types.
      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
      const pagePayments = filteredPayments.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: {
          summary: {
            total,
            count: payments.length,
            cashTotal,
            bankTotal,
            uniqueVendors: byVendor.size,
            outstanding: outstandingSummary,
          },
          byVendor: byVendorRows.sort(
            (a, b) => (b.invoicePending || 0) - (a.invoicePending || 0) || b.invoiceTotal - a.invoiceTotal,
          ),
          byMethod: Array.from(byMethod.entries())
            .map(([method, amount]) => ({ method, amount }))
            .sort((a, b) => b.amount - a.amount),
          payments: pagePayments,
          outstandingInvoices,
        },
        pagination: buildPagination(page, limit, filteredPayments.length),
        message: 'Vendor payments report generated',
      });
    } catch (error) {
      console.error('Vendor payments report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate vendor payments report', error: error.message });
    }
  },

  // GET /api/reports/cost-analysis?startDate=&endDate=
  // Revenue (sales), cost of goods sold, expenses and profit for the window.
  costAnalysis: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const orders = await POSOrder.find({ ...SALE_MATCH, createdAt: { $gte: start, $lte: end } })
        .select('total items')
        .populate('items.product', 'costPrice')
        .lean();

      let revenue = 0;
      let cogs = 0;
      let itemCount = 0;
      for (const o of orders) {
        revenue += o.total || 0;
        cogs += billCost(o.items);
        for (const it of o.items || []) itemCount += Number(it.quantity) || 0;
      }

      // Shop use (own stock) is only shown in the expenses report, never subtracted.
      const expenses = await Expense.find({
        isDeleted: { $ne: true },
        date: { $gte: start, $lte: end },
        source: { $ne: 'shop_use' },
      })
        .select('amount')
        .lean();
      const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - totalExpenses;

      return res.status(200).json({
        success: true,
        data: {
          revenue,
          cogs,
          totalExpenses,
          grossProfit,
          netProfit,
          orderCount: orders.length,
          itemCount,
          grossMargin: revenue ? (grossProfit / revenue) * 100 : 0,
          netMargin: revenue ? (netProfit / revenue) * 100 : 0,
        },
        message: 'Cost analysis generated',
      });
    } catch (error) {
      console.error('Cost analysis error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate cost analysis', error: error.message });
    }
  },
};

module.exports = reportsController;
