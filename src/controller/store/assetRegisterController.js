// Asset register (/api/assets) and asset categories (/api/asset-categories).
// Logic: services/hr/assetService.js. (The old controller/assetController.js
// still serves /assets for the old screen.)
const svc = require('../../services/hr/assetService');
const { saveUploads } = require('../../helper/storeUpload');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

module.exports = {
  async list(req, res) {
    const { data, meta } = await svc.list(req);
    ok(res, data, 200, meta);
  },
  async summary(req, res) {
    ok(res, await svc.summary(req));
  },
  async exportCsv(req, res) {
    const csv = await svc.exportCsv(req);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets-${day}.csv"`);
    res.status(200).send(`﻿${csv}`); // BOM so Excel reads UTF-8
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
  async uploadPhotos(req, res) {
    await svc.get(req, req.params.id); // 404 before saving files
    ok(res, await svc.addPhotos(req, req.params.id, await saveUploads(req, 'assets')));
  },
  async addMaintenance(req, res) {
    ok(res, await svc.addMaintenance(req, req.params.id), 201);
  },
  async dispose(req, res) {
    ok(res, await svc.dispose(req, req.params.id));
  },
  async setStatus(req, res) {
    ok(res, await svc.setStatus(req, req.params.id));
  },
  async remove(req, res) {
    ok(res, await svc.remove(req, req.params.id));
  },

  async listCategories(req, res) {
    ok(res, await svc.listCategories(req));
  },
  async createCategory(req, res) {
    ok(res, await svc.createCategory(req), 201);
  },
  async updateCategory(req, res) {
    ok(res, await svc.updateCategory(req, req.params.id));
  },
  async removeCategory(req, res) {
    ok(res, await svc.removeCategory(req, req.params.id));
  },
};
