// src/services/loanRepayExpenseLink.js
// Expenses with the category "Loan Repayment" pay back a loan (owner 2026-11-17).
//   - The loan is picked on Add expense; the amount can't go over what is left on it.
//   - The expense takes the cash off the till / bank like any expense, AND adds a
//     repayment on the loan (repayment.expense = this expense), so the loan's
//     balance goes down by itself.
//   - It is NOT a cost of the business: the Income Statement, the Expenses report
//     and "money left" count it once, as a loan paid back (never as an expense).
//   - Delete / adjust the expense -> its repayment is removed / changed too.

const mongoose = require('mongoose');
const Loan = require('../models/loan');
const ExpenseCategory = require('../models/expenseCategory');

const CATEGORY = 'Loan Repayment';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && /^[a-f\d]{24}$/i.test(String(v));
const METHOD = { Cash: 'Cash', 'Bank Transfer': 'Bank Transfer', JazzCash: 'JazzCash', Check: 'Cheque' };

/** "A, B" string or array -> true when one of them is Loan Repayment. */
function isLoanRepay(categories) {
  const list = Array.isArray(categories) ? categories : String(categories || '').split(',');
  return list.some((c) => String(c).trim().toLowerCase() === CATEGORY.toLowerCase());
}

function totals(loan) {
  loan.paid = round2((loan.repayments || []).reduce((t, r) => t + (Number(r.amount) || 0), 0));
  loan.left = round2(loan.amount - loan.paid);
  loan.status = loan.left <= 0.009 ? 'paid' : 'open';
}

/** Open loans for the picker (lender, number, what is left). */
async function openLoans() {
  const rows = await Loan.find({ isDeleted: { $ne: true }, status: 'open' }).sort({ date: 1 }).select('loanNo lenderName amount paid left date').lean();
  return rows.map((l) => ({ _id: String(l._id), loanNo: l.loanNo, lenderName: l.lenderName, amount: l.amount, paid: l.paid || 0, left: l.left, date: l.date }));
}

/** The loan to pay, checked for this amount (its own earlier repayment is allowed back). */
async function checkRepay(loanId, amount, excludeExpenseId = null) {
  if (!isId(loanId)) throw httpError(400, 'Pick which loan is being paid back');
  const loan = await Loan.findOne({ _id: loanId, isDeleted: { $ne: true } }).lean();
  if (!loan) throw httpError(404, 'Loan not found');
  const mine = excludeExpenseId
    ? (loan.repayments || []).filter((r) => r.expense && String(r.expense) === String(excludeExpenseId)).reduce((t, r) => t + (Number(r.amount) || 0), 0)
    : 0;
  const room = round2((Number(loan.left) || 0) + mine);
  const amt = round2(amount);
  if (!(amt > 0)) throw httpError(400, 'Enter the amount paid back');
  if (amt > room + 0.009) throw httpError(400, `Only Rs ${room.toLocaleString('en-PK')} is left to pay on ${loan.loanNo}`);
  return loan;
}

/** Make / update / remove the expense's repayment on its loan (call after any change). */
async function sync(expense, { user } = {}) {
  if (!expense || !expense.loanRepayLoan) return;
  const loan = await Loan.findOne({ _id: expense.loanRepayLoan });
  if (!loan) return;
  const id = String(expense._id);
  const idx = loan.repayments.findIndex((r) => r.expense && String(r.expense) === id);
  const gone = expense.isDeleted || !(Number(expense.amount) > 0);
  if (gone) {
    if (idx >= 0) loan.repayments.splice(idx, 1);
  } else {
    const fields = {
      amount: round2(expense.amount),
      date: expense.date || new Date(),
      method: METHOD[expense.paymentMethod] || 'Other',
      note: `Expense: ${expense.title || ''}${expense.counterName ? ` (${expense.counterName})` : ''}`.slice(0, 300),
    };
    if (idx >= 0) Object.assign(loan.repayments[idx], fields);
    else {
      loan.repayments.push({
        ...fields,
        expense: expense._id,
        by: (user && user._id) || null,
        byName: [user && user.firstName, user && user.lastName].filter(Boolean).join(' ') || '',
      });
    }
  }
  totals(loan);
  await loan.save();
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
        await ExpenseCategory.create({ name: CATEGORY, description: 'Paying back a loan (not a shop expense)' });
      } catch (e) {
        if (e && e.code !== 11000) throw e;
      }
    }
  } else if (live.isActive === false) {
    await ExpenseCategory.updateOne({ _id: live._id }, { $set: { isActive: true } });
  }
  ensured = true;
}

module.exports = { CATEGORY, isLoanRepay, openLoans, checkRepay, sync, ensureCategory };
