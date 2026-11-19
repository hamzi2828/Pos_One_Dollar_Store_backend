// Request timing: how long the SERVER spends on each request.
// - Adds "Server-Timing: app;dur=<ms>" so the POS (browser) can tell server time
//   from network time (total time seen by the counter - app time = network).
// - Logs every request slower than SLOW_REQUEST_MS (default 800 ms):
//     ⏱ SLOW 1234ms GET /api/pos/products/barcode/10245 200 user=<id>
//   and requests the counter gave up on (connection closed before the answer).
//   Set LOG_ALL_REQUESTS=1 to log every request with its time.
// Never blocks or breaks a request.
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 800;
const LOG_ALL = process.env.LOG_ALL_REQUESTS === '1';

module.exports = function requestTiming(req, res, next) {
  const start = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;

  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    try {
      if (!res.headersSent) {
        res.setHeader('Server-Timing', `app;dur=${elapsed().toFixed(1)}`);
        res.setHeader('Timing-Allow-Origin', '*');
      }
    } catch {
      /* headers already gone */
    }
    return writeHead.apply(this, args);
  };

  res.on('finish', () => {
    const ms = Math.round(elapsed());
    if (ms < SLOW_MS && !LOG_ALL) return;
    const user = (req.user && (req.user.id || req.user._id)) || 'guest';
    console.log(`⏱ ${ms >= SLOW_MS ? 'SLOW ' : ''}${ms}ms ${req.method} ${req.originalUrl} ${res.statusCode} user=${user}`);
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`⏱ ABORTED after ${Math.round(elapsed())}ms ${req.method} ${req.originalUrl} (client closed the connection)`);
    }
  });
  next();
};
