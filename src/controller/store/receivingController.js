// src/controller/store/receivingController.js
// HTTP layer for goods receiving / GRN (logic: services/purchasing/receivingService.js).
const service = require('../../services/purchasing/receivingService');
const { saveUploads } = require('../../helper/storeUpload');

const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });

module.exports = {
  list: async (req, res) => {
    const { data, meta } = await service.list(req);
    ok(res, data, { meta });
  },

  get: async (req, res) => ok(res, await service.getOne(req, req.params.id)),

  start: async (req, res) => ok(res, await service.start(req, req.params.id)),

  saveCounts: async (req, res) => ok(res, await service.saveCounts(req, req.params.id, req.body)),

  scan: async (req, res) => {
    const { grn, scanned } = await service.scan(req, req.params.id, req.body);
    ok(res, grn, { scanned });
  },

  addPhotos: async (req, res) => ok(res, await service.addPhotos(req, req.params.id, await saveUploads(req, 'purchasing/receiving'))),

  complete: async (req, res) => {
    const grn = await service.complete(req, req.params.id, req.body);
    ok(res, grn, { alreadyCompleted: !!grn.alreadyCompleted });
  },
};
