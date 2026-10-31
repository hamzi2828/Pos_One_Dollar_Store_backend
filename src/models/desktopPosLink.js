// One-time sign-in link for the desktop app's Sales button: the counter PC asks
// for a code, opens the POS website with it, and the website swaps it for the
// same sign-in as POST /user/login (so the POS shows that person's permissions).
// Only a hash of the code is stored; it works once, within 2 minutes.
const mongoose = require('mongoose');

const desktopPosLinkSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Mongo removes old links by itself (a day after they expire).
desktopPosLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.models.DesktopPosLink || mongoose.model('DesktopPosLink', desktopPosLinkSchema);
