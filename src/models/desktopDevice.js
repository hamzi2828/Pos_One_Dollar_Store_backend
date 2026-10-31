// Counter PCs running the DollarCoPos desktop app: name, app version, who is
// signed in, last seen. Written when the app asks for its session (headers
// X-App-Version / X-Device-Name), shown on the website's Desktop app page.
const mongoose = require('mongoose');

const desktopDeviceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // lower-case PC name
    name: { type: String, default: '' },
    version: { type: String, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.DesktopDevice || mongoose.model('DesktopDevice', desktopDeviceSchema);
