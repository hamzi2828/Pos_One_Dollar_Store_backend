// src/controller/store/desktopController.js
// /api/desktop/* — the Windows attendance app on the counter PC (pos_desktop).
// Attendance is marked ONLY by fingerprint on that app. Logic lives in
// services/hr/desktopService.js. OWNER: Desktop attendance module.
const svc = require('../../services/hr/desktopService');

module.exports = {
  // GET /api/desktop/session
  async session(req, res) {
    res.json({ success: true, data: await svc.sessionInfo(req.access) });
  },

  // POST /api/desktop/session/renew
  async renew(req, res) {
    res.json({ success: true, data: await svc.renewToken(req.access) });
  },

  // GET /api/desktop/employees
  async employees(req, res) {
    res.json({ success: true, data: await svc.listEmployees() });
  },

  // GET /api/desktop/fingerprints?updatedSince=ISO
  async fingerprints(req, res) {
    res.json({ success: true, data: await svc.listTemplates({ updatedSince: req.query.updatedSince }) });
  },

  // POST /api/desktop/fingerprints/:employeeId { finger, template, quality?, deviceName? }
  async enroll(req, res) {
    const out = await svc.enroll(req.params.employeeId, req.body || {}, { userId: req.access.userId });
    res.status(out.created ? 201 : 200).json({ success: true, data: out.data, message: out.message });
  },

  // DELETE /api/desktop/fingerprints/:employeeId/:finger
  async removeFinger(req, res) {
    const out = await svc.removeFinger(req.params.employeeId, req.params.finger, { userId: req.access.userId });
    res.json({ success: true, data: out.data, message: out.message });
  },

  // POST /api/desktop/punch { employeeId, method: 'fingerprint', clientId, deviceName, offline?, at?, sentAt? }
  async punch(req, res) {
    const data = await svc.punch(req.body || {}, { userId: req.access.userId });
    res.json({ success: true, data, message: data.message });
  },

  // GET /api/desktop/board?date=YYYY-MM-DD
  async board(req, res) {
    res.json({ success: true, data: await svc.board({ date: req.query.date }) });
  },
};
