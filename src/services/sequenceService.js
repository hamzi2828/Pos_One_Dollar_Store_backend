// src/services/sequenceService.js
// Human document numbers, safe when two requests create documents at once
// (atomic $inc on a counter row, no countDocuments race).
//
//   const { nextNumber } = require('../services/sequenceService');
//   const poNumber = await nextNumber('PO');        // "PO-2026-00001"
//   const grn = await nextNumber('GRN');            // "GRN-2026-00001"
//
// Prefixes in use: PO, GRN, VP (vendor payment), VR (vendor return),
// CN (consignment), CS (consignment settlement), DMG (damage), SU (shop use),
// ADJ (stock adjustment), TILL (till session), EMP (employee code), AST (asset code).
// The counter restarts every year.
const mongoose = require('mongoose');

const sequenceSchema = new mongoose.Schema(
  {
    _id: { type: String }, // "<PREFIX>-<YEAR>"
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

const Sequence = mongoose.models.Sequence || mongoose.model('Sequence', sequenceSchema);

async function nextNumber(prefix, { pad = 5, date = new Date(), yearly = true } = {}) {
  const p = String(prefix || 'DOC').toUpperCase();
  const key = yearly ? `${p}-${date.getFullYear()}` : p;
  const row = await Sequence.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, upsert: true }).lean();
  return `${key}-${String(row.seq).padStart(pad, '0')}`;
}

module.exports = { nextNumber, Sequence };
