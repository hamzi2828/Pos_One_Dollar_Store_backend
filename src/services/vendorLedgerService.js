// src/services/vendorLedgerService.js
// The ONLY way to write the vendor account (models/vendorLedgerEntry.js).
//
//   credit = we owe the vendor more (bill, consignment settlement, opening balance)
//   debit  = we owe the vendor less (payment, debit note / return, discount)
//   payable balance = sum(credit) - sum(debit)   (> 0: we owe them, < 0: they owe us)
//
// Used by: purchase orders (bills), vendor payments, vendor returns,
// consignment settlements, opening balances. Rows are never edited or
// deleted — call voidEntry() and post a corrected row.
const mongoose = require('mongoose');
const VendorLedgerEntry = require('../models/vendorLedgerEntry');
const Vendor = require('../models/vendor');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const ledgerError = (message, status = 400, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  err.isLedgerError = true;
  Object.assign(err, extra);
  return err;
};

const toId = (v) => {
  if (!v) return null;
  const raw = typeof v === 'object' && v._id ? v._id : v;
  return mongoose.Types.ObjectId.isValid(String(raw)) ? new mongoose.Types.ObjectId(String(raw)) : null;
};

/**
 * Post one row. Exactly one of `credit` / `debit` must be > 0.
 * `unique: true` + refType/refId: if a live row with the same vendor, type,
 * refType and refId exists, that row is returned instead of a duplicate
 * (safe to call twice, e.g. when a request is retried).
 *
 * @returns the saved entry (plain object)
 */
async function post({
  vendorId,
  type,
  credit = 0,
  debit = 0,
  date,
  branchId = null,
  method = '',
  bankId = null,
  reference = '',
  attachments = [],
  refType = '',
  refId = null,
  refNo = '',
  description = '',
  userId = null,
  unique = false,
}) {
  const vendor = toId(vendorId);
  if (!vendor) throw ledgerError('A valid vendor is required');
  if (!VendorLedgerEntry.TYPES.includes(type)) throw ledgerError(`Unknown ledger entry type "${type}"`);
  const c = round2(credit);
  const d = round2(debit);
  if (c < 0 || d < 0) throw ledgerError('Amounts cannot be negative');
  if ((c > 0) === (d > 0)) throw ledgerError('Give either a credit or a debit amount greater than 0');

  const v = await Vendor.findById(vendor).select('name isDeleted').lean();
  if (!v) throw ledgerError('Vendor not found', 404);

  const ref = toId(refId);
  if (unique && refType && ref) {
    const existing = await VendorLedgerEntry.findOne({ vendor, type, refType, refId: ref, isVoided: false }).lean();
    if (existing) return existing;
  }

  const entry = await VendorLedgerEntry.create({
    vendor,
    vendorName: v.name || '',
    branch: toId(branchId),
    date: date ? new Date(date) : new Date(),
    type,
    credit: c,
    debit: d,
    method: method || '',
    bank: toId(bankId),
    reference: reference || '',
    attachments: Array.isArray(attachments) ? attachments.filter(Boolean) : [],
    refType: refType || '',
    refId: ref,
    refNo: refNo || '',
    description: description || '',
    createdBy: toId(userId),
  });
  return entry.toObject();
}

/** Void a row (kept for history, no longer counted). */
async function voidEntry(entryId, { userId = null, reason = '' } = {}) {
  const id = toId(entryId);
  if (!id) throw ledgerError('Invalid entry id');
  const entry = await VendorLedgerEntry.findOneAndUpdate(
    { _id: id, isVoided: false },
    { $set: { isVoided: true, voidedAt: new Date(), voidedBy: toId(userId), voidReason: reason || '' } },
    { new: true }
  ).lean();
  if (!entry) throw ledgerError('Entry not found or already voided', 404);
  return entry;
}

/** Void every live row of a source document (e.g. a cancelled purchase order). */
async function voidByRef(refType, refId, { userId = null, reason = '' } = {}) {
  const ref = toId(refId);
  if (!refType || !ref) return 0;
  const res = await VendorLedgerEntry.updateMany(
    { refType, refId: ref, isVoided: false },
    { $set: { isVoided: true, voidedAt: new Date(), voidedBy: toId(userId), voidReason: reason || '' } }
  );
  return res.modifiedCount || 0;
}

/** { credit, debit, balance } for one vendor (balance > 0 = we owe them). */
async function getBalance(vendorId, { asOf = null, branchId = null } = {}) {
  const vendor = toId(vendorId);
  if (!vendor) return { credit: 0, debit: 0, balance: 0 };
  const match = { vendor, isVoided: false };
  if (asOf) match.date = { $lte: new Date(asOf) };
  if (branchId) match.branch = toId(branchId);
  const [row] = await VendorLedgerEntry.aggregate([
    { $match: match },
    { $group: { _id: null, credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
  ]);
  const credit = round2(row ? row.credit : 0);
  const debit = round2(row ? row.debit : 0);
  return { credit, debit, balance: round2(credit - debit) };
}

/** Map vendorId(string) -> { credit, debit, balance } for many vendors (lists). */
async function getBalances(vendorIds = []) {
  const ids = vendorIds.map(toId).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await VendorLedgerEntry.aggregate([
    { $match: { vendor: { $in: ids }, isVoided: false } },
    { $group: { _id: '$vendor', credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
  ]);
  for (const id of ids) out.set(String(id), { credit: 0, debit: 0, balance: 0 });
  for (const r of rows) {
    const credit = round2(r.credit);
    const debit = round2(r.debit);
    out.set(String(r._id), { credit, debit, balance: round2(credit - debit) });
  }
  return out;
}

module.exports = { post, voidEntry, voidByRef, getBalance, getBalances, round2 };
