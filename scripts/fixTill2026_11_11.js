// One-time fix (owner, 2026-11-12) for Counter 2 till of 2026-11-11 (6af36bac22dd5055612a5c77):
//   1. Bill POS-20261111-977235-2615 back to a Rs 1800 cash sale (the cash count shows it was in
//      the drawer). Restored from _backup_bill_2615_pending_*. Raja Asim's Rs 1800 penalty stays.
//   2. Counter 2 entered card total = Rs 78,600: the card machine slip shows Rs 99,600 for both
//      counters (39 sales) vs Rs 102,900 in the system; the Rs 3,300 gap is put on Counter 2.
//   Then the closed till is worked out again.
//
//   node scripts/fixTill2026_11_11.js          -> DRY RUN
//   node scripts/fixTill2026_11_11.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const SESSION_ID = '6af36bac22dd5055612a5c77';
const ORDER_NO = 'POS-20261111-977235-2615';
const CARD_TOTAL = 78600;
const RESTORE = ['paidAmount', 'pendingAmount', 'paymentStatus', 'orderStatus', 'paymentHistory', 'cashAmount', 'changeGiven', 'customerInfo', 'completedAt'];

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const session = await db.collection('cashsessions').findOne({ _id: new mongoose.Types.ObjectId(SESSION_ID) });
    if (!session || session.status !== 'closed') throw new Error(`Till is ${session && session.status}, expected closed`);

    const order = await db.collection('posorders').findOne({ orderNumber: ORDER_NO });
    const backupName = (await db.listCollections({ name: /^_backup_bill_2615_pending_/ }).toArray()).map((c) => c.name).sort()[0];
    if (!backupName) throw new Error('Backup of bill 2615 not found');
    const backup = (await db.collection(backupName).findOne({})).doc;
    // Owner 2026-11-12 (later): the Rs 1800 was NOT received, the bill stays pending. Never restore again.
    const restoreBill = false;
    console.log(`Bill ${ORDER_NO}: now ${order.paymentStatus}, paid ${order.paidAmount}${restoreBill ? ` -> restore from ${backupName} (cash ${backup.paidAmount})` : ' (already restored)'}`);
    console.log(`Counter 2 entered card: ${session.cardTotal} -> ${CARD_TOTAL}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    if (restoreBill) {
      const set = {};
      const unset = {};
      RESTORE.forEach((k) => (backup[k] === undefined ? (unset[k] = '') : (set[k] = backup[k])));
      set.notes = `${order.notes}\nRestored to cash sale 2026-11-12: the cash was in the drawer at closing. Salary penalty for Raja Asim stays.`;
      const r = await db.collection('posorders').updateOne({ _id: order._id, paymentStatus: 'pending' }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      console.log(`Bill restored: ${r.modifiedCount}`);
    }
    await db.collection('cashsessions').updateOne(
      { _id: session._id, status: 'closed' },
      { $set: { cardTotal: CARD_TOTAL }, $push: { history: { at: new Date(), by: null, action: 'bill_changed', note: `Card total set to Rs ${CARD_TOTAL} from the card machine slip (Rs 99,600 both counters, 39 sales; Rs 3,300 less than the system)` } } }
    );
    const till = require('../src/services/tillService');
    const t = await till.refreshClosedSales(session._id, { note: `${ORDER_NO}: back to cash sale (cash was in the drawer)` });
    console.log('Till now:', JSON.stringify({ expectedCash: t.expected.expectedCash, systemCard: t.expected.card, enteredCard: t.cardTotal, variance: t.variance }));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
