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
    ok(res, grn, { alreadyCompleted: !!grn.alreadyCompleted, warnings: grn.warnings || [] });
  },

  // ----- simple buying flow (docs/BUYING_FLOW.md)

  // POST /receiving/:id/boxes { boxes: [{ bill, received }], note? } -> data: GRN, warnings
  checkBoxes: async (req, res) => {
    const { grn, warnings } = await service.checkBoxes(req, req.params.id, req.body);
    ok(res, grn, { warnings });
  },

  // GET /receiving/:id/lookup?code=&bill= -> data: units[]
  lookup: async (req, res) => ok(res, await service.lookup(req, req.params.id, req.query)),

  // POST /receiving/:id/new-product -> data: unit (same shape as lookup)
  newProduct: async (req, res) => res.status(201).json({ success: true, data: await service.newProduct(req, req.params.id, req.body) }),

  // POST /receiving/:id/entries -> data: { entry, grn, tags, warnings }
  addEntry: async (req, res) => {
    const out = await service.addEntry(req, req.params.id, req.body);
    res.status(out.repeated ? 200 : 201).json({ success: true, data: out });
  },

  // DELETE /receiving/:id/entries/:entryId -> data: { entry, grn }
  undoEntry: async (req, res) => ok(res, await service.undoEntry(req, req.params.id, req.params.entryId)),

  markBox: async (req, res) => ok(res, await service.markBox(req, req.params.id, req.body || {})),
};
