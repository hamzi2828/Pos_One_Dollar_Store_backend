// One-time (owner, 2026-11-17): 16 Nov card settlement was Rs 18,610 but the two tills showed
// Rs 26,400 card. Bill POS-20261116-291854-4273 (Rs 7,800, Counter 1, TILL-2026-00020) was rung up as
// card but paid in cash (Counter 1 was over by exactly Rs 7,800). Bill -> cash; the till's expected card
// moves to expected cash, cardTotal 13,200 -> 5,400, variance recomputed. Backed up first.
//
//   node scripts/cardToCash20261116.js          -> DRY RUN
//   node scripts/cardToCash20261116.js --apply  -> writes
const DB_NAME = 'pos_mirpur_dollar_shop';
const ORDER_NO = 'POS-20261116-291854-4273';
const SESSION_NO = 'TILL-2026-00020';
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
    const o = await db.collection('posorders').findOne({ orderNumber: ORDER_NO });
    const s = await db.collection('cashsessions').findOne({ sessionNo: SESSION_NO });
    if (!o || !s) throw new Error('Not found');
    if (o.paymentMethod !== 'card' || String(o.cashSession) !== String(s._id)) throw new Error('Bill not card on this till (done already?)');
    if (s.status === 'verified') throw new Error('Till already verified');
    const amt = o.total;
    const e = s.expected;
    const exp = {
      'expected.cashSales': r2(e.cashSales + amt),
      'expected.expectedCash': r2(e.expectedCash + amt),
      'expected.card': r2(e.card - amt),
      cardTotal: r2(s.cardTotal - amt),
    };
    const variance = r2(s.closingCount.total - exp['expected.expectedCash']);
    console.log(`Bill ${ORDER_NO} Rs ${amt}: card -> cash`);
    console.log(`${SESSION_NO}: expected cash ${e.expectedCash} -> ${exp['expected.expectedCash']}, card ${e.card} -> ${exp['expected.card']}, ` +
      `cardTotal ${s.cardTotal} -> ${exp.cardTotal}, variance ${s.variance} -> ${variance}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_card_to_cash_20261116_${Date.now()}`;
    await db.collection(backup).insertMany([
      { collection: 'posorders', originalId: o._id, doc: o },
      { collection: 'cashsessions', originalId: s._id, doc: s },
    ]);
    console.log(`Backed up to ${backup}`);
    const now = new Date();
    const r1 = await db.collection('posorders').updateOne(
      { _id: o._id, paymentMethod: 'card' },
      {
        $set: { paymentMethod: 'cash', cashAmount: amt, changeGiven: 0, 'paymentHistory.$[p].paymentMethod': 'cash', updatedAt: now },
        $unset: { cardAmount: '' },
      },
      { arrayFilters: [{ 'p.paymentMethod': 'card' }] }
    );
    const note = `Owner 2026-11-17: bill ${ORDER_NO} Rs ${amt} was cash, not card (card settlement Rs 18,610). Card ${s.cardTotal} -> ${exp.cardTotal}, variance ${s.variance} -> ${variance}.`;
    const r3 = await db.collection('cashsessions').updateOne(
      { _id: s._id, variance: s.variance },
      { $set: { ...exp, variance, updatedAt: now }, $push: { history: { at: now, by: null, action: 'correction', note } } }
    );
    console.log(`posorders ${r1.modifiedCount}, cashsessions ${r3.modifiedCount}. Done.`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
