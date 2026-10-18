// Weekly roster (/api/roster). Logic: services/hr/rosterService.js.
const roster = require('../../services/hr/rosterService');

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

module.exports = {
  /** GET /roster?from=YYYY-MM-DD&days=7 */
  async grid(req, res) {
    ok(res, await roster.grid({ from: req.query.from, days: req.query.days }));
  },

  /** PUT /roster/cells { cells: [{ employeeId, date, type, shiftId?, leaveType?, note? }] } */
  async saveCells(req, res) {
    ok(res, await roster.saveCells((req.body || {}).cells, { userId: req.access.userId }));
  },

  /** POST /roster/copy-week { fromWeekStart, toWeekStart, overwrite? } */
  async copyWeek(req, res) {
    const b = req.body || {};
    ok(res, await roster.copyWeek({ fromWeekStart: b.fromWeekStart, toWeekStart: b.toWeekStart, overwrite: b.overwrite === true, userId: req.access.userId }));
  },
};
