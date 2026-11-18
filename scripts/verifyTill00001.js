// One-time (owner, 2026-11-12): verify TILL-2026-00001 (Counter 1, JUNAID ALI, 5 Nov) WITHOUT a
// till-shortage salary deduction. Cash shows Rs 14,550 short only because card / JazzCash sales were
// rung up as cash: card slip Rs 130,502 vs system Rs 117,600 (+12,902), JazzCash Rs 11,600 vs
// Rs 9,900 (+1,700). All money together is Rs 52 over. Bills are not changed (which ones is unknown).
//
//   node scripts/verifyTill00001.js          -> DRY RUN
//   node scripts/verifyTill00001.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const SESSION_NO = 'TILL-2026-00001';

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

    const s = await db.collection('cashsessions').findOne({ sessionNo: SESSION_NO });
    if (!s) throw new Error(`${SESSION_NO} not found`);
    if (s.status !== 'closed') throw new Error(`Till is ${s.status}, expected closed`);
    const e = s.expected || {};
    const cardOver = Math.round(((s.cardTotal || 0) - (e.card || 0)) * 100) / 100;
    const jazzOver = Math.round(((s.jazzcashTotal || 0) - (e.jazzcash || 0)) * 100) / 100;
    const net = Math.round((s.variance + cardOver + jazzOver) * 100) / 100;
    const note =
      `Verified by owner (2026-11-12) with NO salary deduction: cash short Rs ${-s.variance} is card / JazzCash sales rung up as cash ` +
      `(card slip Rs ${s.cardTotal} vs system Rs ${e.card} = +${cardOver}; JazzCash Rs ${s.jazzcashTotal} vs Rs ${e.jazzcash} = +${jazzOver}). ` +
      `All money together: ${net >= 0 ? '+' : ''}${net}.`;
    const existing = await db.collection('payrolldeductions').findOne({ refType: 'CashSession', refId: s._id });

    console.log(`${SESSION_NO} ${s.counterName} ${s.cashierName}: ${s.status}, variance ${s.variance}`);
    console.log(`Card +${cardOver}, JazzCash +${jazzOver}, net ${net}`);
    console.log(`Shortage deduction for this till: ${existing ? `EXISTS ${existing._id} (${existing.status})` : 'none (none will be made)'}`);
    console.log(`Note: ${note}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const now = new Date();
    const r = await db.collection('cashsessions').updateOne(
      { _id: s._id, status: 'closed' },
      {
        $set: { status: 'verified', verifiedBy: null, verifiedAt: now, verifyNote: note, updatedAt: now },
        $push: { history: { at: now, by: null, action: 'verify', note } },
      }
    );
    console.log(`Till verified: ${r.modifiedCount}`);
    if (existing && existing.status === 'pending') {
      await db.collection('payrolldeductions').updateOne(
        { _id: existing._id, status: 'pending' },
        { $set: { status: 'waived', decidedAt: now, note: `${existing.note || ''} | Waived: ${note}`, updatedAt: now } }
      );
      console.log(`Existing shortage deduction waived: ${existing._id}`);
    }
    console.log('Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
