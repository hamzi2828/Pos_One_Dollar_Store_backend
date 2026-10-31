// Desktop attendance app (pos_desktop): fingerprint templates, fingerprint punches,
// a light "who's in today" board for the counter PC (/api/desktop/...).
// OWNER: Desktop attendance module. Attendance is marked ONLY by fingerprint on
// this app; a forgotten punch is a manager correction under HR -> Attendance.
// Mounted at /api by routes/modules/index.js — define sub-paths relative to /api.
//
// Permissions: attendance_kiosk (view = employees, templates, board; create = punch);
// desktop_pos view = the Sales button (session.features.sales) — sales use /api/pos/offline/*;
// desktop_enroll create = enrol / remove fingers; desktop_settings view = the Settings button
// (both super admin only by default, owner 2026-10-31).
// POST /desktop/pos-link + /public/desktop/pos-link: the Sales button signs the POS window in as the same person.
const express = require('express');
const { staff, can, handle } = require('./_access');
const ctrl = require('../../controller/store/desktopController');

const router = express.Router();

// A few tries a minute per address is plenty for a real counter.
const posLinkLimit = (() => {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'x';
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60000);
    list.push(now);
    hits.set(key, list);
    if (list.length > 20) return res.status(429).json({ success: false, message: 'Too many tries. Wait a minute.' });
    next();
  };
})();

const ENROL = can('desktop_enroll', 'create');

// ---- Session (who is signed in on the desk, and keeping it signed in) ----
router.get('/desktop/session', ...staff, handle(ctrl.session));
// Either desktop permission keeps the desk signed in (attendance and/or Sales).
router.post('/desktop/session/renew', ...staff, can(['attendance_kiosk', 'desktop_pos'], 'view'), handle(ctrl.renew));

// ---- Sales button: one-time sign-in for the POS window (2 min, once) ----
router.post('/desktop/pos-link', ...staff, can('desktop_pos', 'view'), handle(ctrl.posLink));
router.post('/public/desktop/pos-link', posLinkLimit, handle(ctrl.redeemPosLink));

// ---- People and fingerprints ----
// Names / photos / fingers on file / in-out state. Readable by the desk and by
// whoever manages employees or attendance (the enrolment window).
router.get('/desktop/employees', ...staff, can(['attendance_kiosk', 'attendance', 'employees'], 'view'), handle(ctrl.employees));
router.get('/desktop/fingerprints', ...staff, can('attendance_kiosk', 'view'), handle(ctrl.fingerprints));
router.post('/desktop/fingerprints/:employeeId', ...staff, ENROL, handle(ctrl.enroll));
router.delete('/desktop/fingerprints/:employeeId/:finger', ...staff, ENROL, handle(ctrl.removeFinger));

// ---- Punch and board ----
router.post('/desktop/punch', ...staff, can('attendance_kiosk', 'create'), handle(ctrl.punch));
router.get('/desktop/board', ...staff, can('attendance_kiosk', 'view'), handle(ctrl.board));

module.exports = router;
