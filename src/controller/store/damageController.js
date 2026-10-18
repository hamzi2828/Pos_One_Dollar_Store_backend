// src/controller/store/damageController.js
// /api/damages — daily damage list, report (scan), approve / reject.
// Logic lives in services/stockops/damageService.js.
const { branchFilter, resolveWriteBranch } = require('../../middleware/access');
const { saveUploads } = require('../../helper/storeUpload');
const damageService = require('../../services/stockops/damageService');
const { sendCsv } = require('../../services/stockops/common');

const scope = (req) => branchFilter(req);

module.exports = {
  async list(req, res) {
    const out = await damageService.list(req.query, scope(req));
    res.json({ success: true, ...out });
  },

  async daily(req, res) {
    const data = await damageService.daily(req.query, scope(req));
    res.json({ success: true, data });
  },

  async dailyExport(req, res) {
    const { filename, csv } = await damageService.dailyCsv(req.query, scope(req));
    sendCsv(res, filename, csv);
  },

  async get(req, res) {
    res.json({ success: true, data: await damageService.getOne(req.params.id, scope(req)) });
  },

  async create(req, res) {
    const branchId = await resolveWriteBranch(req);
    const photos = await saveUploads(req, 'damages');
    const rec = await damageService.report(req.body || {}, { branchId, userId: req.access.userId, photos });
    res.status(201).json({ success: true, data: await damageService.getOne(rec._id), message: `Damage ${rec.damageNo} reported` });
  },

  async approve(req, res) {
    const rec = await damageService.approve(req.params.id, { userId: req.access.userId, scope: scope(req), note: req.body && req.body.note });
    res.json({ success: true, data: await damageService.getOne(rec._id), message: `${rec.damageNo} approved — stock taken off` });
  },

  async reject(req, res) {
    const rec = await damageService.reject(req.params.id, { userId: req.access.userId, scope: scope(req), reason: req.body && req.body.reason });
    res.json({ success: true, data: await damageService.getOne(rec._id), message: `${rec.damageNo} rejected` });
  },

  async remove(req, res) {
    res.json({ success: true, data: await damageService.remove(req.params.id, { userId: req.access.userId, scope: scope(req) }) });
  },

  async getSettings(req, res) {
    res.json({ success: true, data: await damageService.getSettings() });
  },

  async setSettings(req, res) {
    res.json({ success: true, data: await damageService.setSettings(req.body || {}, req.access.userId) });
  },
};
