const AuditLog = require('../models/auditLog');
const mongoose = require('mongoose');

const RANGE_MS = {
  '1h':  60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const auditLogController = {
  // GET /admin/audit-logs — all logs with filters
  getAllAuditLogs: async (req, res) => {
    try {
      const pageNum = Math.max(1, parseInt(req.query.page) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const { action, userId, method, search } = req.query;
      const includeBreakdown = req.query.includeBreakdown !== 'false';

      const filter = {};
      if (action) filter.action = action;
      if (userId) filter.userId = userId;
      if (method) filter.method = method;
      if (search) {
        if (search.length >= 3) {
          filter.$text = { $search: search };
        } else {
          filter.$or = [
            { action: { $regex: search, $options: 'i' } },
            { path: { $regex: search, $options: 'i' } },
          ];
        }
      }

      const skip = (pageNum - 1) * limitNum;

      // Cap countDocuments with a hint + bound so huge tables don't re-scan every page
      const countPromise = AuditLog.countDocuments(filter).limit(100000);

      // Action breakdown is expensive (group over full collection). Only run on
      // the first page or when explicitly requested, and bound to the last 30d.
      const breakdownPromise = includeBreakdown && pageNum === 1
        ? AuditLog.aggregate([
            { $match: { createdAt: { $gte: new Date(Date.now() - RANGE_MS['30d']) } } },
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 30 },
          ])
        : Promise.resolve(null);

      const [logs, total, actionBreakdown] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'firstName lastName email')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        countPromise,
        breakdownPromise,
      ]);

      return res.status(200).json({
        message: 'All audit logs',
        data: logs,
        actionBreakdown,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('getAllAuditLogs error:', error);
      return res.status(400).json({ message: 'Error', error: error.message });
    }
  },

  // GET /admin/audit-logs/user/:userId
  getUserAuditLogs: async (req, res) => {
    try {
      const { userId } = req.params;
      const pageNum = Math.max(1, parseInt(req.query.page) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const { action } = req.query;

      const filter = { userId };
      if (action) filter.action = action;

      const skip = (pageNum - 1) * limitNum;

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'firstName lastName email')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        AuditLog.countDocuments(filter),
      ]);

      return res.status(200).json({
        message: 'Audit logs',
        data: logs,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.max(1, Math.ceil(total / limitNum)),
        },
      });
    } catch (error) {
      console.error('getUserAuditLogs error:', error);
      return res.status(400).json({ message: 'Error fetching audit logs', error: error.message });
    }
  },

  // GET /admin/audit-logs/user/:userId/summary
  getUserAuditSummary: async (req, res) => {
    try {
      const { userId } = req.params;

      const [summary, totalCount, lastActivity] = await Promise.all([
        AuditLog.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(userId) } },
          { $group: { _id: '$action', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
          { $sort: { count: -1 } },
        ]),
        AuditLog.countDocuments({ userId }),
        AuditLog.findOne({ userId }).sort({ createdAt: -1 }).select('createdAt action').lean(),
      ]);

      return res.status(200).json({
        message: 'Audit summary',
        data: {
          totalActions: totalCount,
          lastActivity: lastActivity?.createdAt || null,
          lastAction: lastActivity?.action || null,
          breakdown: summary,
        },
      });
    } catch (error) {
      console.error('getUserAuditSummary error:', error);
      return res.status(400).json({ message: 'Error fetching audit summary', error: error.message });
    }
  },

  // GET /admin/audit-logs/analytics?range=24h|7d|30d
  getAuditAnalytics: async (req, res) => {
    try {
      const { range = '24h' } = req.query;

      const now = new Date();
      const windowMs = RANGE_MS[range] || RANGE_MS['24h'];
      const since = new Date(now.getTime() - windowMs);

      // Bucket size for time series
      const bucketMinutes = range === '1h' ? 5 : range === '24h' ? 60 : range === '7d' ? 6 * 60 : 24 * 60;

      const matchStage = { createdAt: { $gte: since } };

      const [
        overviewAgg,
        topUsers,
        topProducts,
        topPaths,
        actionBreakdown,
        methodBreakdown,
        statusBreakdown,
        slowestPaths,
        timeline,
      ] = await Promise.all([
        // Overview stats
        AuditLog.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
              uniqueUsers: { $addToSet: '$userId' },
              avgDuration: { $avg: '$durationMs' },
              maxDuration: { $max: '$durationMs' },
            },
          },
          {
            $project: {
              _id: 0,
              total: 1,
              failed: 1,
              uniqueUsers: {
                $size: {
                  $filter: { input: '$uniqueUsers', as: 'u', cond: { $ne: ['$$u', null] } },
                },
              },
              guestEvents: {
                $size: {
                  $filter: { input: '$uniqueUsers', as: 'u', cond: { $eq: ['$$u', null] } },
                },
              },
              avgDuration: { $round: ['$avgDuration', 1] },
              maxDuration: 1,
            },
          },
        ]),

        // Top users by activity count
        AuditLog.aggregate([
          { $match: { ...matchStage, userId: { $ne: null } } },
          {
            $group: {
              _id: '$userId',
              count: { $sum: 1 },
              lastAt: { $max: '$createdAt' },
              actions: { $addToSet: '$action' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 15 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              count: 1,
              lastAt: 1,
              actionCount: { $size: '$actions' },
              firstName: '$user.firstName',
              lastName: '$user.lastName',
              email: '$user.email',
            },
          },
        ]),

        // Top viewed products (from view_product action details)
        AuditLog.aggregate([
          { $match: { ...matchStage, action: 'view_product' } },
          {
            $group: {
              _id: '$details.slug',
              count: { $sum: 1 },
              uniqueUsers: { $addToSet: '$userId' },
            },
          },
          { $match: { _id: { $ne: null } } },
          {
            $project: {
              _id: 1,
              count: 1,
              uniqueUsers: { $size: '$uniqueUsers' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]),

        // Top paths overall — enriched with cache hit rate, severity, last error, unique users
        AuditLog.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: { method: '$method', path: '$path' },
              count: { $sum: 1 },
              avgDuration: { $avg: '$durationMs' },
              maxDuration: { $max: '$durationMs' },
              // Cache-hit durations: served from memory
              hitAvgDuration:  { $avg: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] },  '$durationMs', null] } },
              hitMaxDuration:  { $max: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] },  '$durationMs', null] } },
              // DB-hit (cache miss) durations: went to the database
              missAvgDuration: { $avg: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, '$durationMs', null] } },
              missMaxDuration: { $max: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, '$durationMs', null] } },
              failCount: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
              cacheHits:  { $sum: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] }, 1, 0] } },
              cacheMisses:{ $sum: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, 1, 0] } },
              criticalCount: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              warnCount:     { $sum: { $cond: [{ $eq: ['$severity', 'warn'] }, 1, 0] } },
              uniqueUsers: { $addToSet: '$userId' },
              lastAt: { $max: '$createdAt' },
              lastError: { $last: { $cond: [{ $gte: ['$statusCode', 400] }, '$errorMessage', null] } },
              avgSize: { $avg: '$responseSize' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 15 },
          {
            $project: {
              _id: 0,
              method: '$_id.method',
              path: '$_id.path',
              count: 1,
              avgDuration: { $round: ['$avgDuration', 1] },
              maxDuration: 1,
              hitAvgDuration:  { $round: ['$hitAvgDuration', 1] },
              hitMaxDuration:  '$hitMaxDuration',
              missAvgDuration: { $round: ['$missAvgDuration', 1] },
              missMaxDuration: '$missMaxDuration',
              failCount: 1,
              cacheHits: 1,
              cacheMisses: 1,
              criticalCount: 1,
              warnCount: 1,
              uniqueUsers: {
                $size: {
                  $filter: { input: '$uniqueUsers', as: 'u', cond: { $ne: ['$$u', null] } },
                },
              },
              lastAt: 1,
              lastError: 1,
              avgSize: { $round: ['$avgSize', 0] },
            },
          },
        ]),

        // Action breakdown
        AuditLog.aggregate([
          { $match: matchStage },
          { $group: { _id: '$action', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]),

        // Method breakdown
        AuditLog.aggregate([
          { $match: matchStage },
          { $group: { _id: '$method', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        // Status code breakdown (grouped into 2xx/3xx/4xx/5xx)
        AuditLog.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: {
                $switch: {
                  branches: [
                    { case: { $lt: ['$statusCode', 300] }, then: '2xx' },
                    { case: { $lt: ['$statusCode', 400] }, then: '3xx' },
                    { case: { $lt: ['$statusCode', 500] }, then: '4xx' },
                    { case: { $gte: ['$statusCode', 500] }, then: '5xx' },
                  ],
                  default: 'unknown',
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),

        // Slowest paths (avg ms) — with cache/fail/severity context
        AuditLog.aggregate([
          { $match: { ...matchStage, durationMs: { $ne: null, $gt: 0 } } },
          {
            $group: {
              _id: { method: '$method', path: '$path' },
              count: { $sum: 1 },
              avgDuration: { $avg: '$durationMs' },
              maxDuration: { $max: '$durationMs' },
              minDuration: { $min: '$durationMs' },
              hitAvgDuration:  { $avg: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] },  '$durationMs', null] } },
              hitMaxDuration:  { $max: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] },  '$durationMs', null] } },
              missAvgDuration: { $avg: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, '$durationMs', null] } },
              missMaxDuration: { $max: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, '$durationMs', null] } },
              failCount: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
              cacheHits:  { $sum: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] }, 1, 0] } },
              cacheMisses:{ $sum: { $cond: [{ $eq: ['$cacheStatus', 'MISS'] }, 1, 0] } },
              criticalCount: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              warnCount:     { $sum: { $cond: [{ $eq: ['$severity', 'warn'] }, 1, 0] } },
              avgSize: { $avg: '$responseSize' },
              uniqueUsers: { $addToSet: '$userId' },
              lastAt: { $max: '$createdAt' },
              lastError: { $last: { $cond: [{ $gte: ['$statusCode', 400] }, '$errorMessage', null] } },
            },
          },
          { $match: { count: { $gte: 2 } } },
          { $sort: { avgDuration: -1 } },
          { $limit: 10 },
          {
            $project: {
              _id: 0,
              method: '$_id.method',
              path: '$_id.path',
              count: 1,
              avgDuration: { $round: ['$avgDuration', 1] },
              maxDuration: 1,
              minDuration: 1,
              hitAvgDuration:  { $round: ['$hitAvgDuration', 1] },
              hitMaxDuration:  '$hitMaxDuration',
              missAvgDuration: { $round: ['$missAvgDuration', 1] },
              missMaxDuration: '$missMaxDuration',
              failCount: 1,
              cacheHits: 1,
              cacheMisses: 1,
              criticalCount: 1,
              warnCount: 1,
              avgSize: { $round: ['$avgSize', 0] },
              uniqueUsers: {
                $size: {
                  $filter: { input: '$uniqueUsers', as: 'u', cond: { $ne: ['$$u', null] } },
                },
              },
              lastAt: 1,
              lastError: 1,
            },
          },
        ]),

        // Time series (events per bucket)
        AuditLog.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: {
                $dateTrunc: {
                  date: '$createdAt',
                  unit: 'minute',
                  binSize: bucketMinutes,
                },
              },
              count: { $sum: 1 },
              failed: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);

      const overview = overviewAgg[0] || { total: 0, failed: 0, uniqueUsers: 0, guestEvents: 0, avgDuration: 0, maxDuration: 0 };

      return res.status(200).json({
        message: 'Audit analytics',
        data: {
          range,
          since,
          overview,
          topUsers,
          topProducts,
          topPaths,
          actionBreakdown,
          methodBreakdown,
          statusBreakdown,
          slowestPaths,
          timeline,
        },
      });
    } catch (error) {
      console.error('getAuditAnalytics error:', error);
      return res.status(400).json({ message: 'Error fetching analytics', error: error.message });
    }
  },

  // DELETE /admin/audit-logs — admin only, clears all logs
  clearAllAuditLogs: async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: admin only' });
      }
      const result = await AuditLog.deleteMany({});
      return res.status(200).json({
        message: 'All audit logs cleared',
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error('clearAllAuditLogs error:', error);
      return res.status(400).json({ message: 'Error clearing audit logs', error: error.message });
    }
  },

  // GET /admin/audit-logs/top-users?range=24h&page=1&limit=20
  getTopUsers: async (req, res) => {
    try {
      const { range = '24h' } = req.query;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const windowMs = RANGE_MS[range] || RANGE_MS['24h'];
      const since = new Date(Date.now() - windowMs);
      const match = { createdAt: { $gte: since }, userId: { $ne: null } };

      const [countAgg, rows] = await Promise.all([
        AuditLog.aggregate([
          { $match: match },
          { $group: { _id: '$userId' } },
          { $count: 'total' },
        ]),
        AuditLog.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$userId',
              count: { $sum: 1 },
              lastAt: { $max: '$createdAt' },
              actions: { $addToSet: '$action' },
              failed: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
            },
          },
          { $sort: { count: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              count: 1,
              lastAt: 1,
              failed: 1,
              actionCount: { $size: '$actions' },
              firstName: '$user.firstName',
              lastName: '$user.lastName',
              email: '$user.email',
            },
          },
        ]),
      ]);

      const total = countAgg[0]?.total || 0;
      return res.status(200).json({
        message: 'Top users',
        data: rows,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (error) {
      console.error('getTopUsers error:', error);
      return res.status(400).json({ message: 'Error fetching top users', error: error.message });
    }
  },
};

module.exports = auditLogController;
