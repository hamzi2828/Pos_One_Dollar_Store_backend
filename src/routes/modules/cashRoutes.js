// Sale counters, till sessions, cash closing, notifications, WhatsApp (/api/counters, /api/till-sessions, /api/notifications, /api/whatsapp). OWNER: Cash & Notifications module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
//
// Till permissions: `till` view = see my till, create = open, edit = close (blind).
// `till_verify` view = expected vs counted + bills, edit = verify / dispute /
// close someone else's till. Cashiers never receive expected cash or sales.
const express = require('express');
const { staff, can, handle } = require('./_access');
const counters = require('../../controller/store/counterController');
const till = require('../../controller/store/tillController');
const notifications = require('../../controller/store/notificationController');
const wa = require('../../controller/store/whatsappController');

const router = express.Router();

// Cron gate for GET /api/counters/check-cutoffs. Vercel Cron sends
// "Authorization: Bearer $CRON_SECRET". When CRON_SECRET is not set, calls
// without a token are allowed (dedupe keys make repeats harmless). Anything
// else must be a staff login with sale_counters view ("Check now" button).
function cronOrStaff(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  if ((secret && header === `Bearer ${secret}`) || (!secret && !header)) return next();
  const chain = [...staff, can('sale_counters', 'view')];
  let i = 0;
  const step = (err) => {
    if (err) return next(err);
    const mw = chain[i++];
    if (!mw) return next();
    return mw(req, res, step);
  };
  return step();
}

// ---- Sale counters ----
// /morning and /night are the two daily Vercel cron entries (same job).
router.get(['/counters/check-cutoffs', '/counters/check-cutoffs/:slot'], cronOrStaff, handle(counters.runCutoffs));
router.get('/counters/staff-options', ...staff, can('sale_counters', 'view'), handle(counters.staffOptions));
router.get('/counters', ...staff, can(['sale_counters', 'till_verify', 'report_cash_closing'], 'view'), handle(counters.list));
router.post('/counters', ...staff, can('sale_counters', 'create'), handle(counters.create));
router.put('/counters/:id', ...staff, can('sale_counters', 'edit'), handle(counters.update));
router.delete('/counters/:id', ...staff, can('sale_counters', 'delete'), handle(counters.remove));

// ---- Till sessions (cashier side) ----
router.get('/till-sessions/my', ...staff, can(['till', 'pos'], 'view'), handle(till.my));
router.get('/till-sessions/my/history', ...staff, can('till', 'view'), handle(till.myHistory));
router.post('/till-sessions/open', ...staff, can('till', 'create'), handle(till.open));
router.post('/till-sessions/:id/close', ...staff, can(['till', 'till_verify'], 'edit'), handle(till.close));

// ---- Cash closing report ----
router.get('/till-sessions/report/export', ...staff, can('report_cash_closing', 'export'), handle(till.exportCsv));
router.get('/till-sessions/report', ...staff, can('report_cash_closing', 'view'), handle(till.report));

// ---- Till sessions (admin side) ----
router.get('/till-sessions', ...staff, can('till_verify', 'view'), handle(till.list));
router.get('/till-sessions/:id', ...staff, can(['till', 'till_verify'], 'view'), handle(till.detail));
router.post('/till-sessions/:id/verify', ...staff, can('till_verify', 'edit'), handle(till.verify));
router.post('/till-sessions/:id/dispute', ...staff, can('till_verify', 'edit'), handle(till.dispute));

// ---- Notifications (every staff login: header bell) ----
router.get('/notifications/unread-count', ...staff, handle(notifications.unreadCount));
router.get('/notifications', ...staff, handle(notifications.list));
router.post('/notifications/read-all', ...staff, handle(notifications.markAllRead));
router.post('/notifications/:id/read', ...staff, handle(notifications.markRead));

// ---- WhatsApp group slips ----
router.get('/whatsapp/settings', ...staff, can('whatsapp', 'view'), handle(wa.getSettings));
router.put('/whatsapp/settings', ...staff, can('whatsapp', 'edit'), handle(wa.saveSettings));
router.post('/whatsapp/test', ...staff, can('whatsapp', 'edit'), handle(wa.sendTest));
router.get('/whatsapp/outbox', ...staff, can('whatsapp', 'view'), handle(wa.outbox));
router.post('/whatsapp/outbox/retry-failed', ...staff, can('whatsapp', 'edit'), handle(wa.retryFailed));
router.post('/whatsapp/outbox/:id/retry', ...staff, can('whatsapp', 'edit'), handle(wa.retryOne));
router.post('/whatsapp/orders/:id/resend', ...staff, can(['whatsapp', 'pos_orders'], 'edit'), handle(wa.resendOrder));

module.exports = router;
