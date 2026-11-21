// Data change log API (Activity Log -> "Data Changes").
// GET /admin/change-logs           list with filters
// GET /admin/change-logs/models    model names with counts (filter dropdown)
// GET /admin/change-logs/:id       one row (full before/after)
const mongoose = require('mongoose');
const ChangeLog = require('../models/changeLog');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildFilter(q) {
  const f = {};
  if (q.model) f.model = String(q.model);
  if (q.docId) f.docId = String(q.docId).trim();
  if (q.operation && ['create', 'update', 'delete'].includes(q.operation)) f.operation = q.operation;
  if (q.userId && mongoose.Types.ObjectId.isValid(q.userId)) f.userId = new mongoose.Types.ObjectId(String(q.userId));
  if (q.requestId) f.requestId = String(q.requestId);
  if (q.source) f.source = String(q.source);
  if (q.field) f.changedFields = String(q.field);
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) { const d = new Date(q.from); if (!isNaN(d)) f.createdAt.$gte = d; }
    if (q.to) { const d = new Date(q.to); if (!isNaN(d)) { if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) d.setHours(23, 59, 59, 999); f.createdAt.$lte = d; } }
    if (!Object.keys(f.createdAt).length) delete f.createdAt;
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(String(q.search).trim().slice(0, 100)), 'i');
    f.$or = [{ docId: rx }, { actorName: rx }, { actorEmail: rx }, { path: rx }, { model: rx }];
  }
  return f;
}

const changeLogController = {
  list: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const filter = buildFilter(req.query);
      const [rows, total] = await Promise.all([
        ChangeLog.find(filter)
          // List view: diff only; full snapshots come from GET /:id.
          .select('-before -after -userAgent')
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        ChangeLog.countDocuments(filter).limit(100000),
      ]);
      return res.status(200).json({
        message: 'Change logs',
        data: rows,
        pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (error) {
      console.error('changeLog list error:', error);
      return res.status(400).json({ message: 'Error fetching change logs', error: error.message });
    }
  },

  models: async (req, res) => {
    try {
      const rows = await ChangeLog.aggregate([
        { $group: { _id: '$model', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
        { $sort: { _id: 1 } },
      ]);
      return res.status(200).json({ message: 'Models', data: rows.map((r) => ({ model: r._id, count: r.count, lastAt: r.lastAt })) });
    } catch (error) {
      console.error('changeLog models error:', error);
      return res.status(400).json({ message: 'Error fetching models', error: error.message });
    }
  },

  getOne: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
      const row = await ChangeLog.findById(req.params.id).lean();
      if (!row) return res.status(404).json({ message: 'Not found' });
      return res.status(200).json({ message: 'Change log', data: row });
    } catch (error) {
      console.error('changeLog getOne error:', error);
      return res.status(400).json({ message: 'Error fetching change log', error: error.message });
    }
  },
};

module.exports = changeLogController;
