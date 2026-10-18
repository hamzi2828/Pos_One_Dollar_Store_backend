// Shift types the shop works (/api/shifts), e.g. "Morning 10:00–18:00".
// Times are shop time; an end time at or before the start = ends next day.
// Delete is soft and refused while the shift is someone's default or used in
// the roster from today on (deactivate it instead: it then leaves the pickers
// but old days keep their shift).
const Shift = require('../../models/shift');
const Employee = require('../../models/employee');
const RosterEntry = require('../../models/rosterEntry');
const { escapeRegex } = require('../../helper/paginate');
const roster = require('../../services/hr/rosterService');

const { httpError, isId } = roster;
const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function load(id) {
  if (!isId(id)) throw httpError(404, 'Shift not found');
  const s = await Shift.findById(id);
  if (!s) throw httpError(404, 'Shift not found');
  return s;
}

/** How many current employees have it as default, and roster days from today on. */
async function usage(ids) {
  const today = roster.todayKey();
  const [defaults, cells] = await Promise.all([
    Employee.aggregate([
      { $match: roster.currentFilter({ defaultShift: { $in: ids } }) },
      { $group: { _id: '$defaultShift', n: { $sum: 1 } } },
    ]),
    RosterEntry.aggregate([{ $match: { type: 'shift', shift: { $in: ids }, date: { $gte: today } } }, { $group: { _id: '$shift', n: { $sum: 1 } } }]),
  ]);
  const d = new Map(defaults.map((x) => [String(x._id), x.n]));
  const c = new Map(cells.map((x) => [String(x._id), x.n]));
  return (id) => ({ defaultFor: d.get(String(id)) || 0, upcomingDays: c.get(String(id)) || 0 });
}

/** Body -> fields (partial on update). Throws 400 with a plain message. */
async function readBody(body = {}, current = null) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const out = {};
  if (!current || has('name')) {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Give the shift a name, e.g. Morning');
    const dup = await Shift.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...(current ? { _id: { $ne: current._id } } : {}) }).lean();
    if (dup) throw httpError(409, `There is already a shift called "${dup.name}"`, 'DUPLICATE_NAME');
    out.name = name;
  }
  if (!current || has('code')) {
    const code = String(body.code || '').trim().toUpperCase().slice(0, 4);
    out.code = code || (out.name || current.name).slice(0, 1).toUpperCase();
  }
  for (const k of ['start', 'end']) {
    if (current && !has(k)) continue;
    const v = String(body[k] || '').trim();
    if (!Shift.HHMM.test(v)) throw httpError(400, `${k === 'start' ? 'Start' : 'End'} time must be HH:mm (24 hours), e.g. 10:00`);
    out[k] = v;
  }
  if (!current || has('breakMinutes')) {
    const n = body.breakMinutes === '' || body.breakMinutes == null ? 0 : Number(body.breakMinutes);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, 'Break must be 0 or more minutes');
    out.breakMinutes = Math.round(n);
  }
  if (has('color')) {
    if (!COLOR_RE.test(String(body.color || ''))) throw httpError(400, 'Colour must look like #FFD60A');
    out.color = String(body.color).toUpperCase();
  }
  if (has('sortOrder')) {
    const n = Number(body.sortOrder);
    if (!Number.isFinite(n)) throw httpError(400, 'Order must be a number');
    out.sortOrder = Math.round(n);
  }

  const start = out.start ?? current?.start;
  const end = out.end ?? current?.end;
  const brk = out.breakMinutes ?? current?.breakMinutes ?? 0;
  if (start === end) throw httpError(400, 'Start and end time cannot be the same');
  const span = Shift.spanMinutes(start, end);
  if (brk >= span) throw httpError(400, `Break (${brk} min) must be shorter than the shift (${span} min)`);
  return out;
}

module.exports = {
  /** GET /shifts?active=true — active first, then sortOrder, name. */
  async list(req, res) {
    const filter = {};
    if (req.query.active === 'true') filter.isActive = true;
    const rows = await Shift.find(filter).sort({ isActive: -1, sortOrder: 1, name: 1 }).lean();
    const use = await usage(rows.map((r) => r._id));
    const data = rows.map((r) => ({ ...roster.shiftOut(r), ...use(r._id) }));
    ok(res, data, 200, { page: 1, limit: data.length, total: data.length, pages: data.length ? 1 : 0 });
  },

  async get(req, res) {
    const s = await load(req.params.id);
    const use = await usage([s._id]);
    ok(res, { ...roster.shiftOut(s), ...use(s._id) });
  },

  async create(req, res) {
    const fields = await readBody(req.body || {});
    if (fields.sortOrder === undefined) {
      const last = await Shift.findOne({}).sort({ sortOrder: -1 }).select('sortOrder').lean();
      fields.sortOrder = (last ? Number(last.sortOrder) || 0 : 0) + 1;
    }
    const s = await Shift.create({ ...fields, isActive: true, createdBy: req.access.userId });
    ok(res, { ...roster.shiftOut(s), defaultFor: 0, upcomingDays: 0 }, 201);
  },

  /** PUT /shifts/:id — new times also re-check this month's attendance on this shift. */
  async update(req, res) {
    const s = await load(req.params.id);
    const fields = await readBody(req.body || {}, s);
    const timesChanged = ['start', 'end', 'breakMinutes'].some((k) => fields[k] !== undefined && fields[k] !== s[k]);
    s.set(fields);
    await s.save();
    const recomputed = timesChanged ? await roster.recomputeShift(s._id) : 0;
    const use = await usage([s._id]);
    ok(res, { ...roster.shiftOut(s), ...use(s._id), recomputed });
  },

  /** POST /shifts/:id/activate | /deactivate. Switched-off shifts leave the pickers only. */
  setActive(isActive) {
    return async (req, res) => {
      const s = await load(req.params.id);
      s.isActive = isActive;
      await s.save();
      const use = await usage([s._id]);
      ok(res, { ...roster.shiftOut(s), ...use(s._id) });
    };
  },

  async remove(req, res) {
    const s = await load(req.params.id);
    const { defaultFor, upcomingDays } = (await usage([s._id]))(s._id);
    if (defaultFor || upcomingDays) {
      const why = [defaultFor ? `${defaultFor} employee${defaultFor === 1 ? '' : 's'} work it by default` : '', upcomingDays ? `${upcomingDays} roster day${upcomingDays === 1 ? ' uses' : 's use'} it from today on` : '']
        .filter(Boolean)
        .join(' and ');
      throw httpError(409, `"${s.name}" is still in use: ${why}. Switch it off instead, or move them to another shift first.`, 'SHIFT_IN_USE');
    }
    await s.softDelete(req.access.userId);
    ok(res, { _id: String(s._id), deleted: true });
  },
};
