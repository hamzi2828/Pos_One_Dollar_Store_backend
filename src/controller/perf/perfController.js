// POS speed reports: the counters send what they measured (POST /api/perf),
// the owner reads a summary (GET /api/perf/summary) to see WHERE time goes:
// server time vs network time, per counter PC, timeouts and fallbacks.
const PerfLog = require('../../models/perfLog');

const KINDS = new Set(['page_load', 'ping', 'scan', 'scan_fallback', 'search', 'catalog', 'api_error']);
const MAX_EVENTS = 100;

const num = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : null);
const str = (v, max = 200) => (v == null ? '' : String(v).slice(0, max));

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || '';
}

function cleanDetail(d) {
  if (!d || typeof d !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(d).slice(0, 20)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[str(k, 40)] = v;
    else if (v != null) out[str(k, 40)] = str(v, 200);
  }
  return out;
}

async function report(req, res) {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_EVENTS) : [];
  const device = str(req.body?.device, 80);
  const page = str(req.body?.page, 120);
  const ip = clientIp(req);
  const ua = str(req.headers['user-agent'], 200);
  const userId = str(req.user?.id || req.user?._id, 40);
  const userName = str(req.user?.name || req.user?.email, 80);
  const now = Date.now();

  const docs = events
    .filter((e) => e && KINDS.has(e.kind))
    .map((e) => {
      const at = Number(e.at);
      return {
        at: Number.isFinite(at) && at > now - 7 * 864e5 && at <= now + 60e3 ? new Date(at) : new Date(),
        kind: e.kind,
        ms: num(e.ms),
        serverMs: num(e.serverMs),
        ok: e.ok !== false,
        outcome: str(e.outcome, 40),
        path: str(e.path, 160),
        detail: cleanDetail(e.detail),
        device,
        page,
        userId,
        userName,
        ip,
        ua,
      };
    });
  if (docs.length) await PerfLog.insertMany(docs, { ordered: false });
  res.json({ success: true, saved: docs.length });
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function stats(rows) {
  const ms = rows.map((r) => r.ms).filter((v) => v != null).sort((a, b) => a - b);
  const server = rows.map((r) => r.serverMs).filter((v) => v != null).sort((a, b) => a - b);
  const failed = rows.filter((r) => !r.ok).length;
  const outcomes = {};
  rows.forEach((r) => {
    const k = r.outcome || (r.ok ? 'ok' : 'failed');
    outcomes[k] = (outcomes[k] || 0) + 1;
  });
  return {
    count: rows.length,
    failed,
    failedPct: rows.length ? Math.round((failed / rows.length) * 1000) / 10 : 0,
    p50: pct(ms, 50),
    p90: pct(ms, 90),
    p99: pct(ms, 99),
    max: ms.length ? ms[ms.length - 1] : null,
    serverP50: pct(server, 50),
    serverP90: pct(server, 90),
    outcomes,
  };
}

async function summary(req, res) {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const since = new Date(Date.now() - hours * 3600e3);
  const filter = { at: { $gte: since } };
  if (req.query.device) filter.device = String(req.query.device);
  const rows = await PerfLog.find(filter, { ua: 0 }).sort({ at: -1 }).limit(50000).lean();

  const byKind = {};
  const byDevice = {};
  const byHour = {};
  for (const r of rows) {
    (byKind[r.kind] = byKind[r.kind] || []).push(r);
    const d = r.device || r.ip || 'unknown';
    const dev = (byDevice[d] = byDevice[d] || { rows: [], kinds: {} });
    dev.rows.push(r);
    (dev.kinds[r.kind] = dev.kinds[r.kind] || []).push(r);
    if (r.kind === 'ping' || r.kind === 'scan') {
      const h = new Date(r.at);
      h.setMinutes(0, 0, 0);
      const key = `${h.toISOString()}|${r.kind}`;
      (byHour[key] = byHour[key] || []).push(r);
    }
  }

  const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, stats(v)]));
  const devices = Object.entries(byDevice).map(([device, d]) => ({
    device,
    lastSeen: d.rows[0]?.at || null,
    ip: d.rows[0]?.ip || '',
    user: d.rows[0]?.userName || d.rows[0]?.userId || '',
    kinds: Object.fromEntries(Object.entries(d.kinds).map(([k, v]) => [k, stats(v)])),
  }));
  const hourly = Object.entries(byHour)
    .map(([key, v]) => {
      const [hour, kind] = key.split('|');
      const s = stats(v);
      return { hour, kind, count: s.count, p50: s.p50, p90: s.p90, failedPct: s.failedPct };
    })
    .sort((a, b) => (a.hour < b.hour ? -1 : 1));
  const slowest = rows
    .filter((r) => r.kind !== 'page_load' && (r.ms != null || !r.ok))
    .sort((a, b) => (b.ms || 0) - (a.ms || 0))
    .slice(0, 40)
    .map(({ _id, ...r }) => r);
  const pageLoads = (byKind.page_load || []).slice(0, 20).map(({ _id, ...r }) => r);

  res.json({ success: true, hours, since, total: rows.length, kinds, devices, hourly, slowest, pageLoads });
}

async function recent(req, res) {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const filter = {};
  if (req.query.kind) filter.kind = String(req.query.kind);
  if (req.query.device) filter.device = String(req.query.device);
  if (req.query.failed === '1') filter.ok = false;
  const rows = await PerfLog.find(filter, { _id: 0 }).sort({ at: -1 }).limit(limit).lean();
  res.json({ success: true, data: rows });
}

module.exports = { report, summary, recent };
