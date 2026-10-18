// Discount rules (/api/discount-rules). Logic: services/sales/discountRuleService.js.
// Errors are thrown with err.status; routes wrap these with handle().
const svc = require('../../services/sales/discountRuleService');

const discountRuleController = {
  // GET /api/discount-rules?search=&status=running|scheduled|ended|off&kind=&page=&limit=
  async list(req, res) {
    const { data, meta } = await svc.list(req.query);
    res.json({ success: true, data, meta });
  },

  // GET /api/discount-rules/preview?subtotal=5000 — "test a bill amount"
  async preview(req, res) {
    const data = await svc.preview({ subtotal: req.query.subtotal ?? req.query.amount, at: req.query.at });
    res.json({ success: true, data });
  },

  // GET /api/discount-rules/:id
  async get(req, res) {
    res.json({ success: true, data: await svc.getOne(req.params.id) });
  },

  // POST /api/discount-rules
  async create(req, res) {
    const data = await svc.create(req.body || {}, req.access);
    res.status(201).json({ success: true, data, message: 'Discount rule created' });
  },

  // PUT /api/discount-rules/:id
  async update(req, res) {
    const data = await svc.update(req.params.id, req.body || {}, req.access);
    res.json({ success: true, data, message: 'Discount rule saved' });
  },

  // PATCH /api/discount-rules/:id/active  { isActive }
  async setActive(req, res) {
    const data = await svc.setActive(req.params.id, (req.body || {}).isActive, req.access);
    res.json({ success: true, data, message: data.isActive ? 'Rule switched on' : 'Rule switched off' });
  },

  // DELETE /api/discount-rules/:id
  async remove(req, res) {
    await svc.remove(req.params.id, req.access);
    res.json({ success: true, data: { deleted: true }, message: 'Discount rule deleted' });
  },
};

module.exports = discountRuleController;
