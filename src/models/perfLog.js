// Speed reports sent by the POS screens (browser side), kept 30 days.
// kind:
//   page_load      POS page opened: dns / connect / tls / ttfb / load times
//   ping           GET /health from the counter every 2 min (network round trip)
//   scan           one barcode lookup attempt (ok, timeout, error)
//   scan_fallback  scan answered from the saved catalogue (server too slow)
//   search         product search box request
//   catalog        offline catalogue download (ms + bytes)
//   api_error      any other failed / timed-out call worth seeing
const mongoose = require('mongoose');

const perfLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    kind: { type: String, required: true },
    ms: { type: Number, default: null }, // total time seen by the counter
    serverMs: { type: Number, default: null }, // Server-Timing app;dur (server part)
    ok: { type: Boolean, default: true },
    outcome: { type: String, default: '' }, // ok | timeout | network | http_<status> | fallback
    path: { type: String, default: '' },
    detail: { type: mongoose.Schema.Types.Mixed, default: undefined },
    device: { type: String, default: '' }, // counter PC id (set on the POS page)
    page: { type: String, default: '' },
    userId: { type: String, default: '' },
    userName: { type: String, default: '' },
    ip: { type: String, default: '' },
    ua: { type: String, default: '' },
  },
  { versionKey: false }
);

perfLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
perfLogSchema.index({ kind: 1, at: -1 });
perfLogSchema.index({ device: 1, at: -1 });

module.exports = mongoose.models.PerfLog || mongoose.model('PerfLog', perfLogSchema);
