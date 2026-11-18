// One-time (owner, 2026-11-12): TILL-2026-00001 (Counter 1, 5 Nov) still showed "Short Rs 14,550" after
// verifyTill00001.js. The short is card / JazzCash sales rung up as cash (which bills is unknown), so the
// till's expected figures are moved to what was really received:
//   expected.card     117,600 -> card slip      (cardTotal)
//   expected.jazzcash   9,900 -> JazzCash total (jazzcashTotal)
//   expected.cashSales / expectedCash down by the same amount -> variance = counted - expectedCash
// Bills are NOT changed (till-level correction; bill reports still show them as cash). The till is
// verified, so nothing recomputes it. Backed up first.
//
//   node scripts/reclassTill00001.js          -> DRY RUN
//   node scripts/reclassTill00001.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const SESSION_NO = 'TILL-2026-00001';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
    if (s.status !== 'verified') throw new Error(`Till is ${s.status}, expected verified`);
    if (s.reclassified) throw new Error('Already done');
    const e = s.expected;
    const cardMove = r2(s.cardTotal - e.card);
    const jazzMove = r2(s.jazzcashTotal - e.jazzcash);
    if (!(cardMove > 0) || !(jazzMove >= 0)) throw new Error('Nothing to move');
    const move = r2(cardMove + jazzMove);
    const cashSales = r2(e.cashSales - move);
    const expectedCash = r2(e.expectedCash - move);
    const variance = r2(s.closingCount.total - expectedCash);
    const note =
      `Owner 2026-11-12: Rs ${move} rung up as cash was really card (+${cardMove}) / JazzCash (+${jazzMove}); ` +
      `expected cash ${e.expectedCash} -> ${expectedCash}, card ${e.card} -> ${s.cardTotal}, JazzCash ${e.jazzcash} -> ${s.jazzcashTotal}. ` +
      `Short ${-s.variance} -> ${variance >= 0 ? `over ${variance}` : `short ${-variance}`}. Bills not changed (which ones unknown).`;

    console.log(`${SESSION_NO}: ${note}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_reclass_till00001_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'cashsessions', originalId: s._id, doc: s });
    console.log(`Backed up to ${backup}`);
    const now = new Date();
    const r = await db.collection('cashsessions').updateOne(
      { _id: s._id, status: 'verified', variance: s.variance },
      {
        $set: {
          'expected.cashSales': cashSales,
          'expected.expectedCash': expectedCash,
          'expected.card': s.cardTotal,
          'expected.jazzcash': s.jazzcashTotal,
          variance,
          reclassified: { at: now, cash: -move, card: cardMove, jazzcash: jazzMove, note },
          verifyNote: `${s.verifyNote || ''}\n${note}`.trim(),
          updatedAt: now,
        },
        $push: { history: { at: now, by: null, action: 'note', note } },
      }
    );
    console.log(`Till updated: ${r.modifiedCount}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
