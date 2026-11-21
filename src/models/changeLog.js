// Data change log: one row per document created, changed or deleted, with the
// values before and after and who did it. Written by helper/changeTracker.js
// (a Mongoose plugin on every model). Kept forever (no TTL) so changes can be
// traced later; the request log (auditLog) is the short-lived one.
const mongoose = require('mongoose');

const changeLogSchema = new mongoose.Schema({
  // What changed
  model:      { type: String, required: true },          // Mongoose model name, e.g. 'Product'
  collectionName: { type: String, default: null },
  docId:      { type: String, default: null },            // _id of the changed document
  operation:  { type: String, enum: ['create', 'update', 'delete'], required: true },
  op:         { type: String, default: null },            // Mongoose call: save, updateOne, findOneAndUpdate, bulkWrite...
  changedFields: { type: [String], default: undefined },  // top-level / dotted paths that changed
  changes:    { type: mongoose.Schema.Types.Mixed, default: null }, // [{ path, from, to }] for updates
  before:     { type: mongoose.Schema.Types.Mixed, default: null }, // full document for deletes
  after:      { type: mongoose.Schema.Types.Mixed, default: null }, // full document for creates
  filter:     { type: mongoose.Schema.Types.Mixed, default: null }, // query filter (bulk / unmatched updates)
  update:     { type: mongoose.Schema.Types.Mixed, default: null }, // update sent, when no per-document diff exists
  truncated:  { type: Boolean, default: undefined },

  // Who / where
  source:     { type: String, default: 'api' },           // 'api' | 'system'
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  employeeId: { type: String, default: null },            // employee portal logins
  actorKind:  { type: String, default: null },            // 'staff' | 'portal' | 'guest'
  actorName:  { type: String, default: null },
  actorEmail: { type: String, default: null },
  ipAddress:  { type: String, default: null },
  userAgent:  { type: String, default: null },
  method:     { type: String, default: null },
  path:       { type: String, default: null },
  requestId:  { type: String, default: null },            // same id as the request's audit log row
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

changeLogSchema.index({ createdAt: -1 });
changeLogSchema.index({ model: 1, docId: 1, createdAt: -1 });   // history of one record
changeLogSchema.index({ model: 1, createdAt: -1 });
changeLogSchema.index({ userId: 1, createdAt: -1 });
changeLogSchema.index({ operation: 1, createdAt: -1 });
changeLogSchema.index({ requestId: 1 });
changeLogSchema.index({ docId: 1, createdAt: -1 });

module.exports = mongoose.models.ChangeLog || mongoose.model('ChangeLog', changeLogSchema, 'change_logs');
