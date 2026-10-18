// Store-operations modules. Each module owns ONE route file here (no module
// edits another module's file). Mounted from routes/allRoutes.js.
//
// A module that fails to load is logged and skipped, so one broken module
// cannot take the whole POS down. Set STRICT_MODULES=1 to fail hard instead
// (used by the test suite / CI).
const express = require('express');

const router = express.Router();

const MODULES = [
  'racksRoutes',
  'purchasingRoutes',
  'vendorsRoutes',
  'salesRoutes',
  'cashRoutes',
  'analyticsRoutes',
  'stockOpsRoutes',
  'hrRoutes',
];

for (const name of MODULES) {
  try {
    router.use('/api', require(`./${name}`));
  } catch (err) {
    if (process.env.STRICT_MODULES === '1') throw err;
    console.error(`[modules] ${name} failed to load and is disabled:`, err);
  }
}

module.exports = router;
