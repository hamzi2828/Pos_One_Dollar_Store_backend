// src/models/messageOutbox.js
// Every outgoing WhatsApp message (receipt slips, test messages) with its
// delivery result, so failed sends can be retried and audited.
// Rows expire after 120 days. OWNER: Cash & Notifications module.
const mongoose = require('mongoose');

const RETENTION_DAYS = 120;

const messageOutboxSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['whatsapp'], default: 'whatsapp' },
    provider: { type: String, default: '' }, // ultramsg | greenapi | webhook
    to: { type: String, required: true }, // group id, e.g. 1203630xxxx@g.us
    body: { type: String, required: true },
    status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    refType: { type: String, default: '' }, // 'POSOrder' | 'test'
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNo: { type: String, default: '' }, // bill number
    event: { type: String, default: '' }, // sale | payment | resend | test
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: '' },
    // Claimed by a sender (stops two retries sending the same row at once).
    lockedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

messageOutboxSchema.index({ status: 1, createdAt: -1 });
messageOutboxSchema.index({ refType: 1, refId: 1 });
messageOutboxSchema.index({ branch: 1, createdAt: -1 });
messageOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 3600 });

module.exports = mongoose.models.MessageOutbox || mongoose.model('MessageOutbox', messageOutboxSchema);
