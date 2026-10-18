// Shifts, holidays, roster, HR policies, employee time & pay settings (/api/shifts, /api/holidays, /api/roster, /api/hr-policies, /api/hr/employees/:id/time-settings). OWNER: Shifts & Roster module.
// Mounted at /api by routes/modules/index.js — define sub-paths relative to /api.
//
// Shift and holiday LISTS are also readable by attendance (and payroll for
// holidays): those screens show shift names and holiday days.
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access'); // eslint-disable-line no-unused-vars
const shifts = require('../../controller/store/shiftController');
const holidays = require('../../controller/store/holidayController');
const roster = require('../../controller/store/rosterController');
const policies = require('../../controller/store/hrPolicyController');
const timeSettings = require('../../controller/store/timeSettingsController');

const router = express.Router();

// ----- Shifts -----
router.get('/shifts', ...staff, can(['shifts', 'attendance'], 'view'), handle(shifts.list));
router.post('/shifts', ...staff, can('shifts', 'create'), handle(shifts.create));
router.get('/shifts/:id', ...staff, can('shifts', 'view'), handle(shifts.get));
router.put('/shifts/:id', ...staff, can('shifts', 'edit'), handle(shifts.update));
router.post('/shifts/:id/activate', ...staff, can('shifts', 'edit'), handle(shifts.setActive(true)));
router.post('/shifts/:id/deactivate', ...staff, can('shifts', 'edit'), handle(shifts.setActive(false)));
router.delete('/shifts/:id', ...staff, can('shifts', 'delete'), handle(shifts.remove));

// ----- Holidays -----
router.get('/holidays', ...staff, can(['shifts', 'attendance', 'payroll'], 'view'), handle(holidays.list));
router.post('/holidays', ...staff, can('shifts', 'create'), handle(holidays.create));
router.post('/holidays/pakistan', ...staff, can('shifts', 'create'), handle(holidays.addPakistan));
router.put('/holidays/:id', ...staff, can('shifts', 'edit'), handle(holidays.update));
router.delete('/holidays/:id', ...staff, can('shifts', 'delete'), handle(holidays.remove));

// ----- Roster -----
router.get('/roster', ...staff, can('shifts', 'view'), handle(roster.grid));
router.put('/roster/cells', ...staff, can('shifts', 'edit'), handle(roster.saveCells));
router.post('/roster/copy-week', ...staff, can('shifts', 'edit'), handle(roster.copyWeek));

// ----- HR policies -----
router.get('/hr-policies', ...staff, can('hr_policies', 'view'), handle(policies.list));
router.get('/hr-policies/employees', ...staff, can('hr_policies', 'view'), handle(policies.employees));
router.post('/hr-policies', ...staff, can('hr_policies', 'create'), handle(policies.create));
router.get('/hr-policies/:id', ...staff, can('hr_policies', 'view'), handle(policies.get));
router.put('/hr-policies/:id', ...staff, can('hr_policies', 'edit'), handle(policies.update));
router.post('/hr-policies/:id/duplicate', ...staff, can('hr_policies', 'create'), handle(policies.duplicate));
router.post('/hr-policies/:id/default', ...staff, can('hr_policies', 'edit'), handle(policies.setDefault));
router.post('/hr-policies/:id/assign', ...staff, can('hr_policies', 'edit'), handle(policies.assign)); // :id "default" = back to the default
router.delete('/hr-policies/:id', ...staff, can('hr_policies', 'delete'), handle(policies.remove));

// ----- Employee time & pay settings (+ read-only fingerprint status from the desktop app) -----
router.get('/hr/employees/:id/time-settings', ...staff, can('employees', 'view'), handle(timeSettings.get));
router.put('/hr/employees/:id/time-settings', ...staff, can('employees', 'edit'), handle(timeSettings.update));

module.exports = router;
