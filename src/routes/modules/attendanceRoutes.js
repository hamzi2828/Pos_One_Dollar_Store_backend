// Attendance: day board, saved days, corrections, overtime approval, monthly sheet, exceptions (/api/attendance/...). OWNER: Attendance module.
// Mounted at /api by routes/modules/index.js — define sub-paths relative to /api.
//
// Staff punch ONLY with their fingerprint on the desktop app (/api/desktop/*,
// punches arrive with source 'device'). The web side shows and corrects:
// attendance view = board / sheet / exceptions, edit = corrections (reason
// required) and overtime approval, export = CSV.
const express = require('express');
const { staff, can, handle } = require('./_access');
const ctrl = require('../../controller/store/attendanceController');

const router = express.Router();

// ---- Board, saved days, one day ----
router.get('/attendance/board', ...staff, can('attendance', 'view'), handle(ctrl.board));
router.get('/attendance/records', ...staff, can('attendance', 'view'), handle(ctrl.records));
router.get('/attendance/day', ...staff, can('attendance', 'view'), handle(ctrl.day));

// ---- Corrections (the only non-biometric change) + overtime ----
router.put('/attendance/day', ...staff, can('attendance', 'edit'), handle(ctrl.correct));
router.post('/attendance/overtime', ...staff, can('attendance', 'edit'), handle(ctrl.overtime));

// ---- Month sheet + CSV, fix before payroll ----
router.get('/attendance/sheet', ...staff, can('attendance', 'view'), handle(ctrl.sheet));
router.get('/attendance/sheet/export', ...staff, can('attendance', 'export'), handle(ctrl.sheetExport));
router.get('/attendance/exceptions', ...staff, can('attendance', 'view'), handle(ctrl.exceptions));

module.exports = router;
