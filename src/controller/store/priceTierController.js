// Price tiers (/api/price-tiers). Logic: services/sales/priceTierService.js.
// Errors are thrown with err.status; routes wrap these with handle().
const svc = require('../../services/sales/priceTierService');

const userOf = (req) => (req.access && req.access.userId) || null;

const priceTierController = {
  // GET /api/price-tiers?search=&isActive=&page=&limit=
  async list(req, res) {
    const { data, meta } = await svc.list(req.query);
    res.json({ success: true, data, meta });
  },

  // GET /api/price-tiers/candidates?search=&tierId=&notInTier=true&page=&limit=
  async candidates(req, res) {
    const { data, meta } = await svc.candidates(req.query);
    res.json({ success: true, data, meta });
  },

  // GET /api/price-tiers/product/:productId -> the product's tier (or null)
  async ofProduct(req, res) {
    res.json({ success: true, data: await svc.tierOfProduct(req.params.productId) });
  },

  // GET /api/price-tiers/:id?search=&flag=&page=&limit= -> { tier, summary, products, meta }
  async detail(req, res) {
    const { meta, ...data } = await svc.detail(req.params.id, req.query);
    res.json({ success: true, data, meta });
  },

  // POST /api/price-tiers
  async create(req, res) {
    const data = await svc.create(req.body || {}, { userId: userOf(req) });
    res.status(201).json({ success: true, data, message: 'Price tier created' });
  },

  // PUT /api/price-tiers/:id  (a new price re-prices every linked product)
  async update(req, res) {
    const { tier, repriced } = await svc.update(req.params.id, req.body || {}, { userId: userOf(req) });
    res.json({
      success: true,
      data: tier,
      meta: { repriced },
      message: repriced ? `Tier saved — ${repriced} product(s) re-priced` : 'Tier saved',
    });
  },

  // DELETE /api/price-tiers/:id  (products keep their price, lose the link)
  async remove(req, res) {
    const data = await svc.remove(req.params.id, { userId: userOf(req) });
    res.json({ success: true, data, message: 'Price tier deleted' });
  },

  // POST /api/price-tiers/:id/assign  { productIds: [] }
  async assign(req, res) {
    const { updated, movedFromOtherTier, tier } = await svc.assign(req.params.id, (req.body || {}).productIds, { userId: userOf(req) });
    res.json({
      success: true,
      data: { updated, movedFromOtherTier },
      message: `${updated} product(s) now sell at ${tier.name}`,
    });
  },

  // POST /api/price-tiers/unassign  { productIds: [], tierId? }
  async unassign(req, res) {
    const body = req.body || {};
    const data = await svc.unassign(body.productIds, { tierId: body.tierId });
    res.json({ success: true, data, message: `${data.updated} product(s) removed from the tier` });
  },
};

module.exports = priceTierController;
