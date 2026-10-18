const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  action: {
    type: String,
    required: true,
    index: true,
  },
  method: {
    type: String,
    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    required: true,
  },
  path: {
    type: String,
    required: true,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  ipAddress: {
    type: String,
    default: null,
  },
  userAgent: {
    type: String,
    default: null,
  },
  // Parsed from userAgent for easier filtering / analytics.
  browser: { type: String, default: null },
  os:      { type: String, default: null },
  device:  { type: String, default: null }, // 'mobile' | 'tablet' | 'desktop' | 'bot'

  // URL where the request was initiated from (when sent by the browser).
  referer: { type: String, default: null },

  // Non-sensitive query string (credentials etc. are redacted).
  queryParams: { type: mongoose.Schema.Types.Mixed, default: null },

  // Primary resource id targeted by the request (from req.params.id / :productId / etc.).
  resourceId: { type: String, default: null, index: true },

  // Error message extracted from the response body when statusCode >= 400.
  errorMessage: { type: String, default: null },

  // Cache status read from the X-Cache response header ('HIT' | 'MISS' | null).
  cacheStatus: { type: String, default: null },

  // Byte-length of the JSON/body sent to the client (approximate).
  responseSize: { type: Number, default: null },

  // 'info' | 'warn' | 'critical' — set per action so high-impact events stand out.
  severity: { type: String, default: 'info', index: true },

  statusCode: {
    type: Number,
    default: null,
  },
  durationMs: {
    type: Number,
    default: null,
  },
}, { timestamps: true });

// Per-user timeline (admin user activity modal)
auditLogSchema.index({ userId: 1, createdAt: -1 });
// Global feed sorted by time (activity log page)
auditLogSchema.index({ createdAt: -1 });
// Filter by action + time (action filter on activity log page)
auditLogSchema.index({ action: 1, createdAt: -1 });
// Filter by method + time
auditLogSchema.index({ method: 1, createdAt: -1 });
// Top-users & range-bounded user aggregations (analytics)
auditLogSchema.index({ createdAt: -1, userId: 1 });
// Range-bounded path/endpoint aggregations (slowest / most-called)
auditLogSchema.index({ createdAt: -1, path: 1, method: 1 });
// Range-bounded status breakdown
auditLogSchema.index({ createdAt: -1, statusCode: 1 });
// Product-view aggregations
auditLogSchema.index({ action: 1, 'details.slug': 1, createdAt: -1 }, { sparse: true });
// Severity feed (surface critical events fast)
auditLogSchema.index({ severity: 1, createdAt: -1 });
// Failures feed + per-status analytics
auditLogSchema.index({ statusCode: 1, createdAt: -1 });
// Resource-specific timelines (who touched product X?)
auditLogSchema.index({ resourceId: 1, createdAt: -1 });
// Text search on action + path
auditLogSchema.index({ action: 'text', path: 'text' });
// Auto-delete logs older than 90 days
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

if (mongoose.models.AuditLog) delete mongoose.models.AuditLog;

module.exports = mongoose.model('AuditLog', auditLogSchema);
