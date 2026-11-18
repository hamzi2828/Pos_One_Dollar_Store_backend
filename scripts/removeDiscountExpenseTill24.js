// TILL-2026-00024 (owner, 2026-11-18): the Rs 100 expense "discount 32100 bill 100
// discount on costomer demand" is wrong — the Rs 100 discount is already on card bill
// POS-20261118-044316-5026 (32,100 -> 32,000), so no cash left the drawer.
// Soft-deletes that expense (as the app does) and recalculates the till's expected
// cash and variance (closed, not verified yet).
//
//   node scripts/removeDiscountExpenseTill24.js           -> DRY RUN
//   node scripts/removeDiscountExpenseTill24.js --apply
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';
const SESSION_ID = '6afc89037b537891918b6da6';

async function main() {
  const apply = process.argv.includes('--apply');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);
  const till = require('../src/services/tillService');

  const session = await db.collection('cashsessions').findOne({ _id: new mongoose.Types.ObjectId(SESSION_ID) });
  if (!session) throw new Error('Till not found');
  if (session.status !== 'closed') throw new Error(`${session.sessionNo} is ${session.status}, not closed — not changing it.`);

  const exp = await db.collection('expenses').findOne({ title: /^discount 32100 bill 100/i, amount: 100, isDeleted: { $ne: true } });
  if (!exp) throw new Error('Expense not found (already removed?)');
  if (!(session.payoutIds || []).some((x) => String(x) === String(exp._id))) throw new Error('That expense is not on this till.');
  console.log(`${session.sessionNo}: expected Rs ${session.expected.expectedCash}, variance ${session.variance}`);
  console.log(`expense: "${exp.title}" Rs ${exp.amount} ${exp.paymentMethod}`);

  if (!apply) {
    console.log('\nDRY RUN — add --apply to remove it.');
    return;
  }
  await db.collection('expenses').updateOne({ _id: exp._id }, { $set: { isDeleted: true, deletedAt: new Date(), notes: 'Removed: discount already on card bill POS-20261118-044316-5026' } });
  const fresh = await db.collection('cashsessions').findOne({ _id: session._id });
  const updated = await till.refreshExpenses(fresh);
  console.log(`\nRemoved. ${session.sessionNo}: expenses Rs ${updated.expected.expenses}, expected Rs ${updated.expected.expectedCash}, variance ${updated.variance}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
