// Permanently delete DUMMY expenses (owner, 2026-11-18: the two 14 Nov 2026
// JazzCash Rs 100 test expenses "dummy expnse" and "dummy test").
// Picks expenses on one day whose title starts with "dummy". Refuses when an
// investment, loan, payroll run, shop-use or staff-tip record points at one.
// Bank-check lines matched to one are un-matched.
//
//   node scripts/deleteDummyExpenses.js 2026-11-14            -> DRY RUN
//   node scripts/deleteDummyExpenses.js 2026-11-14 --apply    -> deletes (backup JSON written first)
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const fs = require('fs');
const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';

async function main() {
  const day = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('Usage: node scripts/deleteDummyExpenses.js <YYYY-MM-DD> [--apply]');

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);

  // Pakistan day (UTC+5), with a margin either side for however the date was stored.
  const start = new Date(new Date(`${day}T00:00:00+05:00`).getTime() - 5 * 3600 * 1000);
  const end = new Date(new Date(`${day}T23:59:59.999+05:00`).getTime() + 5 * 3600 * 1000);
  const rows = await db
    .collection('expenses')
    .find({ date: { $gte: start, $lte: end }, title: { $regex: '^\\s*dummy', $options: 'i' } })
    .toArray();
  if (!rows.length) throw new Error(`No "dummy" expense around ${day}`);
  for (const e of rows) {
    console.log(`${new Date(e.date).toISOString()} · "${e.title}" · ${e.category} · ${e.paymentMethod} · Rs ${e.amount}${e.isDeleted ? ' · (already soft-deleted)' : ''}`);
  }

  const ids = rows.map((e) => e._id);
  const refs = {
    investments: await db.collection('investments').countDocuments({ 'expenseLinks.expense': { $in: ids } }),
    loans: await db.collection('loans').countDocuments({ $or: [{ expense: { $in: ids } }, { 'repayments.expense': { $in: ids } }] }),
    payrollruns: await db.collection('payrollruns').countDocuments({ $or: [{ expense: { $in: ids } }, { 'payments.expense': { $in: ids } }] }),
    shopuses: await db.collection('shopuses').countDocuments({ expense: { $in: ids } }),
    stafftips: await db.collection('stafftips').countDocuments({ expense: { $in: ids } }),
  };
  const linked = rows.filter((e) => e.investment || e.posOrder);
  const bankLines = await db.collection('bankstatementlines').find({ 'match.id': { $in: [...ids, ...ids.map(String)] } }).project({ _id: 1 }).toArray();
  console.log(`  links: ${Object.entries(refs).map(([k, v]) => `${k} ${v}`).join(', ')} · investment/refund-linked ${linked.length} · bank lines ${bankLines.length}`);
  if (Object.values(refs).some(Boolean) || linked.length) throw new Error('Another record uses one of these expenses — not a dummy. Not deleting.');

  if (!apply) {
    console.log(`\nDRY RUN — ${rows.length} expense(s) would be deleted. Add --apply to delete for good.`);
    return;
  }
  const backup = path.join(__dirname, `deleteDummyExpenses-backup-${day}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify({ expenses: rows, bankLines }, null, 2));
  console.log(`  backup: ${backup}`);
  if (bankLines.length) await db.collection('bankstatementlines').updateMany({ _id: { $in: bankLines.map((l) => l._id) } }, { $set: { match: null } });
  const r = await db.collection('expenses').deleteMany({ _id: { $in: ids } });
  console.log(`\nDeleted ${r.deletedCount} expense(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
