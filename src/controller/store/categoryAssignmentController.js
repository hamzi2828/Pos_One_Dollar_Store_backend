// src/controller/store/categoryAssignmentController.js
// Category staff (/api/category-assignments). Logic: services/analytics/categoryAssignmentService.js.
const svc = require('../../services/analytics/categoryAssignmentService');

const ok = (res, data, meta, status = 200) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

exports.list = async (req, res) => {
  const { data, meta } = await svc.list(req, req.query);
  ok(res, data, meta);
};

exports.get = async (req, res) => ok(res, await svc.get(req, req.params.id));

exports.create = async (req, res) => ok(res, await svc.create(req, req.body || {}), undefined, 201);

exports.update = async (req, res) => ok(res, await svc.update(req, req.params.id, req.body || {}));

exports.remove = async (req, res) => ok(res, await svc.remove(req, req.params.id));

exports.employees = async (req, res) =>
  ok(res, await svc.listEmployees({ search: req.query.search, includeInactive: req.query.includeInactive === 'true' }));

exports.categories = async (req, res) => ok(res, await svc.listCategories());
