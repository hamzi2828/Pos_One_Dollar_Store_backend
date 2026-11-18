// src/services/partnerDrawExpenseLink.js
// Expenses with the category "Profit Distribution": a partner (Hamza, Adil…) takes
// money out of the shop (owner 2026-11-17).
//   - The partner is picked on Add expense (expense.partner).
//   - The cash comes off the till / bank like any expense.
//   - It is NOT a cost of the business: the Income Statement and the Expenses
//     report leave it out. It lowers that partner's balance in the company
//     (Financial Statements → Partners) and the owners' equity.

const mongoose = require('mongoose');
const Partner = require('../models/investmentPartner');
const ExpenseCategory = require('../models/expenseCategory');

const CATEGORY = 'Profit Distribution';
const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => /^[a-f\d]{24}$/i.test(String(v || ''));

function isPartnerDraw(categories) {
  const list = Array.isArray(categories) ? categories : String(categories || '').split(',');
  return list.some((c) => String(c).trim().toLowerCase() === CATEGORY.toLowerCase());
}

async function partnerOptions() {
  const rows = await Partner.find({ isDeleted: { $ne: true } }).sort({ name: 1 }).select('name sharePercent').lean();
  return rows.map((p) => ({ _id: String(p._id), name: p.name, sharePercent: Number(p.sharePercent) || 0 }));
}

async function checkPartner(partnerId) {
  if (!isId(partnerId)) throw httpError(400, 'Pick which partner took the money');
  const p = await Partner.findOne({ _id: new mongoose.Types.ObjectId(String(partnerId)), isDeleted: { $ne: true } }).select('name').lean();
  if (!p) throw httpError(404, 'Partner not found');
  return p;
}

let ensured = false;
async function ensureCategory() {
  if (ensured) return;
  const rx = new RegExp(`^${CATEGORY}$`, 'i');
  const live = await ExpenseCategory.findOne({ name: rx, isDeleted: { $ne: true } }).lean();
  if (!live) {
    const old = await ExpenseCategory.findOne({ name: rx });
    if (old) {
      old.isDeleted = false;
      old.isActive = true;
      old.deletedAt = null;
      old.deletedBy = null;
      await old.save();
    } else {
      try {
        await ExpenseCategory.create({ name: CATEGORY, description: 'Money a partner takes out of the shop (not a shop expense)' });
      } catch (e) {
        if (e && e.code !== 11000) throw e;
      }
    }
  } else if (live.isActive === false) {
    await ExpenseCategory.updateOne({ _id: live._id }, { $set: { isActive: true } });
  }
  ensured = true;
}

module.exports = { CATEGORY, isPartnerDraw, partnerOptions, checkPartner, ensureCategory };
