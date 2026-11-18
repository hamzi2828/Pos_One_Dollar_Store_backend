// One-time fix (owner, 2026-11-12) for bill POS-20261112-536098-2860 (Rs 900, 3 gift items):
// the WHOLE bill is unpaid (broken items): Waleed Sohail Rs 600 + Raja Faisal Yaseen Rs 300 = Rs 900.
// damagePenalty.js was first run as Rs 600 (Waleed 300 / Faisal 300). This corrects:
//   - "Pending Amount" expense 6af5c82f243b32f88808b604: Rs 600 -> Rs 900
//   - Waleed's deduction 6af5c82e243b32f88808b600: Rs 300 -> Rs 600 (Faisal's stays Rs 300)
//   - notes on the bill, expense and both deductions
// Till is open, so it picks the new expense amount up itself. Backups first.
//
//   node scripts/fixDamage2860.js          -> DRY RUN
//   node scripts/fixDamage2860.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const ORDER_NO = 'POS-20261112-536098-2860';
const EXPENSE_ID = '6af5c82f243b32f88808b604';
const WALEED_DED = '6af5c82e243b32f88808b600';
const FAISAL_DED = '6af5c82e243b32f88808b602';
const TOTAL = 900;
const WALEED = 600;
const FAISAL = 300;
const SPLIT = `waleed Sohail (EMP-2026-00013) Rs ${WALEED}, Raja Faisal Yaseen (EMP-2026-00012) Rs ${FAISAL}`;

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const apply = process.argv.includes('--apply');
  const id = (x) => new mongoose.Types.ObjectId(x);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const o = await db.collection('posorders').findOne({ orderNumber: ORDER_NO });
    const ex = await db.collection('expenses').findOne({ _id: id(EXPENSE_ID) });
    const dw = await db.collection('payrolldeductions').findOne({ _id: id(WALEED_DED) });
    const df = await db.collection('payrolldeductions').findOne({ _id: id(FAISAL_DED) });
    if (!o || !ex || !dw || !df) throw new Error('Bill, expense or deduction not found');
    if (o.total !== TOTAL) throw new Error(`Bill total is ${o.total}, expected ${TOTAL}`);
    const session = await db.collection('cashsessions').findOne({ _id: o.cashSession });
    if (!session || session.status === 'verified') throw new Error(`Till is ${session && session.status}`);
    if ([dw, df].some((d) => d.status === 'applied')) throw new Error('A deduction is already applied to payroll');

    console.log(`Bill ${ORDER_NO}: Rs ${o.total}, ${o.paymentStatus}; ${session.counterName} till ${session.status}`);
    console.log(`Expense ${EXPENSE_ID}: Rs ${ex.amount} -> Rs ${TOTAL}`);
    console.log(`Waleed deduction ${WALEED_DED}: Rs ${dw.amount} -> Rs ${WALEED} (${dw.status})`);
    console.log(`Faisal deduction ${FAISAL_DED}: Rs ${df.amount} -> Rs ${FAISAL} (${df.status})`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_fix_damage_2860_${Date.now()}`;
    await db.collection(backup).insertMany([
      { collection: 'posorders', originalId: o._id, doc: o },
      { collection: 'expenses', originalId: ex._id, doc: ex },
      { collection: 'payrolldeductions', originalId: dw._id, doc: dw },
      { collection: 'payrolldeductions', originalId: df._id, doc: df },
    ]);
    console.log(`Backed up to ${backup}`);

    const now = new Date();
    await db.collection('expenses').updateOne(
      { _id: ex._id },
      {
        $set: {
          amount: TOTAL,
          notes: `Broken items: whole bill ${ORDER_NO} (Rs ${TOTAL}) not received - recovered by salary deduction: ${SPLIT}. Bill id ${o._id}.`,
          updatedAt: now,
        },
      }
    );
    const dedNote = (share) => `Penalty: Broken items (bill ${ORDER_NO}, Rs ${TOTAL} total, not paid). Share Rs ${share}; split: ${SPLIT}.`;
    await db.collection('payrolldeductions').updateOne({ _id: dw._id }, { $set: { amount: WALEED, note: dedNote(WALEED), updatedAt: now } });
    await db.collection('payrolldeductions').updateOne({ _id: df._id }, { $set: { amount: FAISAL, note: dedNote(FAISAL), updatedAt: now } });
    await db.collection('posorders').updateOne(
      { _id: o._id },
      { $set: { notes: `POS Order\n2026-11-12 owner: broken items, whole bill Rs ${TOTAL} NOT paid - "Pending Amount" expense Rs ${TOTAL}; salary penalty ${SPLIT}.` } }
    );
    console.log('Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
