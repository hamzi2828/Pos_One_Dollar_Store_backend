// Paying what is left on an investment bill from the shop's money, as an
// expense (owner, 2026-11-04). The expense points at the bill
// (expense.investment); the bill lists those expenses (investment.expenseLinks)
// and counts them in `expensePaid`. They lower the bill's balance but are NOT
// partner money, so they never add to "invested" (paidAmount).

const mongoose = require('mongoose');
const Investment = require('../models/investment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const err = (status, message) => Object.assign(new Error(message), { status });
const rs = (n) => `Rs ${round2(n).toLocaleString('en-PK')}`;

/** Bills with something left to pay (for the expense form). */
async function openBills() {
  const rows = await Investment.find({ balance: { $gt: 0 } })
    .sort({ date: -1 })
    .populate({ path: 'partner', select: 'name', options: { withDeleted: true } })
    .select('title amount paidAmount expensePaid balance date paidTo billNo partner')
    .lean();
  return rows.map((r) => ({
    _id: String(r._id),
    title: r.title,
    partner: r.partner ? r.partner.name : '',
    paidTo: r.paidTo || '',
    billNo: r.billNo || '',
    amount: round2(r.amount),
    paid: round2((r.paidAmount || 0) + (r.expensePaid || 0)),
    balance: round2(r.balance),
    date: r.date,
  }));
}

/** expensePaid and balance worked out again from the bill's links. */
async function recalc(investmentId) {
  const bill = await Investment.findById(investmentId).lean();
  if (!bill) return;
  const expensePaid = round2((bill.expenseLinks || []).reduce((t, l) => t + (Number(l.amount) || 0), 0));
  const balance = round2((Number(bill.amount) || 0) - (Number(bill.paidAmount) || 0) - expensePaid);
  await Investment.updateOne({ _id: bill._id }, { $set: { expensePaid, balance } });
}

/**
 * Check that `amount` can go against the bill (counting what this expense
 * already put on it), before the expense is saved. -> { _id, title } or null.
 */
async function checkLink(investmentId, amount, expenseId = null) {
  if (!investmentId || investmentId === 'null' || investmentId === '') return null;
  if (!mongoose.isValidObjectId(String(investmentId))) throw err(400, 'Choose a valid investment bill');
  const bill = await Investment.findById(investmentId).lean();
  if (!bill) throw err(404, 'Investment bill not found');
  const mine = expenseId ? (bill.expenseLinks || []).filter((l) => String(l.expense) === String(expenseId)).reduce((t, l) => t + (l.amount || 0), 0) : 0;
  const room = round2((bill.balance || 0) + mine);
  if (round2(amount) > room) throw err(400, `Only ${rs(room)} is left to pay on "${bill.title}"`);
  return { _id: bill._id, title: bill.title };
}

/** Put the expense on its bill (and off any other bill). Call after the expense is saved. */
async function sync(expense) {
  const id = expense._id;
  const before = await Investment.find({ 'expenseLinks.expense': id }).select('_id').lean();
  if (before.length) await Investment.updateMany({ 'expenseLinks.expense': id }, { $pull: { expenseLinks: { expense: id } } });
  const live = expense.investment && !expense.isDeleted;
  if (live) {
    await Investment.updateOne(
      { _id: expense.investment },
      { $push: { expenseLinks: { expense: id, amount: round2(expense.amount), date: expense.date || new Date(), title: expense.title || '' } } }
    );
  }
  const ids = new Set(before.map((b) => String(b._id)));
  if (live) ids.add(String(expense.investment));
  for (const x of ids) await recalc(x);
}

module.exports = { openBills, checkLink, sync, recalc };
