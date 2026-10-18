// src/models/appConfig.js
// Small key -> value settings store for the store-operations modules, so each
// module keeps its own settings without editing the big Settings model.
// Keys are namespaced: "<module>.<name>", e.g. "demand.thresholdPct",
// "whatsapp", "till.requireOpenSession". Use services/configService.js.
const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.models.AppConfig || mongoose.model('AppConfig', appConfigSchema);
