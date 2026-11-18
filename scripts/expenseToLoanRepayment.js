// Turn an existing expense into a "Loan Repayment" on a loan (owner, 2026-11-17).
// The expense keeps its till / counter / date, so the till stays the same; the
// loan gets a repayment and the expense stops counting as a shop cost.
//   node scripts/expenseToLoanRepayment.js <expenseId> <loanNo>            -> dry run
//   node scripts/expenseToLoanRepayment.js <expenseId> <loanNo> --apply    -> saves
require('dotenv').config();
const mongoose = require('mongoose');
const Expense = require('../src/models/expense');
const Loan = require('../src/models/loan');
const link = require('../src/services/loanRepayExpenseLink');

const [expenseId, loanNo] = process.argv.slice(2);
const apply = process.argv.includes('--apply');

(async () => {
  if (!expenseId || !loanNo) throw new Error('Usage: <expenseId> <loanNo> [--apply]');
  await mongoose.connect(process.env.MONGO_URI);
  const e = await Expense.findOne({ _id: expenseId, isDeleted: { $ne: true } });
  if (!e) throw new Error('Expense not found');
  if (e.loanRepayLoan) throw new Error(`Already a repayment on ${e.loanRepayNo}`);
  if (e.posOrder || e.investment || e.fromPersonal || e.loan) throw new Error('This expense is linked to something else (refund / investment / personal loan)');
  const loan = await Loan.findOne({ loanNo, isDeleted: { $ne: true } });
  if (!loan) throw new Error(`Loan ${loanNo} not found`);
  await link.checkRepay(loan._id, e.amount);
  console.log(`Expense "${e.title}" Rs ${e.amount} (${e.paymentMethod}, ${e.counterName || 'no counter'}, category ${e.category})`);
  console.log(`-> Loan Repayment on ${loan.loanNo} (${loan.lenderName}): left Rs ${loan.left} -> Rs ${loan.left - e.amount}`);
  if (!apply) {
    console.log('Dry run. Add --apply to save.');
  } else {
    await link.ensureCategory();
    e.category = link.CATEGORY;
    e.categories = [link.CATEGORY];
    e.loanRepayLoan = loan._id;
    e.loanRepayNo = loan.loanNo;
    await e.save();
    await link.sync(e);
    const after = await Loan.findById(loan._id).lean();
    console.log(`Saved. ${after.loanNo}: paid Rs ${after.paid}, left Rs ${after.left}, status ${after.status}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
