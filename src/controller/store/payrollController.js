// Payroll runs (/api/payroll/...). Logic: services/hr/payrollService.js.
const svc = require('../../services/hr/payrollService');
const { resolveWriteBranch } = require('../../middleware/access');

const ok = (res, data, status = 200, meta, message) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(message ? { message } : {}) });
const ctx = (req) => ({ userId: req.access.userId });

module.exports = {
  // GET /api/payroll/employees?search= — staff picker for advances / deductions
  async employees(req, res) {
    ok(res, await svc.employeeOptions(req.query));
  },

  // GET /api/payroll/runs?month=&status=
  async list(req, res) {
    const { data, meta } = await svc.listRuns(req.query);
    ok(res, data, 200, meta);
  },

  // POST /api/payroll/runs { month } -> new draft (201) or the month's existing draft (200)
  async generate(req, res) {
    const { run, existing } = await svc.generateRun(req.body && req.body.month, ctx(req));
    ok(res, run, existing ? 200 : 201, { existing }, existing ? 'This month already has a draft' : 'Draft payroll ready');
  },

  async get(req, res) {
    ok(res, await svc.getRun(req.params.id));
  },

  async regenerate(req, res) {
    ok(res, await svc.regenerateRun(req.params.id, ctx(req)), 200, undefined, 'Payroll rebuilt');
  },

  // PUT /api/payroll/runs/:id/lines/:lineId { bonus, bonusNote, adjustments, advanceRecoveryOverride, note }
  async updateLine(req, res) {
    ok(res, await svc.updateLine(req.params.id, req.params.lineId, req.body || {}, ctx(req)), 200, undefined, 'Saved');
  },

  async remove(req, res) {
    ok(res, await svc.deleteRun(req.params.id, ctx(req)), 200, undefined, 'Draft deleted');
  },

  async approve(req, res) {
    ok(res, await svc.approveRun(req.params.id, ctx(req)), 200, undefined, 'Payroll approved');
  },

  // POST /api/payroll/runs/:id/reopen { reason } (super admin)
  async reopen(req, res) {
    ok(res, await svc.reopenRun(req.params.id, req.body || {}, ctx(req)), 200, undefined, 'Payroll reopened as a draft');
  },

  // POST /api/payroll/runs/:id/pay { lineIds?, method, date, reference, requestId? }
  async pay(req, res) {
    const branchId = await resolveWriteBranch(req);
    const { run, payment, repeated } = await svc.payRun(req.params.id, req.body || {}, { ...ctx(req), branchId });
    ok(res, run, 200, { payment, repeated }, repeated ? 'Already paid' : 'Salaries marked as paid');
  },

  async payslip(req, res) {
    ok(res, await svc.payslip(req.params.id, req.params.lineId));
  },

  // GET /api/payroll/runs/:id/export — payroll register CSV
  async exportCsv(req, res) {
    const { csv, filename } = await svc.exportCsv(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(`﻿${csv}`); // BOM so Excel reads UTF-8
  },
};
