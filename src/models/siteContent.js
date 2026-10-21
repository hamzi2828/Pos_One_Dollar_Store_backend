// src/models/siteContent.js
// Content of the public marketing website (dollar_website), edited in the
// POS admin under System Settings -> Website. ONE document (key 'main').
// `content` holds the sections exactly as in docs/WEBSITE_CMS.md §1; the
// service (services/websiteService.js) validates it and fills gaps from
// constants/websiteDefaults.js, so new fields never need a migration.
const mongoose = require('mongoose');

const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'main', trim: true },
    content: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '', trim: true },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.models.SiteContent || mongoose.model('SiteContent', siteContentSchema);
