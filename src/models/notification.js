// src/models/notification.js
// In-app notifications (header bell + /admin/notifications).
// Who sees a row:
//   - `user` set        -> only that user (and the super admin)
//   - `audience` key    -> staff holding that permission key (any action)
//   - `audience` null   -> staff with the `notifications` permission
//   - `branch` set      -> only staff of that branch (super admin sees all)
// Rows expire after 90 days (TTL index). OWNER: Cash & Notifications module.
const mongoose = require('mongoose');

const RETENTION_DAYS = 90;

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true }, // e.g. 'till_closed', 'counter_not_opened'
    title: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, default: '', maxlength: 2000 },
    level: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    link: { type: String, default: '' },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    audience: { type: String, default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Same event never notified twice (e.g. "cutoff:open:<counter>:2026-10-18").
    // No default on purpose: a sparse index skips missing fields, not nulls.
    dedupeKey: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 3600 });
notificationSchema.index({ audience: 1, createdAt: -1 });
notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
