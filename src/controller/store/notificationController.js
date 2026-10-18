// src/controller/store/notificationController.js
// In-app notifications for the logged-in user (/api/notifications).
// Every staff login may read its own notifications (header bell); what each
// user sees is decided by notificationService.visibleFilter.
// OWNER: Cash & Notifications module.
const notificationService = require('../../services/notificationService');
const tillService = require('../../services/tillService');

const notificationController = {
  // GET /api/notifications?unread=1&level=&page=&limit=
  async list(req, res) {
    await tillService.maybeCheckCutoffs(); // lazy cut-off check (throttled, never throws)
    const { data, meta } = await notificationService.listForUser(req.access, {
      page: req.query.page,
      limit: req.query.limit,
      unread: req.query.unread === '1' || req.query.unread === 'true',
      level: req.query.level,
    });
    res.json({ success: true, data, meta });
  },

  // GET /api/notifications/unread-count
  async unreadCount(req, res) {
    await tillService.maybeCheckCutoffs();
    res.json({ success: true, data: { count: await notificationService.unreadCount(req.access) } });
  },

  // POST /api/notifications/:id/read
  async markRead(req, res) {
    const ok = await notificationService.markRead(req.access, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Notification not found' });
    return res.json({ success: true, data: { count: await notificationService.unreadCount(req.access) } });
  },

  // POST /api/notifications/read-all
  async markAllRead(req, res) {
    const updated = await notificationService.markAllRead(req.access);
    res.json({ success: true, data: { updated, count: 0 } });
  },
};

module.exports = notificationController;
