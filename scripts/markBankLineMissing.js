// Mark a wrongly matched bank-check line as "Not in system" (owner, 2026-11-20:
// 04 Nov 2026 UBL transfer Rs 100,000 to ADIL MUSHTAQ was matched to VP-2026-00083,
// which is a DWT Jabto payment of 16 Nov).
// The line is un-matched (so the payment is free to match its real line) and gets an
// owner decision "missing", which a re-check keeps.
//
//   node scripts/markBankLineMissing.js VP-2026-00083 2026-11-04 100000            -> DRY RUN
//   node scripts/markBankLineMissing.js VP-2026-00083 2026-11-04 100000 --apply    -> updates
//
// Run inside the Coolify backend container. Only runs against the DOLLAR & Co
// database (pos_mirpur_dollar_shop), never the old Atlas copy.

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';

async function main() {
  const [ref, date, amountArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!ref || !date || !amountArg) throw new Error('Usage: node scripts/markBankLineMissing.js <matchedRef> <YYYY-MM-DD> <amount> [--apply]');
  const amount = Number(amountArg);

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (/mongodb\.net/.test(process.env.MONGO_URI || '')) throw new Error('MONGO_URI is the old Atlas DB. Run this inside the Coolify backend container.');
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);

  const lines = await db.collection('bankstatementlines').find({ 'match.ref': ref, date, amount, direction: 'out' }).toArray();
  if (lines.length !== 1) throw new Error(`Expected 1 line matched to ${ref} on ${date} for ${amount}, found ${lines.length}`);
  const line = lines[0];
  console.log(`${line.date} · ${line.payee || line.particulars} · Rs ${line.amount} · status ${line.status}${line.manual ? ` · manual ${JSON.stringify(line.manual)}` : ''}`);
  console.log(`  matched to: ${line.match.ref} · ${line.match.label} · ${line.match.date} · Rs ${line.match.amount}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Add --apply to mark it "Not in system".');
    return;
  }

  await db.collection('bankstatementlines').updateOne(
    { _id: line._id },
    { $set: { match: null, status: 'missing', issue: 'No matching record in the system' } }
  );
  const svc = require('../src/services/bankcheck/bankCheckService');
  await svc.setManual(String(line._id), { status: 'missing', note: `Not ${ref} (wrong match) — not in system` }, { user: null });
  console.log(`\nDone: line un-matched from ${ref} and marked "Not in system"; statement totals updated.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
