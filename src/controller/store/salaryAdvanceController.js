// Salary advances (/api/salary-advances). Logic: services/hr/payrollService.js.
// Recoveries are recorded by payroll approval, not here.
const svc = require('../../services/hr/payrollService');

const ok = (res, data, status = 200, meta, message) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(message ? { message } : {}) });

module.exports = {
  async list(req, res) {
    const { data, meta } = await svc.listAdvances(req.query);
    ok(res, data, 200, meta);
  },
  // POST { employeeId, amount, date, method, reference, installments, note }
  async create(req, res) {
    ok(res, await svc.createAdvance(req.body || {}, { userId: req.access.userId }), 201, undefined, 'Advance given');
  },
  async get(req, res) {
    ok(res, await svc.getAdvance(req.params.id));
  },
  // POST /:id/cancel { reason } — only while nothing is recovered
  async cancel(req, res) {
    ok(res, await svc.cancelAdvance(req.params.id, req.body || {}, { userId: req.access.userId }), 200, undefined, 'Advance cancelled');
  },
};
