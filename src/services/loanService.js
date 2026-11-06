// Loans we have taken (money to give back). See models/loan.js.
// Lender picked from vendors, customers or employees, or typed by hand.
const mongoose = require('mongoose');
const Loan = require('../models/loan');
const LoanLender = require('../models/loanLender');
const { nextNumber } = require('./sequenceService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const METHODS = ['Cash', 'Bank Transfer', 'Easypaisa', 'JazzCash', 'Cheque', 'Other'];
const TYPES = ['person', 'vendor', 'customer', 'employee', 'other'];

function readDate(v, label, required = true) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Pick the ${label}`);
    return null;
  }
  const s = String(v).slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(`Bad ${label}`);
  return d;
}
const readMethod = (v) => (METHODS.includes(String(v)) ? String(v) : 'Cash');

function totals(loan) {
  loan.paid = round2((loan.repayments || []).reduce((t, r) => t + (Number(r.amount) || 0), 0));
  loan.left = round2(loan.amount - loan.paid);
  loan.status = loan.left <= 0.009 ? 'paid' : 'open';
}

const userName = (u) => [u && u.firstName, u && u.lastName].filter(Boolean).join(' ') || (u && u.email) || '';

/** People who can lend: vendors, customers, employees (one list for the dropdown). */
async function lenders() {
  const db = mongoose.connection.db;
  const [vendors, customers, employees] = await Promise.all([
    db.collection('vendors').find({ isDeleted: { $ne: true } }).project({ name: 1, phone: 1, companyName: 1 }).sort({ name: 1 }).toArray(),
    db
      .collection('users')
      .find({ isDeleted: { $ne: true }, isActive: { $ne: false }, role: { $ne: 'admin' } })
      .project({ firstName: 1, lastName: 1, phone: 1 })
      .sort({ firstName: 1 })
      .toArray(),
    db.collection('employees').find({ isDeleted: { $ne: true } }).project({ firstName: 1, lastName: 1, phone: 1, designation: 1 }).sort({ firstName: 1 }).toArray(),
  ]);
  return [
    ...vendors.map((v) => ({ type: 'vendor', _id: v._id, name: (v.name || v.companyName || '').trim(), phone: v.phone || '' })),
    ...customers.map((c) => ({ type: 'customer', _id: c._id, name: userName(c), phone: c.phone || '' })),
    ...employees.map((e) => ({ type: 'employee', _id: e._id, name: userName(e), phone: e.phone || '', extra: e.designation || '' })),
  ].filter((x) => x.name);
}

async function resolveLender(body) {
  const type = TYPES.includes(body.lenderType) ? body.lenderType : null;
  if (!type) throw bad('Pick who gave the loan');
  if (type === 'person') {
    if (!isId(body.lender)) throw bad('Pick who gave the loan');
    const p = await LoanLender.findOne({ _id: body.lender, isDeleted: { $ne: true } }).lean();
    if (!p) throw bad('That person was not found');
    return { lenderType: 'person', lender: p._id, lenderName: p.name, lenderPhone: p.phone || '' };
  }
  if (type === 'other') {
    const name = String(body.lenderName || '').trim().slice(0, 120);
    if (!name) throw bad('Write the name of the person who gave the loan');
    return { lenderType: 'other', lender: null, lenderName: name, lenderPhone: String(body.lenderPhone || '').trim().slice(0, 30) };
  }
  if (!isId(body.lender)) throw bad('Pick who gave the loan');
  const list = await lenders();
  const hit = list.find((x) => x.type === type && String(x._id) === String(body.lender));
  if (!hit) throw bad('That person was not found');
  return { lenderType: type, lender: hit._id, lenderName: hit.name, lenderPhone: hit.phone || '' };
}

async function list(query = {}) {
  const filter = { isDeleted: { $ne: true } };
  if (['open', 'paid'].includes(query.status)) filter.status = query.status;
  if (TYPES.includes(query.lenderType)) filter.lenderType = query.lenderType;
  if (query.search) {
    const esc = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ lenderName: { $regex: esc, $options: 'i' } }, { loanNo: { $regex: esc, $options: 'i' } }, { notes: { $regex: esc, $options: 'i' } }];
  }
  const rows = await Loan.find(filter).sort({ date: -1, createdAt: -1 }).lean();
  const all = await Loan.find({ isDeleted: { $ne: true } }).select('amount paid left status').lean();
  const summary = {
    loans: all.length,
    taken: round2(all.reduce((t, l) => t + l.amount, 0)),
    paidBack: round2(all.reduce((t, l) => t + (l.paid || 0), 0)),
    left: round2(all.reduce((t, l) => t + (l.left || 0), 0)),
    open: all.filter((l) => l.status === 'open').length,
  };
  return { data: rows, meta: { summary } };
}

async function get(id) {
  if (!isId(id)) throw bad('Loan not found', 404);
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
  if (!loan) throw bad('Loan not found', 404);
  return loan;
}

/** Saved lenders (people we borrow from), for the dropdown. */
async function people() {
  return LoanLender.find({ isDeleted: { $ne: true } }).sort({ name: 1 }).lean();
}

async function addPerson(body = {}, { user } = {}) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw bad('Write the name');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const same = await LoanLender.findOne({ isDeleted: { $ne: true }, name: { $regex: `^${esc}$`, $options: 'i' } }).lean();
  if (same) return same;
  const p = await LoanLender.create({
    name,
    phone: String(body.phone || '').trim().slice(0, 30),
    note: String(body.note || '').trim().slice(0, 300),
    createdBy: user && user._id ? user._id : null,
  });
  return p.toObject();
}

async function create(body = {}, { user, attachments = [] } = {}) {
  const amount = round2(body.amount);
  if (!(amount > 0)) throw bad('Enter the loan amount');
  const who = await resolveLender(body);
  // "Spent on a shop expense?" yes -> an expense is made for it too.
  const asExpense = body.asExpense === true || body.asExpense === 'true';
  const exTitle = String(body.expenseTitle || '').trim().slice(0, 200);
  const exCategory = String(body.expenseCategory || '').trim().slice(0, 100);
  if (asExpense && !exTitle) throw bad('Write what the expense was for');
  if (asExpense && !exCategory) throw bad('Pick the expense category');
  const loan = new Loan({
    loanNo: await nextNumber('LOAN'),
    ...who,
    amount,
    date: readDate(body.date, 'date'),
    method: readMethod(body.method),
    dueDate: readDate(body.dueDate, 'due date', false),
    notes: String(body.notes || '').trim().slice(0, 1000),
    attachments,
    createdBy: user && user._id ? user._id : null,
    createdByName: userName(user),
  });
  totals(loan);
  await loan.save();
  if (asExpense) {
    const Expense = require('../models/expense');
    const ex = await Expense.create({
      title: exTitle,
      amount,
      category: exCategory,
      categories: [exCategory],
      date: loan.date,
      paymentMethod: 'Cash',
      notes: `Paid from personal money of ${loan.lenderName} (loan ${loan.loanNo})`,
      fromPersonal: true,
      loan: loan._id,
      loanNo: loan.loanNo,
    });
    loan.expense = ex._id;
    loan.expenseTitle = ex.title;
    await loan.save();
  }
  return loan.toObject();
}

/** Expense paid from personal money -> a loan from that person, linked both ways. */
async function createForExpense(expense, body = {}, { user } = {}) {
  const who = await resolveLender({ lenderType: body.lenderType || 'person', lender: body.lender, lenderName: body.lenderName });
  const loan = new Loan({
    loanNo: await nextNumber('LOAN'),
    ...who,
    amount: round2(expense.amount),
    date: expense.date || new Date(),
    method: 'Cash',
    notes: `Paid the expense "${expense.title}" from personal money`,
    expense: expense._id,
    expenseTitle: expense.title,
    createdBy: user && user._id ? user._id : null,
    createdByName: userName(user),
  });
  totals(loan);
  await loan.save();
  return loan.toObject();
}

/** Linked expense changed: keep the loan the same (amount / date / deleted). */
async function syncFromExpense(expense) {
  if (!expense || !expense.loan) return;
  const loan = await Loan.findOne({ _id: expense.loan, isDeleted: { $ne: true } });
  if (!loan) return;
  if (expense.isDeleted) {
    loan.isDeleted = true;
    loan.deletedAt = new Date();
  } else {
    loan.amount = round2(expense.amount);
    if (expense.date) loan.date = expense.date;
    loan.expenseTitle = expense.title;
    totals(loan);
  }
  await loan.save();
}

/** Linked loan: the expense amount may not go below what was already paid back. */
async function checkExpenseAmount(expense, nextAmount) {
  if (!expense || !expense.loan) return;
  const loan = await Loan.findOne({ _id: expense.loan, isDeleted: { $ne: true } }).lean();
  if (loan && nextAmount + 0.009 < (loan.paid || 0)) throw bad(`Rs ${loan.paid} of loan ${loan.loanNo} is already paid back; the expense cannot be less than that`);
}

async function update(id, body = {}) {
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!loan) throw bad('Loan not found', 404);
  if (body.lenderType !== undefined) Object.assign(loan, await resolveLender(body));
  if (body.amount !== undefined && loan.expense && Math.abs(round2(body.amount) - loan.amount) >= 0.01) {
    throw bad('This loan paid an expense: change the amount on the expense (+ / − adjustment)');
  }
  if (body.amount !== undefined) {
    const amount = round2(body.amount);
    if (!(amount > 0)) throw bad('Enter the loan amount');
    if (amount + 0.009 < loan.paid) throw bad(`Already paid back Rs ${loan.paid}; the loan cannot be less than that`);
    loan.amount = amount;
  }
  if (body.date !== undefined) loan.date = readDate(body.date, 'date');
  if (body.method !== undefined) loan.method = readMethod(body.method);
  if (body.dueDate !== undefined) loan.dueDate = readDate(body.dueDate, 'due date', false);
  if (body.notes !== undefined) loan.notes = String(body.notes || '').trim().slice(0, 1000);
  totals(loan);
  await loan.save();
  return loan.toObject();
}

/** Add slip(s) to a loan already saved. */
async function addSlips(id, attachments = []) {
  if (!attachments.length) throw bad('Choose a slip to upload');
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!loan) throw bad('Loan not found', 404);
  loan.attachments.push(...attachments);
  await loan.save();
  return loan.toObject();
}

async function remove(id, { user } = {}) {
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!loan) throw bad('Loan not found', 404);
  loan.isDeleted = true;
  loan.deletedAt = new Date();
  loan.deletedBy = user && user._id ? user._id : null;
  await loan.save();
  // Its expense goes too, so both sides stay the same.
  if (loan.expense) {
    const Expense = require('../models/expense');
    await Expense.updateOne({ _id: loan.expense, isDeleted: { $ne: true } }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: loan.deletedBy } });
  }
  return { _id: loan._id, deleted: true };
}

async function addRepayment(id, body = {}, { user, attachments = [] } = {}) {
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!loan) throw bad('Loan not found', 404);
  const amount = round2(body.amount);
  if (!(amount > 0)) throw bad('Enter the amount paid back');
  if (amount > loan.left + 0.009) throw bad(`Only Rs ${loan.left} is left to pay`);
  loan.repayments.push({
    amount,
    date: readDate(body.date, 'date'),
    method: readMethod(body.method),
    note: String(body.note || '').trim().slice(0, 300),
    attachments,
    by: user && user._id ? user._id : null,
    byName: userName(user),
  });
  totals(loan);
  await loan.save();
  return loan.toObject();
}

async function removeRepayment(id, repaymentId) {
  const loan = await Loan.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!loan) throw bad('Loan not found', 404);
  const before = loan.repayments.length;
  loan.repayments = loan.repayments.filter((r) => String(r._id) !== String(repaymentId));
  if (loan.repayments.length === before) throw bad('Payment not found', 404);
  totals(loan);
  await loan.save();
  return loan.toObject();
}

module.exports = { METHODS, lenders, people, addPerson, list, get, create, update, remove, addSlips, addRepayment, removeRepayment, createForExpense, syncFromExpense, checkExpenseAmount };
