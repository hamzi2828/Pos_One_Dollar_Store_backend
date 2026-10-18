// Desktop attendance app (pos_desktop): fingerprint templates, fingerprint punches,
// a light "who's in today" board for the counter PC (/api/desktop/...).
// OWNER: Desktop attendance module. Attendance is marked ONLY by fingerprint on
// this app; a forgotten punch is a manager correction under HR -> Attendance.
// Mounted at /api by routes/modules/index.js — define sub-paths relative to /api.
//
// Permissions: attendance_kiosk (view = employees, templates, board; create = punch);
// employees edit OR attendance edit = enrol / remove fingers.
const express = require('express');
const { staff, can, handle } = require('./_access');
const ctrl = require('../../controller/store/desktopController');

const router = express.Router();

const ENROL = can(['employees', 'attendance'], 'edit');

// ---- Session (who is signed in on the desk, and keeping it signed in) ----
router.get('/desktop/session', ...staff, handle(ctrl.session));
router.post('/desktop/session/renew', ...staff, can('attendance_kiosk', 'view'), handle(ctrl.renew));

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
