// One-time migration (owner, 2026-11-11): every OLD POS "bank_transfer" was
// really JazzCash. From now on bank_transfer = the shop's UBL account and
// jazzcash is its own method, so the old records move to jazzcash.
//
//   node scripts/moveBankTransferToJazzcash.js                  -> DRY RUN, prints what would change
//   node scripts/moveBankTransferToJazzcash.js --apply          -> writes to the database
//   node scripts/moveBankTransferToJazzcash.js --before 2026-11-11T18:00:00+05:00
//       -> only bills made / tills opened before that time (default: when the script runs)
//
// What it changes:
//   posorders:    paymentMethod, paymentHistory[].paymentMethod, refundMethod  bank_transfer -> jazzcash
//   cashsessions: expected.bankTransfer -> expected.jazzcash (bankTransfer = 0),
//                 bankTransferTotal -> jazzcashTotal (bankTransferTotal = null), same for draft.*
// Before writing, every doc it will change is copied to `_backup_bt_to_jazzcash_<timestamp>`.
// Safe to run again: moved records no longer match. After --apply a marker is saved
// in `_migrations`, and the script will not apply again (new UBL bank transfers stay).
// Only runs against the shop database `pos_mirpur_dollar_shop`.

const MIGRATION_ID = 'bank_transfer_to_jazzcash_2026_11_11';
const DB_NAME = 'pos_mirpur_dollar_shop';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Run the migration on a native MongoDB `db`.
 * Returns { applied, alreadyDone, before, backup, orders: {...}, sessions: {...} }.
 */
async function migrate(db, { apply = false, before = new Date(), log = console.log } = {}) {
  const cutoff = new Date(before);
  if (Number.isNaN(cutoff.getTime())) throw new Error('Bad --before date');
  const marker = await db.collection('_migrations').findOne({ _id: MIGRATION_ID });
  if (marker && apply) {
    log(`Already applied on ${marker.appliedAt.toISOString()} (backup ${marker.backup}). Nothing to do.`);
    return { applied: false, alreadyDone: true, before: cutoff, backup: marker.backup, orders: null, sessions: null };
  }

  /* ---------- POS orders ---------- */
  const orders = db.collection('posorders');
  const orderFilter = {
    createdAt: { $lt: cutoff },
    $or: [{ paymentMethod: 'bank_transfer' }, { 'paymentHistory.paymentMethod': 'bank_transfer' }, { refundMethod: 'bank_transfer' }],
  };
  const orderDocs = await orders.find(orderFilter).toArray();
  const o = { docs: orderDocs.length, paymentMethod: 0, billTotal: 0, historyEntries: 0, historyAmount: 0, refundMethod: 0 };
  for (const d of orderDocs) {
    if (d.paymentMethod === 'bank_transfer') {
      o.paymentMethod += 1;
      o.billTotal += Number(d.total) || 0;
    }
    for (const p of d.paymentHistory || []) {
      if (p && p.paymentMethod === 'bank_transfer') {
        o.historyEntries += 1;
        o.historyAmount += Number(p.amount) || 0;
      }
    }
    if (d.refundMethod === 'bank_transfer') o.refundMethod += 1;
  }
  o.billTotal = round2(o.billTotal);
  o.historyAmount = round2(o.historyAmount);

  /* ---------- Till sessions ---------- */
  const sessions = db.collection('cashsessions');
  const moved = { $exists: true, $nin: [0, null] };
  const sessionDocs = await sessions
    .find({
      openedAt: { $lt: cutoff },
      $or: [{ 'expected.bankTransfer': moved }, { bankTransferTotal: { $type: 'number' } }, { 'draft.bankTransferTotal': { $type: 'number' } }],
    })
    .toArray();
  const s = { docs: sessionDocs.length, expected: 0, expectedAmount: 0, entered: 0, enteredAmount: 0, drafts: 0, draftAmount: 0 };
  const sessionSets = sessionDocs.map((d) => {
    const set = {};
    const e = d.expected || {};
    if (isNum(e.bankTransfer) && e.bankTransfer !== 0) {
      set['expected.jazzcash'] = round2((Number(e.jazzcash) || 0) + e.bankTransfer);
      set['expected.bankTransfer'] = 0;
      s.expected += 1;
      s.expectedAmount += e.bankTransfer;
    }
    if (isNum(d.bankTransferTotal)) {
      set.jazzcashTotal = round2((isNum(d.jazzcashTotal) ? d.jazzcashTotal : 0) + d.bankTransferTotal);
      set.bankTransferTotal = null;
      s.entered += 1;
      s.enteredAmount += d.bankTransferTotal;
    }
    if (d.draft && isNum(d.draft.bankTransferTotal)) {
      set['draft.jazzcashTotal'] = round2((isNum(d.draft.jazzcashTotal) ? d.draft.jazzcashTotal : 0) + d.draft.bankTransferTotal);
      set['draft.bankTransferTotal'] = null;
      s.drafts += 1;
      s.draftAmount += d.draft.bankTransferTotal;
    }
    return { _id: d._id, set };
  });
  s.expectedAmount = round2(s.expectedAmount);
  s.enteredAmount = round2(s.enteredAmount);
  s.draftAmount = round2(s.draftAmount);

  log(`Records made before ${cutoff.toISOString()}`);
  log(`POS orders to change: ${o.docs}`);
  log(`  paymentMethod bank_transfer -> jazzcash: ${o.paymentMethod} bills, total Rs ${o.billTotal}`);
  log(`  paymentHistory entries: ${o.historyEntries}, Rs ${o.historyAmount}`);
  log(`  refundMethod: ${o.refundMethod}`);
  log(`Till sessions to change: ${s.docs}`);
  log(`  expected.bankTransfer -> expected.jazzcash: ${s.expected} tills, Rs ${s.expectedAmount}`);
  log(`  bankTransferTotal -> jazzcashTotal: ${s.entered} tills, Rs ${s.enteredAmount}`);
  log(`  draft bankTransferTotal -> jazzcashTotal: ${s.drafts} tills, Rs ${s.draftAmount}`);

  if (!apply) {
    log('\nDRY RUN: nothing written. Run again with --apply to write.');
    return { applied: false, alreadyDone: !!marker, before: cutoff, backup: null, orders: o, sessions: s };
  }

  // 1. Backup.
  const backup = `_backup_bt_to_jazzcash_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15)}`;
  const copies = [
    ...orderDocs.map((d) => ({ collection: 'posorders', originalId: d._id, doc: d })),
    ...sessionDocs.map((d) => ({ collection: 'cashsessions', originalId: d._id, doc: d })),
  ];
  if (copies.length) await db.collection(backup).insertMany(copies);
  log(`\nBacked up ${copies.length} docs to ${backup}`);

  // 2. POS orders.
  const ids = orderDocs.map((d) => d._id);
  const r1 = await orders.updateMany({ _id: { $in: ids }, paymentMethod: 'bank_transfer' }, { $set: { paymentMethod: 'jazzcash' } });
  const r2 = await orders.updateMany(
    { _id: { $in: ids }, 'paymentHistory.paymentMethod': 'bank_transfer' },
    { $set: { 'paymentHistory.$[p].paymentMethod': 'jazzcash' } },
    { arrayFilters: [{ 'p.paymentMethod': 'bank_transfer' }] }
  );
  const r3 = await orders.updateMany({ _id: { $in: ids }, refundMethod: 'bank_transfer' }, { $set: { refundMethod: 'jazzcash' } });
  log(`posorders: paymentMethod ${r1.modifiedCount}, paymentHistory ${r2.modifiedCount}, refundMethod ${r3.modifiedCount}`);

  // 3. Till sessions.
  const ops = sessionSets.filter((x) => Object.keys(x.set).length).map((x) => ({ updateOne: { filter: { _id: x._id }, update: { $set: x.set } } }));
  const r4 = ops.length ? await sessions.bulkWrite(ops) : { modifiedCount: 0 };
  log(`cashsessions: ${r4.modifiedCount}`);

  await db.collection('_migrations').updateOne(
    { _id: MIGRATION_ID },
    { $set: { appliedAt: new Date(), before: cutoff, backup, orders: o, sessions: s } },
    { upsert: true }
  );
  log('Done.');
  return { applied: true, alreadyDone: false, before: cutoff, backup, orders: o, sessions: s };
}

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const i = args.indexOf('--before');
  const before = i >= 0 ? new Date(args[i + 1]) : new Date();
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set in .env');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const name = mongoose.connection.name;
  console.log(`Database: ${name}`);
  if (name !== DB_NAME) {
    console.error(`Refusing to run: database is "${name}", expected "${DB_NAME}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(apply ? 'Mode: APPLY (writes)\n' : 'Mode: dry run\n');
  try {
    await migrate(mongoose.connection.db, { apply, before });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate, MIGRATION_ID, DB_NAME };
