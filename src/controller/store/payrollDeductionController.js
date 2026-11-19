// Payroll deductions (/api/payroll-deductions): till shortages (made by the
// till verify hook), damage and other. Logic: services/hr/payrollService.js.
const svc = require('../../services/hr/payrollService');

const ok = (res, data, status = 200, meta, message) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(message ? { message } : {}) });

// Who may do what (owner 2026-11-19):
//   payroll edit                    -> every deduction, approve / waive any of them
//   payroll_own_deductions (no payroll edit) -> sees ONLY the deductions they added,
//                                      approves / waives only those (with its `edit`)
//   payroll view only               -> sees every deduction, cannot decide
function scopeOf(access) {
  const full = access.can('payroll', 'edit');
  const own = !full && ['view', 'create', 'edit'].some((a) => access.can('payroll_own_deductions', a));
  return {
    userId: access.userId,
    ownOnly: own,
    canDecideAll: full,
    canDecideOwn: full || access.can('payroll_own_deductions', 'edit'),
  };
}

module.exports = {
  async list(req, res) {
    const { data, meta } = await svc.listDeductions(req.query, { scope: scopeOf(req.access) });
    ok(res, data, 200, meta);
  },
  // POST { employeeId, type: damage|other, amount, date, note, approveNow? (needs payroll edit or own-deductions edit) }
  async create(req, res) {
    const scope = scopeOf(req.access);
    const data = await svc.createDeduction(req.body || {}, { userId: req.access.userId, canApprove: scope.canDecideOwn, scope });
    ok(res, data, 201, undefined, data.status === 'approved' ? 'Deduction added and approved' : 'Deduction added (waiting for approval)');
  },
  // POST /:id/approve { amount? } — approve all or part of it
  async approve(req, res) {
    ok(res, await svc.approveDeduction(req.params.id, req.body || {}, { userId: req.access.userId, scope: scopeOf(req.access) }), 200, undefined, 'Deduction approved');
  },
  // POST /:id/waive { note }
  async waive(req, res) {
    ok(res, await svc.waiveDeduction(req.params.id, req.body || {}, { userId: req.access.userId, scope: scopeOf(req.access) }), 200, undefined, 'Deduction waived');
  },
};
