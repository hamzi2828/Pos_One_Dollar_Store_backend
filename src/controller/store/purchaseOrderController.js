// src/controller/store/purchaseOrderController.js
// HTTP layer for purchase orders (logic: services/purchasing/purchaseOrderService.js).
// Every handler is wrapped with handle() in the route file: thrown errors with
// `status` become { success: false, message }.
const service = require('../../services/purchasing/purchaseOrderService');
const { searchUnits } = require('../../services/purchasing/productLookup');
const { saveUploads } = require('../../helper/storeUpload');

const ok = (res, data, extra = {}, status = 200) => res.status(status).json({ success: true, data, ...extra });

module.exports = {
  meta: async (req, res) => ok(res, await service.meta()),
  settings: async (req, res) => ok(res, await service.settings()),
  updateSettings: async (req, res) => ok(res, await service.updateSettings(req, req.body || {})),

  // GET /purchase-orders/product-search?search=&ids=a,b
  productSearch: async (req, res) =>
    ok(
      res,
      await searchUnits({
        search: req.query.search || req.query.q || '',
        ids: req.query.ids || '',
        branchId: req.access.branchId,
        limit: req.query.limit,
      })
    ),

  list: async (req, res) => {
    const { data, meta } = await service.list(req);
    ok(res, data, { meta });
  },

  get: async (req, res) => ok(res, await service.getOne(req, req.params.id)),

  costing: async (req, res) => ok(res, await service.costingFor(req, req.params.id)),

  create: async (req, res) => ok(res, await service.create(req, req.body), {}, 201),

  update: async (req, res) => ok(res, await service.updateHeader(req, req.params.id, req.body)),

  addBill: async (req, res) => {
    const photos = await saveUploads(req, 'purchasing/bills');
    const { po, billId } = await service.addBill(req, req.params.id, req.body, photos);
    ok(res, po, { billId }, 201);
  },

  updateBill: async (req, res) => {
    const photos = await saveUploads(req, 'purchasing/bills');
    ok(res, await service.updateBill(req, req.params.id, req.params.billId, req.body, photos));
  },

  removeBill: async (req, res) => ok(res, await service.removeBill(req, req.params.id, req.params.billId)),

  addItems: async (req, res) => {
    const { po, itemIds } = await service.addItems(req, req.params.id, req.params.billId, req.body);
    ok(res, po, { itemIds }, 201);
  },

  addNewProduct: async (req, res) => {
    const { po, itemIds, product } = await service.addNewProduct(req, req.params.id, req.params.billId, req.body);
    ok(res, po, { itemIds, product }, 201);
  },

  updateItem: async (req, res) =>
    ok(res, await service.updateItem(req, req.params.id, req.params.billId, req.params.itemId, req.body)),

  removeItem: async (req, res) => ok(res, await service.removeItem(req, req.params.id, req.params.billId, req.params.itemId)),

  addCharge: async (req, res) => ok(res, await service.addCharge(req, req.params.id, req.body), {}, 201),

  updateCharge: async (req, res) => ok(res, await service.updateCharge(req, req.params.id, req.params.chargeId, req.body)),

  removeCharge: async (req, res) => ok(res, await service.removeCharge(req, req.params.id, req.params.chargeId)),

  close: async (req, res) => {
    const photos = await saveUploads(req, 'purchasing/builty');
    const { po, grn, warnings } = await service.close(req, req.params.id, req.body, photos);
    ok(res, po, { grn, warnings });
  },

  cancel: async (req, res) => ok(res, await service.cancel(req, req.params.id, req.body)),

  reopen: async (req, res) => ok(res, await service.reopen(req, req.params.id, req.body)),
};
