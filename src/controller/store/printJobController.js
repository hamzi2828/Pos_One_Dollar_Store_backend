// src/controller/store/printJobController.js
// Print receipts on another counter (/api/print-jobs). A counter with
// printOnCounter posts its receipt here; the POS on the printer counter
// claims it, prints it and marks it done. The counter = the user's open till.
const mongoose = require('mongoose');
const PrintJob = require('../../models/printJob');
const SaleCounter = require('../../models/saleCounter');
const CashSession = require('../../models/cashSession');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));

const MAX_PAYLOAD_BYTES = 200 * 1024;
const CLAIM_WINDOW_MS = 15 * 60 * 1000; // older pending jobs are not printed

/** Counter of the user's open till (or null). */
async function myCounter(userId) {
  const session = await CashSession.findOne({ cashier: userId, status: 'open' }).select('counter').lean();
  if (!session || !session.counter) return null;
  return SaleCounter.findOne({ _id: session.counter }).select('name branch printOnCounter').lean();
}

const printJobController = {
  // POST /api/print-jobs { order, storeName, symbol }
  async create(req, res) {
    const { order, storeName, symbol } = req.body || {};
    if (!order || typeof order !== 'object') throw httpError(400, 'Order is required.');
    const payload = { order, storeName: storeName == null ? '' : String(storeName), symbol: symbol == null ? '' : String(symbol) };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
      throw httpError(413, 'Receipt is too large to send.', 'PAYLOAD_TOO_LARGE');
    }

    const userId = req.access.userId;
    const counter = await myCounter(userId);
    if (!counter) throw httpError(409, 'Open your till first to send the receipt to the printer counter.', 'NO_OPEN_TILL');
    const target = counter.printOnCounter ? await SaleCounter.findOne({ _id: counter.printOnCounter }).select('name').lean() : null;
    if (!target) throw httpError(409, 'This counter does not print on another counter.', 'NO_REMOTE_PRINTER');

    const job = await PrintJob.create({
      kind: 'receipt',
      payload,
      orderNumber: String(order.orderNumber || order.orderNo || '').slice(0, 60),
      branch: counter.branch,
      fromCounter: counter._id,
      fromCounterName: counter.name,
      toCounter: target._id,
      toCounterName: target.name,
      createdBy: userId,
    });
    res.status(201).json({ success: true, data: { id: String(job._id), toCounterName: target.name } });
  },

  // POST /api/print-jobs/claim — oldest pending job for my till's counter.
  async claim(req, res) {
    const userId = req.access.userId;
    const counter = await myCounter(userId);
    if (!counter) return res.json({ success: true, data: { job: null } });
    const now = new Date();
    const cutoff = new Date(now.getTime() - CLAIM_WINDOW_MS);
    // Too old: a PC switched on later must not print a pile of old receipts.
    await PrintJob.updateMany(
      { toCounter: counter._id, status: 'pending', createdAt: { $lt: cutoff } },
      { $set: { status: 'failed', error: 'expired' } }
    );
    const job = await PrintJob.findOneAndUpdate(
      { toCounter: counter._id, status: 'pending', createdAt: { $gte: cutoff } },
      { $set: { status: 'claimed', claimedAt: now, claimedBy: userId } },
      { sort: { createdAt: 1 }, new: true }
    ).lean();
    res.json({
      success: true,
      data: {
        job: job
          ? { id: String(job._id), payload: job.payload, orderNumber: job.orderNumber, fromCounterName: job.fromCounterName, createdAt: job.createdAt }
          : null,
      },
    });
  },

  // POST /api/print-jobs/:id/done { ok, error? } — only the user who claimed it.
  async done(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Print job not found');
    const job = await PrintJob.findOne({ _id: req.params.id });
    if (!job) throw httpError(404, 'Print job not found');
    if (!job.claimedBy || String(job.claimedBy) !== String(req.access.userId)) {
      throw httpError(403, 'Only the counter that took this receipt can mark it.');
    }
    const ok = !!req.body && (req.body.ok === true || req.body.ok === 'true');
    if (ok) {
      job.status = 'printed';
      job.printedAt = new Date();
      job.error = '';
    } else {
      job.status = 'failed';
      job.error = String((req.body && req.body.error) || 'failed').slice(0, 500);
    }
    await job.save();
    res.json({ success: true, data: { ok: true } });
  },
};

module.exports = printJobController;
