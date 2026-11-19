// POS speed logs (/api/perf). OWNER: system. Counters report what they measure;
// the super admin reads the summary (admin page /admin/performance).
const express = require('express');
const { staff, superAdmin, handle } = require('./_access');
const perf = require('../../controller/perf/perfController');

const router = express.Router();

// Any logged-in staff (every POS counter) may send its own measurements.
router.post('/perf', ...staff, handle(perf.report));
router.get('/perf/summary', ...staff, superAdmin, handle(perf.summary));
router.get('/perf/recent', ...staff, superAdmin, handle(perf.recent));

module.exports = router;
