// Public employee join link + job applications. Logic: services/hr/joinService.js.
const svc = require('../../services/hr/joinService');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

module.exports = {
  // ----- public (no login) -----
  async publicInfo(req, res) {
    ok(res, await svc.publicInfo(req.params.token));
  },
  async publicSubmit(req, res) {
    ok(res, await svc.submit(req, req.params.token), 201);
  },
  // The person's own application (header x-join-key = the editKey from submit).
  async publicMine(req, res) {
    ok(res, await svc.getMine(req.params.token, req.get('x-join-key')));
  },
  async publicUpdateMine(req, res) {
    ok(res, await svc.updateMine(req, req.params.token, req.get('x-join-key')));
  },

  // ----- link settings -----
  async getLink(req, res) {
    ok(res, await svc.getLink(req));
  },
  async regenerateLink(req, res) {
    ok(res, await svc.regenerateLink(req));
  },
  async setLink(req, res) {
    ok(res, await svc.setEnabled(req));
  },

  // ----- applications -----
  async list(req, res) {
    const { data, meta } = await svc.list(req);
    ok(res, data, 200, meta);
  },
  async get(req, res) {
    ok(res, await svc.get(req, req.params.id));
  },
  async approve(req, res) {
    ok(res, await svc.approve(req, req.params.id));
  },
  async reject(req, res) {
    ok(res, await svc.reject(req, req.params.id));
  },
};
