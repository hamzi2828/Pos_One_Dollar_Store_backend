// Employees (/api/employees). Logic: services/hr/employeeService.js.
const svc = require('../../services/hr/employeeService');
const { saveUploads } = require('../../helper/storeUpload');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

module.exports = {
  async list(req, res) {
    const { data, meta } = await svc.list(req);
    ok(res, data, 200, meta);
  },
  async get(req, res) {
    ok(res, await svc.get(req, req.params.id));
  },
  async create(req, res) {
    ok(res, await svc.create(req), 201);
  },
  async update(req, res) {
    ok(res, await svc.update(req, req.params.id));
  },
  async setStatus(req, res) {
    ok(res, await svc.setStatus(req, req.params.id));
  },
  async remove(req, res) {
    ok(res, await svc.remove(req, req.params.id));
  },
  async uploadPhoto(req, res) {
    await svc.load(req, req.params.id); // 404 before saving files
    ok(res, await svc.setPhoto(req, req.params.id, await saveUploads(req, 'hr/employees')));
  },
  async uploadDocuments(req, res) {
    await svc.load(req, req.params.id);
    ok(res, await svc.addDocuments(req, req.params.id, await saveUploads(req, 'hr/documents')));
  },
  async removeDocument(req, res) {
    ok(res, await svc.removeDocument(req, req.params.id, req.params.docId));
  },
  async createLogin(req, res) {
    ok(res, await svc.createLogin(req, req.params.id), 201);
  },
  async removeLogin(req, res) {
    ok(res, await svc.removeLogin(req, req.params.id));
  },
  async linkableUsers(req, res) {
    if (!req.access.can('employees', 'create') && !req.access.can('employees', 'edit')) {
      return res.status(403).json({ success: false, message: 'You do not have permission for this action' });
    }
    ok(res, await svc.linkableUsers(req));
  },
};
