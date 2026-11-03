// src/controller/mailSettingsController.js
// Admin → Settings → Email: read / save SMTP settings and send a test email.

const mail = require('../services/mail/mailService');

const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Mail settings error:', err);
    return res.status(status).json({ success: false, message: err.message || 'Failed' });
  }
};

exports.get = wrap(() => mail.getSettings());
exports.save = wrap((req) => mail.saveSettings(req.body || {}, req.user && req.user._id));
exports.test = wrap((req) => mail.sendTest(req.body && req.body.to));
