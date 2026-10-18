// src/models/contractTemplate.js
// Employment contract letter templates. `body` is plain text with
// {{placeholders}} and light markup (# heading, ## sub-heading, - list, **bold**),
// rendered by services/hr/contractService.js. When there is no template the
// built-in one (services/hr/defaultContract.js) is used.
const mongoose = require('mongoose');

const contractTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 50000 },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

contractTemplateSchema.plugin(require('../helper/softDeletePlugin'));

contractTemplateSchema.index({ isDeleted: 1, isDefault: -1, name: 1 });

module.exports = mongoose.models.ContractTemplate || mongoose.model('ContractTemplate', contractTemplateSchema);
