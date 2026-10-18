// src/controller/store/attendanceController.js
// /api/attendance/* — the manager side: who's in board, saved days, one day's
// detail, corrections, overtime approval, month sheet (+ CSV) and the
// "fix before payroll" list. Punches come from the fingerprint desktop app.
// Logic: services/hr/attendanceService.js.
const svc = require('../../services/hr/attendanceService');
const { sendCsv } = require('../../services/analytics/csv');

module.exports = {
  async board(req, res) {
    res.json({ success: true, data: await svc.board(req.query) });
  },

  async records(req, res) {
    const { data, meta } = await svc.listRecords(req.query);
    res.json({ success: true, data, meta });
  },

  async day(req, res) {
    res.json({ success: true, data: await svc.dayDetail(req.query) });
  },

  async correct(req, res) {
    const data = await svc.correctDay(req.body || {}, { userId: req.access.userId });
    res.json({ success: true, data, message: 'Times corrected' });
  },

  async overtime(req, res) {
    const data = await svc.decideOvertime(req.body || {}, { userId: req.access.userId });
    const n = data.updated.length;
    const message = `${data.approved ? 'Approved' : 'Rejected'} overtime on ${n} day${n === 1 ? '' : 's'}`;
    res.json({ success: true, data, message });
  },

  async sheet(req, res) {
    res.json({ success: true, data: await svc.sheet(req.query) });
  },

  async sheetExport(req, res) {
    const { filename, columns, rows } = await svc.sheetCsv(req.query);
    sendCsv(res, filename, columns, rows);
  },

  async exceptions(req, res) {
    res.json({ success: true, data: await svc.exceptions(req.query) });
  },
};
