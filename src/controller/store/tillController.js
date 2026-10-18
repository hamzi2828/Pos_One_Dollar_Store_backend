// src/controller/store/tillController.js
// Till sessions (/api/till-sessions): the cashier's own till (blind) and the
// admin side (verify / dispute, cash-closing report + CSV).
// Cashiers NEVER get expected cash, variance or sales numbers: only users with
// `till_verify` view do (tillService.serializeSession({ full })).
// OWNER: Cash & Notifications module.
const mongoose = require('mongoose');
const CashSession = require('../../models/cashSession');
const tillService = require('../../services/tillService');
const { branchFilter } = require('../../middleware/access');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATUSES = ['open', 'closed', 'verified', 'disputed'];

function paging(query, defLimit = 25, maxLimit = 200) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/** Filters shared by the verification list, the report and the CSV. */
async function sessionFilter(req, { defaultStatuses } = {}) {
  const q = req.query;
  const tz = await tillService.getTimeZone();
  const filter = { ...branchFilter(req) };
  const range = tillService.dayRange(q.from, q.to, tz);
  if (range) filter.openedAt = range;
  if (isId(q.counter)) filter.counter = oid(q.counter);
  if (isId(q.cashier)) filter.cashier = oid(q.cashier);
  const statuses = String(q.status || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => STATUSES.includes(s));
  if (statuses.length) filter.status = { $in: statuses };
  else if (defaultStatuses) filter.status = { $in: defaultStatuses };
  const search = String(q.search || '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ sessionNo: rx }, { cashierName: rx }, { counterName: rx }];
  }
  return filter;
}

const closedOnly = (expr) => ({ $cond: [{ $eq: ['$status', 'open'] }, 0, expr] });

async function summarize(filter) {
  const [row] = await CashSession.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        sessions: { $sum: 1 },
        open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
        toVerify: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
        verified: { $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] } },
        disputed: { $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] } },
        float: { $sum: '$openingFloat.total' },
        cashSales: { $sum: closedOnly('$expected.cashSales') },
        cashReceivedOnCredit: { $sum: closedOnly('$expected.cashReceivedOnCredit') },
        cashRefunds: { $sum: closedOnly('$expected.cashRefunds') },
        expectedCash: { $sum: closedOnly('$expected.expectedCash') },
        counted: { $sum: closedOnly('$closingCount.total') },
        variance: { $sum: closedOnly({ $ifNull: ['$variance', 0] }) },
        shortCount: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'open'] }, { $lte: [{ $ifNull: ['$variance', 0] }, -1] }] }, 1, 0] } },
        overCount: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'open'] }, { $gte: [{ $ifNull: ['$variance', 0] }, 1] }] }, 1, 0] } },
        shortTotal: { $sum: { $cond: [{ $lt: [{ $ifNull: ['$variance', 0] }, 0] }, closedOnly({ $ifNull: ['$variance', 0] }), 0] } },
        lateOpen: { $sum: { $cond: ['$lateOpen', 1, 0] } },
        lateClose: { $sum: { $cond: ['$lateClose', 1, 0] } },
      },
    },
  ]);
  const out = row || { sessions: 0 };
  delete out._id;
  for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

function pktStamp(date, tz) {
  if (!date) return '';
  const p = tillService.zonedParts(date, tz);
  return `${p.dayKey} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// CSV cell: quote when needed; neutralise formula injection in text cells.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const tillController = {
  // GET /api/till-sessions/my — status for the POS strip (no money except the float).
  async my(req, res) {
    res.json({ success: true, data: await tillService.myStatus(req) });
  },

  // GET /api/till-sessions/my/history — my own sessions (blind: no expected / variance).
  async myHistory(req, res) {
    const { page, limit, skip } = paging(req.query, 20, 100);
    const filter = { cashier: oid(req.access.userId) };
    const [total, rows] = await Promise.all([
      CashSession.countDocuments(filter),
      CashSession.find(filter).sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    res.json({
      success: true,
      data: rows.map((s) => tillService.serializeSession(s)),
      meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  },

  // POST /api/till-sessions/open { counterId?, denominations: { "1000": 2, ... }, note? }
  async open(req, res) {
    const session = await tillService.openSession(req, req.body || {});
    res.status(201).json({ success: true, data: tillService.serializeSession(session), message: 'Till opened' });
  },

  // POST /api/till-sessions/:id/close { denominations, note? } — blind count.
  async close(req, res) {
    const session = await tillService.closeSession(req, req.params.id, req.body || {});
    res.json({
      success: true,
      data: tillService.serializeSession(session, { full: tillService.canSeeExpected(req.access) }),
      message: 'Till closed. The admin will verify your cash.',
    });
  },

  // GET /api/till-sessions?from=&to=&counter=&cashier=&status=&search=&page=&limit=
  async list(req, res) {
    const { page, limit, skip } = paging(req.query);
    const filter = await sessionFilter(req);
    const [total, rows, summary] = await Promise.all([
      CashSession.countDocuments(filter),
      CashSession.find(filter).populate('branch', 'name code').sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
      summarize(filter),
    ]);
    res.json({
      success: true,
      data: rows.map((s) => tillService.serializeSession(s, { full: true })),
      meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), summary },
    });
  },

  // GET /api/till-sessions/:id — verifier: expected vs counted + bills; cashier: own session, blind.
  async detail(req, res) {
    if (!isId(req.params.id)) throw httpError(404, 'Till session not found');
    const s = await CashSession.findById(req.params.id)
      .populate('branch', 'name code')
      .populate('verifiedBy', 'firstName lastName')
      .populate('closedBy', 'firstName lastName')
      .populate('history.by', 'firstName lastName')
      .lean();
    if (!s) throw httpError(404, 'Till session not found');
    tillService.assertSessionBranch(req.access, s);
    if (!tillService.canSeeExpected(req.access)) {
      if (String(s.cashier) !== String(req.access.userId)) throw httpError(404, 'Till session not found');
      return res.json({ success: true, data: tillService.serializeSession(s) });
    }
    const until = s.status === 'open' ? new Date() : s.closedAt;
    const live = await tillService.computeExpected(s, until);
    const stored = s.expected || {};
    // Bills can change after close (late refund / delete): show the recount when it differs.
    const changed = s.status !== 'open' && Math.abs((live.expected.expectedCash || 0) - (stored.expectedCash || 0)) >= 0.01;
    res.json({
      success: true,
      data: {
        ...tillService.serializeSession(s, { full: true }),
        bills: live.bills,
        voided: live.voided,
        nonCash: live.nonCash,
        liveExpected: s.status === 'open' || changed ? live.expected : null,
      },
    });
  },

  // POST /api/till-sessions/:id/verify { note? }
  async verify(req, res) {
    const s = await tillService.reviewSession(req, req.params.id, { action: 'verify', note: req.body && req.body.note });
    res.json({ success: true, data: tillService.serializeSession(s, { full: true }), message: 'Cash closing verified' });
  },

  // POST /api/till-sessions/:id/dispute { note }
  async dispute(req, res) {
    const s = await tillService.reviewSession(req, req.params.id, { action: 'dispute', note: req.body && req.body.note });
    res.json({ success: true, data: tillService.serializeSession(s, { full: true }), message: 'Cash closing disputed' });
  },

  // GET /api/till-sessions/report — cash closing report (closed sessions by default).
  async report(req, res) {
    const { page, limit, skip } = paging(req.query, 100, 500);
    const filter = await sessionFilter(req, { defaultStatuses: ['closed', 'verified', 'disputed'] });
    const [total, rows, summary, byCashier] = await Promise.all([
      CashSession.countDocuments(filter),
      CashSession.find(filter)
        .populate('branch', 'name code')
        .populate('verifiedBy', 'firstName lastName')
        .sort({ openedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      summarize(filter),
      CashSession.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$cashier',
            cashierName: { $last: '$cashierName' },
            sessions: { $sum: 1 },
            expectedCash: { $sum: closedOnly('$expected.expectedCash') },
            counted: { $sum: closedOnly('$closingCount.total') },
            variance: { $sum: closedOnly({ $ifNull: ['$variance', 0] }) },
            shortCount: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$variance', 0] }, -1] }, 1, 0] } },
          },
        },
        { $sort: { variance: 1 } },
        { $limit: 100 },
      ]),
    ]);
    res.json({
      success: true,
      data: rows.map((s) => tillService.serializeSession(s, { full: true })),
      meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), summary, byCashier },
    });
  },

  // GET /api/till-sessions/report/export — CSV of the same filters (max 5000 rows).
  async exportCsv(req, res) {
    const tz = await tillService.getTimeZone();
    const filter = await sessionFilter(req, { defaultStatuses: ['closed', 'verified', 'disputed'] });
    const rows = await CashSession.find(filter)
      .populate('branch', 'name code')
      .populate('verifiedBy', 'firstName lastName')
      .sort({ openedAt: -1 })
      .limit(5000)
      .lean();
    const header = [
      'Session', 'Branch', 'Counter', 'Cashier', 'Opened (PKT)', 'Closed (PKT)', 'Status',
      'Opening float', 'Cash sales', 'Cash received on credit', 'Cash refunds', 'Expected cash',
      'Counted cash', 'Variance', 'Late open', 'Late close', 'Verified by', 'Verified at (PKT)', 'Note',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const s of rows) {
      const e = s.expected || {};
      const closed = s.status !== 'open';
      const verifier = s.verifiedBy ? `${s.verifiedBy.firstName || ''} ${s.verifiedBy.lastName || ''}`.trim() : '';
      lines.push(
        [
          s.sessionNo,
          s.branch ? s.branch.name : '',
          s.counterName,
          s.cashierName,
          pktStamp(s.openedAt, tz),
          pktStamp(s.closedAt, tz),
          s.status,
          (s.openingFloat && s.openingFloat.total) || 0,
          closed ? e.cashSales || 0 : '',
          closed ? e.cashReceivedOnCredit || 0 : '',
          closed ? e.cashRefunds || 0 : '',
          closed ? e.expectedCash || 0 : '',
          closed && s.closingCount ? s.closingCount.total || 0 : '',
          closed && typeof s.variance === 'number' ? s.variance : '',
          s.lateOpen ? 'yes' : '',
          s.lateClose ? 'yes' : '',
          verifier,
          pktStamp(s.verifiedAt, tz),
          [s.closeNote, s.verifyNote].filter(Boolean).join(' | '),
        ]
          .map(csvCell)
          .join(',')
      );
    }
    const day = tillService.zonedParts(new Date(), tz).dayKey;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cash-closing-${day}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  },
};

module.exports = tillController;
