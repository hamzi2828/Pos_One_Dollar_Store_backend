// src/services/sales/discountRuleService.js
// CRUD + "test a bill amount" for bill discount rules (models/discountRule.js).
// The checkout maths lives in pricingService (applyRules) so the calculator
// here gives exactly the numbers the POS will give.
//
// Every rule is for the shop; users with the `discounts` permission manage them.
const mongoose = require('mongoose');
const DiscountRule = require('../../models/discountRule');
const { round2, httpError, ruleLabel, applyRules, nextThreshold, loadActiveRules } = require('./pricingService');

const isOid = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toDate = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date`, 'INVALID_DATE');
  return d;
};
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Rule state right now: running | scheduled | ended | off. */
function ruleStatus(rule, at = new Date()) {
  if (!rule.isActive) return 'off';
  if (rule.startsAt && new Date(rule.startsAt) > at) return 'scheduled';
  if (rule.endsAt && new Date(rule.endsAt) < at) return 'ended';
  return 'running';
}

const decorate = (rule) => ({ ...rule, label: ruleLabel(rule), status: ruleStatus(rule) });

/** Full validated rule from body (merged over `existing` for updates). */
function readRuleInput(body = {}, existing = null) {
  const src = { ...(existing || {}), ...body };
  const name = String(src.name || '').trim();
  if (!name) throw httpError(400, 'Name is required', 'NAME_REQUIRED');
  const kind = src.kind === 'overall' ? 'overall' : src.kind === 'threshold' ? 'threshold' : null;
  if (!kind) throw httpError(400, 'Kind must be "overall" or "threshold"', 'INVALID_KIND');
  const valueType = src.valueType === 'fixed' ? 'fixed' : src.valueType === 'percentage' ? 'percentage' : null;
  if (!valueType) throw httpError(400, 'Type must be "percentage" or "fixed"', 'INVALID_TYPE');
  const value = Number(src.value);
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, 'Discount value must be more than 0', 'INVALID_VALUE');
  if (valueType === 'percentage' && value > 100) throw httpError(400, 'Percentage cannot be more than 100', 'INVALID_VALUE');

  let minSubtotal = 0;
  if (kind === 'threshold') {
    minSubtotal = Number(src.minSubtotal);
    if (!Number.isFinite(minSubtotal) || minSubtotal <= 0) {
      throw httpError(400, 'Cut-off amount is required (e.g. 5000 for "spend Rs 5,000")', 'MIN_SUBTOTAL_REQUIRED');
    }
    if (valueType === 'fixed' && value > minSubtotal) {
      throw httpError(400, 'A fixed discount cannot be bigger than the cut-off amount', 'INVALID_VALUE');
    }
  }
  let maxDiscount = src.maxDiscount === undefined || src.maxDiscount === null || src.maxDiscount === '' ? null : Number(src.maxDiscount);
  if (maxDiscount !== null && (!Number.isFinite(maxDiscount) || maxDiscount < 0)) throw httpError(400, 'Maximum discount must be 0 or more', 'INVALID_MAX');
  if (maxDiscount === 0) maxDiscount = null;

  const startsAt = toDate(src.startsAt, 'Start date');
  const endsAt = toDate(src.endsAt, 'End date');
  if (startsAt && endsAt && endsAt <= startsAt) throw httpError(400, 'End date must be after the start date', 'INVALID_DATES');

  return {
    name: name.slice(0, 120),
    kind,
    valueType,
    value: round2(value),
    minSubtotal: round2(minSubtotal),
    maxDiscount: maxDiscount === null ? null : round2(maxDiscount),
    startsAt,
    endsAt,
    priority: Math.round(Number(src.priority) || 0),
    stackable: toBool(src.stackable),
    isActive: src.isActive === undefined ? true : toBool(src.isActive),
    notes: String(src.notes || '').trim().slice(0, 1000),
  };
}

// ---------------------------------------------------------------- CRUD

async function list({ search = '', status = '', kind = '', page = 1, limit = 25 } = {}) {
  const and = [];
  if (search) and.push({ $or: [{ name: { $regex: escapeRegex(String(search).trim()), $options: 'i' } }, { notes: { $regex: escapeRegex(String(search).trim()), $options: 'i' } }] });
  if (kind === 'overall' || kind === 'threshold') and.push({ kind });
  const now = new Date();
  if (status === 'off') and.push({ isActive: false });
  if (status === 'running') and.push({ isActive: true }, { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] });
  if (status === 'scheduled') and.push({ isActive: true, startsAt: { $gt: now } });
  if (status === 'ended') and.push({ isActive: true, endsAt: { $lt: now } });
  const q = and.length ? { $and: and } : {};

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const [total, rules] = await Promise.all([
    DiscountRule.countDocuments(q),
    DiscountRule.find(q).sort({ isActive: -1, priority: -1, createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
  ]);
  return { data: rules.map(decorate), meta: { page: p, limit: l, total, pages: Math.max(1, Math.ceil(total / l)) } };
}

async function getOne(id) {
  if (!isOid(id)) throw httpError(404, 'Discount rule not found');
  const rule = await DiscountRule.findById(id).lean();
  if (!rule) throw httpError(404, 'Discount rule not found');
  return decorate(rule);
}

async function create(body, access) {
  const rule = await DiscountRule.create({ ...readRuleInput(body), createdBy: access.userId || null, updatedBy: access.userId || null });
  return getOne(rule._id);
}

async function update(id, body, access) {
  if (!isOid(id)) throw httpError(404, 'Discount rule not found');
  const existing = await DiscountRule.findById(id).lean();
  if (!existing) throw httpError(404, 'Discount rule not found');
  await DiscountRule.updateOne({ _id: existing._id }, { $set: { ...readRuleInput(body, existing), updatedBy: access.userId || null } });
  return getOne(existing._id);
}

async function setActive(id, isActive, access) {
  if (!isOid(id)) throw httpError(404, 'Discount rule not found');
  const existing = await DiscountRule.findById(id).lean();
  if (!existing) throw httpError(404, 'Discount rule not found');
  await DiscountRule.updateOne({ _id: existing._id }, { $set: { isActive: toBool(isActive), updatedBy: access.userId || null } });
  return getOne(existing._id);
}

async function remove(id, access) {
  if (!isOid(id)) throw httpError(404, 'Discount rule not found');
  const existing = await DiscountRule.findById(id).lean();
  if (!existing) throw httpError(404, 'Discount rule not found');
  await DiscountRule.softDeleteById(existing._id, access.userId || null);
  return { deleted: true };
}

/**
 * "Test a bill amount": which running rules a bill of `subtotal` gets
 * (same maths as the POS; manual discount and tax not included).
 */
async function preview({ subtotal, at = null } = {}) {
  const amount = round2(Number(subtotal));
  if (!Number.isFinite(amount) || amount < 0) throw httpError(400, 'Enter a bill amount', 'INVALID_AMOUNT');
  const when = at ? toDate(at, 'Date') : new Date();
  const rules = await loadActiveRules(when);
  const applied = applyRules(rules, amount);
  const discount = round2(applied.reduce((s, d) => s + d.amount, 0));
  return {
    subtotal: amount,
    applied,
    discount,
    total: round2(Math.max(0, amount - discount)),
    nextDiscount: nextThreshold(rules, amount, discount),
    runningRules: rules.length,
  };
}

module.exports = { list, getOne, create, update, setActive, remove, preview, readRuleInput, ruleStatus };
