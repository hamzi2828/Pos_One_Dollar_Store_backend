// Contract letters (/api/employees/:id/contract) and templates (/api/contract-templates).
// Logic: services/hr/contractService.js.
const svc = require('../../services/hr/contractService');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

module.exports = {
  // Letter for one employee (needs employees:edit — it shows salary and CNIC).
  async render(req, res) {
    ok(res, await svc.render(req, req.params.id));
  },
  async issue(req, res) {
    ok(res, await svc.issue(req, req.params.id), 201);
  },

  async listTemplates(req, res) {
    const { data, meta } = await svc.listTemplates(req);
    ok(res, data, 200, meta);
  },
  async getTemplate(req, res) {
    ok(res, await svc.getTemplate(req.params.id));
  },
  async createTemplate(req, res) {
    ok(res, await svc.createTemplate(req), 201);
  },
  async updateTemplate(req, res) {
    ok(res, await svc.updateTemplate(req, req.params.id));
  },
  async removeTemplate(req, res) {
    ok(res, await svc.removeTemplate(req, req.params.id));
  },
};
