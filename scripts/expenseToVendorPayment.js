// Move a cash expense that was really a vendor payment onto the vendor (owner, 2026-11-17).
// The vendor payment gets the SAME id as the expense, so a till that was already
// closed / verified with that expense (payoutIds) still counts it: the till does not change.
// The vendor ledger gets the payment (what we owe goes down); the expense is deleted
// (soft), so it stops counting as a shop cost.
//   node scripts/expenseToVendorPayment.js <expenseId> <vendorId>            -> dry run
//   node scripts/expenseToVendorPayment.js <expenseId> <vendorId> --apply    -> saves
require('dotenv').config();
const mongoose = require('mongoose');
const Expense = require('../src/models/expense');
const VendorPayment = require('../src/models/vendorPayment');
const CashSession = require('../src/models/cashSession');
const ledger = require('../src/services/vendorLedgerService');
const { nextNumber } = require('../src/services/sequenceService');
const { loadVendor } = require('../src/services/vendors/vendorService');
const { getMainBranchId } = require('../src/helper/productCodes');

const [expenseId, vendorId] = process.argv.slice(2);
const apply = process.argv.includes('--apply');

(async () => {
  if (!expenseId || !vendorId) throw new Error('Usage: <expenseId> <vendorId> [--apply]');
  await mongoose.connect(process.env.MONGO_URI);
  const e = await Expense.findOne({ _id: expenseId, isDeleted: { $ne: true } });
  if (!e) throw new Error('Expense not found (or already deleted)');
  if (e.posOrder || e.investment || e.fromPersonal || e.loan || e.loanRepayLoan) throw new Error('This expense is linked to something else');
  if (String(e.paymentMethod).toLowerCase() !== 'cash') throw new Error('Only cash expenses are handled by this script');
  if (await VendorPayment.exists({ _id: e._id })) throw new Error('Already moved');
  const vendor = await loadVendor(vendorId);
  const session = e.cashSession ? await CashSession.findById(e.cashSession).select('sessionNo branch status').lean() : null;
  const branch = (session && session.branch) || e.branch || (await getMainBranchId());

  const owedBefore = await mongoose.connection.db
    .collection('vendorledgerentries')
    .aggregate([{ $match: { vendor: vendor._id, isVoided: { $ne: true } } }, { $group: { _id: null, c: { $sum: '$credit' }, d: { $sum: '$debit' } } }])
    .toArray();
  const owed = owedBefore[0] ? owedBefore[0].c - owedBefore[0].d : 0;

  console.log(`Expense "${e.title}" Rs ${e.amount} cash, ${e.counterName || 'no counter'}, ${e.date.toISOString().slice(0, 10)}${session ? `, till ${session.sessionNo} (${session.status})` : ''}`);
  console.log(`-> Vendor payment to ${vendor.name}: owed Rs ${owed} -> Rs ${owed - e.amount}`);
  if (!apply) {
    console.log('Dry run. Add --apply to save.');
    return mongoose.disconnect();
  }

  const paymentNo = await nextNumber('VP');
  const note = `Moved from expense "${e.title}" (was entered as an expense on ${e.date.toISOString().slice(0, 10)})`;
  const payment = await VendorPayment.create({
    _id: e._id, // same id: the closed till keeps counting it
    paymentNo,
    vendor: vendor._id,
    vendorName: vendor.name,
    branch,
    amount: e.amount,
    method: 'cash',
    counter: e.counter || null,
    counterName: e.counterName || '',
    reference: '',
    date: e.date,
    attachments: (e.receipts || []).map((r) => r.url).filter(Boolean),
    notes: note,
    createdBy: e.createdBy || null,
    history: [{ at: new Date(), by: null, action: 'created', note: `Cash Rs ${e.amount} · ${note}` }],
  });
  let entry;
  try {
    entry = await ledger.post({
      vendorId: vendor._id,
      type: 'payment',
      debit: e.amount,
      date: e.date,
      branchId: branch,
      method: 'cash',
      bankId: null,
      reference: '',
      attachments: payment.attachments,
      refType: 'VendorPayment',
      refId: payment._id,
      refNo: paymentNo,
      description: note.slice(0, 300),
      userId: null,
      unique: true,
    });
  } catch (err) {
    await VendorPayment.deleteOne({ _id: payment._id });
    throw err;
  }
  await VendorPayment.updateOne({ _id: payment._id }, { $set: { ledgerEntry: entry._id } });

  e.isDeleted = true;
  e.deletedAt = new Date();
  e.notes = `${e.notes ? `${e.notes} · ` : ''}Moved to vendor payment ${paymentNo} (${vendor.name})`.slice(0, 1000);
  await e.save();

  console.log(`Saved: ${paymentNo} to ${vendor.name}, Rs ${e.amount}. Expense deleted (soft).`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
