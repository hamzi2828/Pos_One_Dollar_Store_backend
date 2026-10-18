const Purchase = require('../models/purchase');
const Vendor = require('../models/vendor');
const Product = require('../models/product');
const { resolveWriteBranch } = require('../middleware/access');

// Purchases (old procurement screen). They do NOT move stock — receiving
// stock is a separate step.

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

// Invoice format: PO-YYMMDD-RRR where RRR is 3 random digits.
// We retry on collision since invoiceNumber is uniquely indexed.
const generateInvoiceNumber = async () => {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  for (let i = 0; i < 6; i += 1) {
    const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const candidate = `PO-${yy}${mm}${dd}-${rnd}`;
    const dup = await Purchase.exists({ invoiceNumber: candidate });
    if (!dup) return candidate;
  }
  // Fallback — effectively unique; collision probability is negligible.
  return `PO-${yy}${mm}${dd}-${Date.now().toString().slice(-6)}`;
};

const mongoose = require('mongoose');

const sanitizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const qty = Math.max(0, Number(it.quantity) || 0);
      const unit = Math.max(0, Number(it.unitPrice) || 0);
      const productId =
        it.productId && mongoose.Types.ObjectId.isValid(it.productId) ? it.productId : null;
      return {
        productId,
        productName: String(it.productName || '').trim(),
        productSku: String(it.productSku || '').trim(),
        description: String(it.description || '').trim(),
        quantity: qty,
        unitPrice: unit,
        total: qty * unit,
      };
    })
    .filter((it) => it.description);
};

const purchaseController = {
  // GET /admin/procurement/purchases
  list: async (req, res) => {
    try {
      const page = clampInt(req.query.page, 1, 10_000, 1);
      const limit = clampInt(req.query.limit, 1, 100, 20);
      const {
        search,
        vendorId,
        status,
        dateFrom,
        dateTo,
        sortBy = 'purchaseDate',
        sortDir = 'desc',
      } = req.query;

      const filter = { isDeleted: false };
      if (vendorId) filter.vendorId = vendorId;
      if (status && ['pending', 'partial', 'paid', 'overdue'].includes(status)) {
        filter.paymentStatus = status;
      }
      if (dateFrom || dateTo) {
        filter.purchaseDate = {};
        if (dateFrom) filter.purchaseDate.$gte = new Date(dateFrom);
        if (dateTo) {
          const to = new Date(dateTo);
          to.setHours(23, 59, 59, 999);
          filter.purchaseDate.$lte = to;
        }
      }
      if (search && String(search).trim()) {
        filter.$text = { $search: String(search).trim() };
      }

      const sort = { [sortBy]: sortDir === 'asc' ? 1 : -1 };

      const [items, total, totals] = await Promise.all([
        Purchase.find(filter)
          .select('-payments') // don't ship payment history on list view
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Purchase.countDocuments(filter),
        Purchase.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$total' },
              totalPaid: { $sum: '$paidAmount' },
              totalPending: { $sum: '$pendingAmount' },
            },
          },
        ]),
      ]);

      const sums = totals[0] || { totalAmount: 0, totalPaid: 0, totalPending: 0 };

      return res.status(200).json({
        message: 'Purchases',
        data: items,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        totals: {
          amount: sums.totalAmount || 0,
          paid: sums.totalPaid || 0,
          pending: sums.totalPending || 0,
        },
      });
    } catch (error) {
      console.error('purchase.list error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/purchases/:id
  getById: async (req, res) => {
    try {
      const p = await Purchase.findOne({ _id: req.params.id, isDeleted: false })
        .lean();
      if (!p) return res.status(404).json({ message: 'Purchase not found' });
      return res.status(200).json({ message: 'Purchase', data: p });
    } catch (error) {
      console.error('purchase.getById error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // POST /admin/procurement/purchases
  create: async (req, res) => {
    try {
      const {
        vendorId,
        invoiceNumber,
        purchaseDate,
        dueDate,
        items,
        taxPercent,
        discount,
        notes,
      } = req.body || {};

      if (!vendorId) return res.status(400).json({ message: 'vendorId is required' });

      const branch = await resolveWriteBranch(req);

      const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: false }).lean();
      if (!vendor) return res.status(400).json({ message: 'Vendor not found' });

      const cleanItems = sanitizeItems(items);
      if (cleanItems.length === 0) {
        return res.status(400).json({ message: 'At least one line item is required' });
      }

      const inv = invoiceNumber && String(invoiceNumber).trim()
        ? String(invoiceNumber).trim()
        : await generateInvoiceNumber();

      // If the admin provided the invoice number, double-check uniqueness.
      if (invoiceNumber) {
        const dup = await Purchase.exists({ invoiceNumber: inv, isDeleted: false });
        if (dup) return res.status(400).json({ message: 'Invoice number already exists' });
      }

      const doc = new Purchase({
        branch,
        vendorId: vendor._id,
        vendorName: vendor.name,
        invoiceNumber: inv,
        purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
        dueDate: dueDate ? new Date(dueDate) : null,
        items: cleanItems,
        taxPercent: Math.max(0, Math.min(100, Number(taxPercent) || 0)),
        discount: Math.max(0, Number(discount) || 0),
        notes: String(notes || '').trim(),
        createdBy: req.user?._id || null,
      });

      await doc.save(); // pre-save hook recalcs totals/status
      return res.status(201).json({ message: 'Purchase created', data: doc });
    } catch (error) {
      console.error('purchase.create error:', error);
      if (error.code === 11000) {
        return res.status(400).json({ message: 'Invoice number already exists' });
      }
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // PUT /admin/procurement/purchases/:id
  update: async (req, res) => {
    try {
      const p = await Purchase.findOne({ _id: req.params.id, isDeleted: false });
      if (!p) return res.status(404).json({ message: 'Purchase not found' });

      const { purchaseDate, dueDate, items, taxPercent, discount, notes, vendorId } = req.body || {};

      if (vendorId && String(vendorId) !== String(p.vendorId)) {
        const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: false }).lean();
        if (!vendor) return res.status(400).json({ message: 'Vendor not found' });
        p.vendorId = vendor._id;
        p.vendorName = vendor.name;
      }

      if (typeof purchaseDate !== 'undefined') p.purchaseDate = purchaseDate ? new Date(purchaseDate) : p.purchaseDate;
      if (typeof dueDate !== 'undefined') p.dueDate = dueDate ? new Date(dueDate) : null;
      if (typeof items !== 'undefined') {
        const cleanItems = sanitizeItems(items);
        if (cleanItems.length === 0) {
          return res.status(400).json({ message: 'At least one line item is required' });
        }
        p.items = cleanItems;
      }
      if (typeof taxPercent !== 'undefined') p.taxPercent = Math.max(0, Math.min(100, Number(taxPercent) || 0));
      if (typeof discount !== 'undefined') p.discount = Math.max(0, Number(discount) || 0);
      if (typeof notes !== 'undefined') p.notes = String(notes).trim();

      await p.save();
      return res.status(200).json({ message: 'Purchase updated', data: p });
    } catch (error) {
      console.error('purchase.update error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // DELETE /admin/procurement/purchases/:id — soft delete
  softDelete: async (req, res) => {
    try {
      const p = await Purchase.findOne({ _id: req.params.id, isDeleted: false });
      if (!p) return res.status(404).json({ message: 'Purchase not found' });
      p.isDeleted = true;
      p.deletedAt = new Date();
      p.deletedBy = req.user?._id || null;
      await p.save();
      return res.status(200).json({ message: 'Purchase deleted' });
    } catch (error) {
      console.error('purchase.softDelete error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // POST /admin/procurement/purchases/:id/payments
  addPayment: async (req, res) => {
    try {
      const { amount, paymentMethod, paymentDate, reference, notes } = req.body || {};
      const amt = Number(amount);
      if (!isFinite(amt) || amt <= 0) {
        return res.status(400).json({ message: 'Payment amount must be greater than zero' });
      }

      const p = await Purchase.findOne({ _id: req.params.id, isDeleted: false });
      if (!p) return res.status(404).json({ message: 'Purchase not found' });

      if (amt > p.pendingAmount + 0.001) {
        return res.status(400).json({
          message: `Payment exceeds pending amount (${p.pendingAmount.toFixed(2)})`,
        });
      }

      p.payments.push({
        amount: amt,
        paymentMethod: paymentMethod || 'cash',
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        reference: String(reference || '').trim(),
        notes: String(notes || '').trim(),
        createdBy: req.user?._id || null,
      });
      await p.save();
      return res.status(201).json({ message: 'Payment added', data: p });
    } catch (error) {
      console.error('purchase.addPayment error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/transactions — every payment across all purchases,
  // flattened into one list. Powers the Payments tab on /admin/procurement.
  // Summary reflects the full filtered set; only the rows slice is paginated.
  listTransactions: async (req, res) => {
    try {
      const { search, startDate, endDate, paymentMethod } = req.query || {};
      const q = { isDeleted: false, 'payments.0': { $exists: true } };
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        q.$or = [{ invoiceNumber: rx }, { vendorName: rx }];
      }

      const purchases = await Purchase.find(q)
        .select('invoiceNumber vendorName vendorId total payments')
        .sort({ 'payments.paymentDate': -1 })
        .lean();

      const s = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
      const e = endDate ? new Date(`${endDate}T23:59:59`).getTime() : null;
      const methodFilter = paymentMethod && paymentMethod !== 'all' ? String(paymentMethod) : null;

      const rows = [];
      for (const p of purchases) {
        for (const pay of p.payments || []) {
          if (!pay._id) continue;
          if (methodFilter && pay.paymentMethod !== methodFilter) continue;
          const when = pay.paymentDate ? new Date(pay.paymentDate).getTime() : null;
          if (s !== null && (when === null || when < s)) continue;
          if (e !== null && (when === null || when > e)) continue;
          rows.push({
            paymentId: pay._id,
            purchaseId: p._id,
            invoiceNumber: p.invoiceNumber,
            vendorName: p.vendorName,
            vendorId: p.vendorId,
            invoiceTotal: p.total,
            amount: pay.amount,
            paymentMethod: pay.paymentMethod,
            paymentDate: pay.paymentDate,
            reference: pay.reference || '',
            notes: pay.notes || '',
          });
        }
      }

      rows.sort(
        (a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime(),
      );

      const summary = rows.reduce(
        (acc, t) => {
          acc.count += 1;
          acc.total += Number(t.amount) || 0;
          const m = String(t.paymentMethod || '').toLowerCase();
          if (m === 'cash') acc.cash += Number(t.amount) || 0;
          else if (m === 'bank' || m === 'card' || m === 'cheque') acc.bank += Number(t.amount) || 0;
          else acc.other += Number(t.amount) || 0;
          return acc;
        },
        { count: 0, total: 0, cash: 0, bank: 0, other: 0 },
      );

      // Server-side pagination with sensible defaults + upper bound.
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limitParam = parseInt(String(req.query.limit || '25'), 10);
      const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 25));
      const skip = (page - 1) * limit;
      const total = rows.length;
      const paged = rows.slice(skip, skip + limit);

      return res.status(200).json({
        data: paged,
        summary,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (error) {
      console.error('purchase.listTransactions error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // DELETE /admin/procurement/purchases/:id/payments/:paymentId
  removePayment: async (req, res) => {
    try {
      const p = await Purchase.findOne({ _id: req.params.id, isDeleted: false });
      if (!p) return res.status(404).json({ message: 'Purchase not found' });
      const payment = p.payments.id(req.params.paymentId);
      if (!payment) return res.status(404).json({ message: 'Payment not found' });
      payment.deleteOne();
      await p.save();
      return res.status(200).json({ message: 'Payment removed', data: p });
    } catch (error) {
      console.error('purchase.removePayment error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/products/search?q=&limit=
  // Lightweight typeahead for the purchase line-item product picker.
  // Uses case-insensitive prefix/substring regex so partial matches like
  // "mot" → "Motor Oil" resolve (a $text index only matches whole words).
  searchProducts: async (req, res) => {
    try {
      const q = String(req.query.q || req.query.search || '').trim();
      const limit = clampInt(req.query.limit, 1, 25, 8);
      if (q.length < 1) {
        return res.status(200).json({ message: 'Products', data: [] });
      }

      const rx = new RegExp(escapeRegex(q), 'i');
      const filter = {
        $or: [{ name: rx }, { sku: rx }, { slug: rx }, { category: rx }],
      };

      const projection = {
        name: 1,
        slug: 1,
        sku: 1,
        category: 1,
        price: 1,
        discountedPrice: 1,
        costPrice: 1,
        stock: 1,
        thumbnailUrl: 1,
        productType: 1,
      };

      // Rank exact/prefix name matches first so typing "mot" surfaces
      // "Motor Oil" before a generic match elsewhere.
      const items = await Product.find(filter, projection)
        .collation({ locale: 'en', strength: 2 })
        .sort({ name: 1 })
        .limit(limit)
        .lean();

      return res.status(200).json({ message: 'Products', data: items });
    } catch (error) {
      console.error('purchase.searchProducts error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/summary — dashboard cards
  summary: async (req, res) => {
    try {
      const [counts, statusBreakdown, recentOverdue] = await Promise.all([
        Purchase.aggregate([
          { $match: { isDeleted: false } },
          {
            $group: {
              _id: null,
              purchaseCount: { $sum: 1 },
              totalAmount: { $sum: '$total' },
              totalPaid: { $sum: '$paidAmount' },
              totalPending: { $sum: '$pendingAmount' },
            },
          },
        ]),
        Purchase.aggregate([
          { $match: { isDeleted: false } },
          { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: '$pendingAmount' } } },
        ]),
        Vendor.countDocuments({ isDeleted: false }),
      ]);

      const base = counts[0] || {};
      const byStatus = { pending: 0, partial: 0, paid: 0, overdue: 0 };
      const pendingByStatus = { pending: 0, partial: 0, paid: 0, overdue: 0 };
      statusBreakdown.forEach((s) => {
        byStatus[s._id] = s.count;
        pendingByStatus[s._id] = s.amount;
      });

      return res.status(200).json({
        message: 'Summary',
        data: {
          vendorCount: recentOverdue,
          purchaseCount: base.purchaseCount || 0,
          totalAmount: base.totalAmount || 0,
          totalPaid: base.totalPaid || 0,
          totalPending: base.totalPending || 0,
          byStatus,
          pendingByStatus,
        },
      });
    } catch (error) {
      console.error('purchase.summary error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },
};

module.exports = purchaseController;
