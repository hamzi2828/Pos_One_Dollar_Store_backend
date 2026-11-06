// Staff tips (/api/staff-tips). Logic: services/hr/tipService.js.
// Each tip posts an Expense in "Staff Tips"; it never changes salary.
const svc = require('../../services/hr/tipService');
const { resolveWriteBranch } = require('../../middleware/access');

const ok = (res, data, status = 200, meta, message) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(message ? { message } : {}) });

module.exports = {
  // GET ?from=&to=&employee=&search=&page=&limit=
  async list(req, res) {
    const { data, meta } = await svc.listTips(req.query);
    ok(res, data, 200, meta);
  },
  // POST { date, method, note, tips: [{ employeeId, amount, note? }] }
  async create(req, res) {
    const branchId = await resolveWriteBranch(req);
    const data = await svc.createTips(req.body || {}, { userId: req.access.userId, branchId });
    ok(res, data, 201, undefined, data.length === 1 ? 'Tip saved' : `${data.length} tips saved`);
  },
  // DELETE /:id ?reason= — also removes its expense
  async remove(req, res) {
    ok(res, await svc.deleteTip(req.params.id, { ...(req.query || {}), ...(req.body || {}) }, { userId: req.access.userId }), 200, undefined, 'Tip deleted');
  },
};
