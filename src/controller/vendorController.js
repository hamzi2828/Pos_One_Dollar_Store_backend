const Vendor = require('../models/vendor');
const Purchase = require('../models/purchase');

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const vendorController = {
  // GET /admin/procurement/vendors — paginated list with filters.
  list: async (req, res) => {
    try {
      const page = clampInt(req.query.page, 1, 10_000, 1);
      const limit = clampInt(req.query.limit, 1, 100, 20);
      const { search, category, status, sortBy = 'createdAt', sortDir = 'desc' } = req.query;

      const filter = { isDeleted: false };
      if (status === 'active') filter.isActive = true;
      else if (status === 'inactive') filter.isActive = false;
      if (category) filter.category = category;

      if (search && String(search).trim()) {
        filter.$text = { $search: String(search).trim() };
      }

      const sort = { [sortBy]: sortDir === 'asc' ? 1 : -1 };

      const [items, total] = await Promise.all([
        Vendor.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        Vendor.countDocuments(filter),
      ]);

      // Attach lightweight payable totals per vendor via a single aggregation.
      const vendorIds = items.map((v) => v._id);
      const totalsMap = new Map();
      if (vendorIds.length > 0) {
        const agg = await Purchase.aggregate([
          { $match: { vendorId: { $in: vendorIds }, isDeleted: false } },
          {
            $group: {
              _id: '$vendorId',
              totalPurchases: { $sum: '$total' },
              totalPaid: { $sum: '$paidAmount' },
              totalPending: { $sum: '$pendingAmount' },
              purchaseCount: { $sum: 1 },
              overdueCount: {
                $sum: { $cond: [{ $eq: ['$paymentStatus', 'overdue'] }, 1, 0] },
              },
            },
          },
        ]);
        agg.forEach((row) => totalsMap.set(String(row._id), row));
      }

      const data = items.map((v) => {
        const t = totalsMap.get(String(v._id)) || {};
        return {
          ...v,
          totalPurchases: t.totalPurchases || 0,
          totalPaid: t.totalPaid || 0,
          totalPending: t.totalPending || 0,
          purchaseCount: t.purchaseCount || 0,
          overdueCount: t.overdueCount || 0,
        };
      });

      return res.status(200).json({
        message: 'Vendors',
        data,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (error) {
      console.error('vendor.list error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/vendors/:id
  getById: async (req, res) => {
    try {
      const v = await Vendor.findOne({ _id: req.params.id, isDeleted: false }).lean();
      if (!v) return res.status(404).json({ message: 'Vendor not found' });

      const agg = await Purchase.aggregate([
        { $match: { vendorId: v._id, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalPurchases: { $sum: '$total' },
            totalPaid: { $sum: '$paidAmount' },
            totalPending: { $sum: '$pendingAmount' },
            purchaseCount: { $sum: 1 },
            overdueCount: {
              $sum: { $cond: [{ $eq: ['$paymentStatus', 'overdue'] }, 1, 0] },
            },
          },
        },
      ]);
      const t = agg[0] || {};

      return res.status(200).json({
        message: 'Vendor',
        data: {
          ...v,
          totalPurchases: t.totalPurchases || 0,
          totalPaid: t.totalPaid || 0,
          totalPending: t.totalPending || 0,
          purchaseCount: t.purchaseCount || 0,
          overdueCount: t.overdueCount || 0,
        },
      });
    } catch (error) {
      console.error('vendor.getById error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // POST /admin/procurement/vendors
  create: async (req, res) => {
    try {
      const { name, contactPerson, email, phone, category, address, notes, isActive } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ message: 'Vendor name is required' });
      }

      if (email) {
        const dup = await Vendor.findOne({ email: String(email).trim().toLowerCase(), isDeleted: false }).lean();
        if (dup) return res.status(400).json({ message: 'A vendor with this email already exists' });
      }

      const doc = await Vendor.create({
        name: String(name).trim(),
        contactPerson: String(contactPerson || '').trim(),
        email: String(email || '').trim().toLowerCase(),
        phone: String(phone || '').trim(),
        category: String(category || '').trim(),
        address: address || {},
        notes: String(notes || '').trim(),
        isActive: typeof isActive === 'boolean' ? isActive : true,
      });

      return res.status(201).json({ message: 'Vendor created', data: doc });
    } catch (error) {
      console.error('vendor.create error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // PUT /admin/procurement/vendors/:id
  update: async (req, res) => {
    try {
      const v = await Vendor.findOne({ _id: req.params.id, isDeleted: false });
      if (!v) return res.status(404).json({ message: 'Vendor not found' });

      const fields = ['name', 'contactPerson', 'phone', 'category', 'notes'];
      fields.forEach((f) => {
        if (typeof req.body[f] !== 'undefined') v[f] = String(req.body[f]).trim();
      });
      if (typeof req.body.email !== 'undefined') {
        const newEmail = String(req.body.email).trim().toLowerCase();
        if (newEmail && newEmail !== v.email) {
          const dup = await Vendor.findOne({ email: newEmail, isDeleted: false, _id: { $ne: v._id } }).lean();
          if (dup) return res.status(400).json({ message: 'A vendor with this email already exists' });
        }
        v.email = newEmail;
      }
      if (typeof req.body.isActive === 'boolean') v.isActive = req.body.isActive;
      if (req.body.address && typeof req.body.address === 'object') {
        v.address = { ...(v.address?.toObject?.() || v.address || {}), ...req.body.address };
      }

      await v.save();

      // If the vendor's name changed, refresh denormalized vendorName on purchases.
      if (req.body.name && req.body.name !== v.name) {
        await Purchase.updateMany({ vendorId: v._id, isDeleted: false }, { $set: { vendorName: v.name } });
      }

      return res.status(200).json({ message: 'Vendor updated', data: v });
    } catch (error) {
      console.error('vendor.update error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // PUT /admin/procurement/vendors/:id/status
  toggleStatus: async (req, res) => {
    try {
      const v = await Vendor.findOne({ _id: req.params.id, isDeleted: false });
      if (!v) return res.status(404).json({ message: 'Vendor not found' });
      v.isActive = !v.isActive;
      await v.save();
      return res.status(200).json({ message: 'Status updated', data: v });
    } catch (error) {
      console.error('vendor.toggleStatus error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // DELETE /admin/procurement/vendors/:id — soft delete
  softDelete: async (req, res) => {
    try {
      const v = await Vendor.findOne({ _id: req.params.id, isDeleted: false });
      if (!v) return res.status(404).json({ message: 'Vendor not found' });

      // Block deletion if the vendor still has pending purchases.
      const openPurchases = await Purchase.countDocuments({
        vendorId: v._id,
        isDeleted: false,
        paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
      });
      if (openPurchases > 0) {
        return res.status(400).json({
          message: `Cannot delete vendor — ${openPurchases} open purchase${openPurchases === 1 ? '' : 's'} with pending balance.`,
        });
      }

      v.isDeleted = true;
      v.deletedAt = new Date();
      v.deletedBy = req.user?._id || null;
      await v.save();
      return res.status(200).json({ message: 'Vendor deleted' });
    } catch (error) {
      console.error('vendor.softDelete error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/procurement/vendors/:id/ledger
  ledger: async (req, res) => {
    try {
      const vendor = await Vendor.findOne({ _id: req.params.id, isDeleted: false }).lean();
      if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

      const purchases = await Purchase.find({ vendorId: vendor._id, isDeleted: false })
        .sort({ purchaseDate: 1, createdAt: 1 })
        .lean();

      // Flatten into entries (purchase=debit, payment=credit), sort by date, compute running balance.
      const entries = [];
      purchases.forEach((p) => {
        entries.push({
          type: 'purchase',
          date: p.purchaseDate,
          invoiceNumber: p.invoiceNumber,
          description: `Purchase ${p.invoiceNumber}`,
          debit: p.total || 0,
          credit: 0,
          reference: '',
          purchaseId: p._id,
        });
        (p.payments || []).forEach((pay) => {
          entries.push({
            type: 'payment',
            date: pay.paymentDate,
            invoiceNumber: p.invoiceNumber,
            description: `Payment for ${p.invoiceNumber}`,
            debit: 0,
            credit: pay.amount || 0,
            reference: pay.reference || '',
            method: pay.paymentMethod,
            purchaseId: p._id,
            paymentId: pay._id,
          });
        });
      });

      entries.sort((a, b) => new Date(a.date) - new Date(b.date));
      let running = 0;
      entries.forEach((e) => {
        running += (e.debit || 0) - (e.credit || 0);
        e.balance = running;
      });

      return res.status(200).json({
        message: 'Ledger',
        data: { vendor, entries, balance: running },
      });
    } catch (error) {
      console.error('vendor.ledger error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },
};

module.exports = vendorController;
