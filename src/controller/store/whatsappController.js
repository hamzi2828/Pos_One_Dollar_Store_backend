// src/controller/store/whatsappController.js
// WhatsApp group slips (/api/whatsapp): settings (token masked), test message,
// outbox log, retries, resend a bill's slip.
// OWNER: Cash & Notifications module.
const mongoose = require('mongoose');
const MessageOutbox = require('../../models/messageOutbox');
const POSOrder = require('../../models/posOrder');
const whatsapp = require('../../services/whatsapp');
const { branchFilter } = require('../../middleware/access');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const whatsappController = {
  // GET /api/whatsapp/settings
  async getSettings(req, res) {
    const s = await whatsapp.settings.getSettings();
    res.json({
      success: true,
      data: whatsapp.settings.publicSettings(s),
      meta: { providers: whatsapp.settings.PROVIDERS, missing: whatsapp.settings.missingFields(s) },
    });
  },

  // PUT /api/whatsapp/settings — token: send a new one to replace, leave empty/masked to keep.
  async saveSettings(req, res) {
    const data = await whatsapp.settings.saveSettings(req.body || {}, req.access.userId);
    res.json({ success: true, data, message: 'WhatsApp settings saved' });
  },

  // POST /api/whatsapp/test { to?, message? } — sends one real message now.
  async sendTest(req, res) {
    const body = req.body || {};
    const r = await whatsapp.sendTest({ to: body.to, message: body.message, userId: req.access.userId });
    res.status(r.ok ? 200 : 400).json({
      success: r.ok,
      data: r.outbox,
      message: r.ok ? 'Test message sent' : `Could not send: ${r.error}`,
    });
  },

  // GET /api/whatsapp/outbox?status=&search=&page=&limit=
  async outbox(req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = { ...branchFilter(req) };
    if (['queued', 'sent', 'failed'].includes(req.query.status)) filter.status = req.query.status;
    const search = String(req.query.search || '').trim();
    if (search) filter.refNo = new RegExp(escapeRegex(search), 'i');
    const [total, rows, counts] = await Promise.all([
      MessageOutbox.countDocuments(filter),
      MessageOutbox.find(filter).select('-lockedAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      MessageOutbox.aggregate([{ $match: { ...branchFilter(req) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    res.json({
      success: true,
      data: rows,
      meta: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
        maxAttempts: whatsapp.MAX_ATTEMPTS,
      },
    });
  },

  // POST /api/whatsapp/outbox/:id/retry
  async retryOne(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Message not found');
    const row = await MessageOutbox.findOne({ _id: req.params.id, ...branchFilter(req) }).select('_id').lean();
    if (!row) throw httpError(404, 'Message not found');
    const r = await whatsapp.retryOne(row._id);
    res.status(r.ok ? 200 : 400).json({ success: r.ok, data: r.outbox, message: r.ok ? 'Sent' : `Still failing: ${r.error}` });
  },

  // POST /api/whatsapp/outbox/retry-failed
  async retryFailed(req, res) {
    const r = await whatsapp.retryFailed({ limit: 20, budgetMs: 20000 });
    res.json({ success: true, data: r, message: r.skipped ? 'WhatsApp is switched off' : `Sent ${r.sent} of ${r.tried}` });
  },

  // POST /api/whatsapp/orders/:id/resend — send a bill's slip again.
  async resendOrder(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Bill not found');
    const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true }, ...branchFilter(req) })
      .select('_id branch')
      .lean();
    if (!order) throw httpError(404, 'Bill not found');
    const r = await whatsapp.enqueueOrderReceipt(order, { event: 'resend' });
    if (!r.queued) {
      const why = { disabled: 'WhatsApp slips are switched off.', not_configured: 'WhatsApp is not fully set up.', no_group: 'No WhatsApp group is set.' };
      throw httpError(400, why[r.reason] || 'Could not queue the slip.');
    }
    // Not sent now = stays in the outbox as failed and is retried later.
    res.json({
      success: true,
      data: r,
      message: r.sent ? 'Slip sent to the WhatsApp group' : `Not sent yet (${r.error}). It will be retried.`,
    });
  },
};

module.exports = whatsappController;
