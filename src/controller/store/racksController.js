// src/controller/store/racksController.js
// Racks & shelves of the request's branch (see racksCommon.moduleBranch).
// Logic lives in services/inventory/racksService.js; errors carry err.status
// and are turned into JSON by routes/modules/_access.handle.
const racksService = require('../../services/inventory/racksService');
const { moduleBranch, userIdOf } = require('./racksCommon');
const { printLabels } = require('./racksLabels');

const racksController = {
  // GET /api/racks?zone=&search=&isActive=&page=&limit=
  async list(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const q = req.query || {};
    const out = await racksService.listRacks({
      branchId,
      zone: q.zone,
      search: q.search,
      isActive: q.isActive,
      page: q.page,
      limit: q.limit,
    });
    res.json({
      success: true,
      data: out.items,
      meta: {
        page: out.page,
        limit: out.limit,
        total: out.total,
        pages: Math.max(1, Math.ceil(out.total / out.limit)),
        zones: out.zones,
        branch,
      },
    });
  },

  // GET /api/racks/:id
  async get(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const rack = await racksService.getRack({ branchId, rackId: req.params.id });
    res.json({ success: true, data: rack, meta: { branch } });
  },

  // POST /api/racks/generate { zones: ['A','B','C','D'], racksPerZone: 20, shelvesPerRack: 4 }
  async generate(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const b = req.body || {};
    const result = await racksService.generateLayout({
      branchId,
      zones: b.zones,
      racksPerZone: b.racksPerZone ?? b.perZone,
      shelvesPerRack: b.shelvesPerRack,
      userId: userIdOf(req),
    });
    const message =
      result.racksCreated || result.shelvesCreated
        ? `Created ${result.racksCreated} rack(s) and ${result.shelvesCreated} shelf/shelves in ${branch.name}.`
        : 'Everything already exists. Nothing new was created.';
    res.status(result.racksCreated || result.shelvesCreated ? 201 : 200).json({ success: true, data: result, message, meta: { branch } });
  },

  // POST /api/racks { zone, number, name?, description?, categories?, shelves? (default 4) }
  async create(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const b = req.body || {};
    const rack = await racksService.createRack({
      branchId,
      zone: b.zone,
      number: b.number,
      name: b.name,
      description: b.description,
      categories: b.categories,
      shelves: b.shelves ?? b.shelvesPerRack,
      sortOrder: b.sortOrder,
      userId: userIdOf(req),
    });
    res.status(201).json({ success: true, data: rack, message: `Rack ${rack.code} added`, meta: { branch } });
  },

  // PUT /api/racks/:id { name, description, categories, sortOrder, isActive }
  async update(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const rack = await racksService.updateRack({ branchId, rackId: req.params.id, body: req.body || {} });
    res.json({ success: true, data: rack, message: `Rack ${rack.code} saved`, meta: { branch } });
  },

  // DELETE /api/racks/:id  (409 while any shelf holds pieces)
  async remove(req, res) {
    const { branchId } = await moduleBranch(req);
    const out = await racksService.deleteRack({ branchId, rackId: req.params.id, userId: userIdOf(req) });
    res.json({ success: true, data: out, message: `Rack ${out.code} deleted` });
  },

  // POST /api/racks/:id/shelves { name?, capacity? } -> next level
  async addShelf(req, res) {
    const { branchId, branch } = await moduleBranch(req);
    const rack = await racksService.addShelf({ branchId, rackId: req.params.id, body: req.body || {} });
    const added = rack.shelves[rack.shelves.length - 1];
    res.status(201).json({ success: true, data: rack, message: `Shelf ${added ? added.code : ''} added`, meta: { branch } });
  },

  // PUT /api/racks/shelves/:shelfId { name, capacity, isActive }
  async updateShelf(req, res) {
    const { branchId } = await moduleBranch(req);
    const shelf = await racksService.updateShelf({ branchId, shelfId: req.params.shelfId, body: req.body || {} });
    res.json({ success: true, data: shelf, message: `Shelf ${shelf.code} saved` });
  },

  // DELETE /api/racks/shelves/:shelfId  (409 while it holds pieces)
  async deleteShelf(req, res) {
    const { branchId } = await moduleBranch(req);
    const out = await racksService.deleteShelf({ branchId, shelfId: req.params.shelfId, userId: userIdOf(req) });
    res.json({ success: true, data: out, message: `Shelf ${out.code} deleted` });
  },

  // GET /api/racks/labels?rackId=|zone=&type=&size=&copies= -> text/html
  labels: printLabels,
};

module.exports = racksController;
