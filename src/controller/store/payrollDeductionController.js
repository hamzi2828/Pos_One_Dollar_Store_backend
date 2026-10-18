// Payroll deductions (/api/payroll-deductions): till shortages (made by the
// till verify hook), damage and other. Logic: services/hr/payrollService.js.
const svc = require('../../services/hr/payrollService');

const ok = (res, data, status = 200, meta, message) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(message ? { message } : {}) });

module.exports = {
  async list(req, res) {
    const { data, meta } = await svc.listDeductions(req.query);
    ok(res, data, 200, meta);
  },
  // POST { employeeId, type: damage|other, amount, date, note, approveNow? (needs payroll edit) }
  async create(req, res) {
    const data = await svc.createDeduction(req.body || {}, { userId: req.access.userId, canApprove: req.access.can('payroll', 'edit') });
    ok(res, data, 201, undefined, data.status === 'approved' ? 'Deduction added and approved' : 'Deduction added (waiting for approval)');
  },
  // POST /:id/approve { amount? } — approve all or part of it
  async approve(req, res) {
    ok(res, await svc.approveDeduction(req.params.id, req.body || {}, { userId: req.access.userId }), 200, undefined, 'Deduction approved');
  },
  // POST /:id/waive { note }
  async waive(req, res) {
    ok(res, await svc.waiveDeduction(req.params.id, req.body || {}, { userId: req.access.userId }), 200, undefined, 'Deduction waived');
  },
};
