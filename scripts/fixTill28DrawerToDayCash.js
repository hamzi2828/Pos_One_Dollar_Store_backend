// TILL-2026-00028 (Counter 2, Haider Ali, 19 Nov 2026): the Rs 195,000 counted at close
// was cash GIVEN (day's cash), not change left in the drawer. Float was Rs 0.
// A later day-cash entry added it again, so counted shows Rs 390,000.
// This sets drawer = 0, day's cash = 195,000, counted = 195,000, variance = counted - expected.
//
//   node scripts/fixTill28DrawerToDayCash.js            -> DRY RUN
//   node scripts/fixTill28DrawerToDayCash.js --apply    -> writes
//
// Run inside the Coolify backend container (its MONGO_URI is the live DB). Safe to run again.

const DB_NAME = 'pos_mirpur_dollar_shop';
const ID = '6afdea5c7515c6b29f92c015';
const NOTES = { 500: 40, 1000: 90, 5000: 17 }; // = 195,000
const TOTAL = 195000;

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const col = mongoose.connection.db.collection('cashsessions');
    const _id = new mongoose.Types.ObjectId(ID);
    const s = await col.findOne({ _id });
    if (!s || s.sessionNo !== 'TILL-2026-00028') throw new Error('TILL-2026-00028 not found');
    const tot = (c) => (c && Number(c.total)) || 0;
    const show = (x) =>
      `status ${x.status} | drawer Rs ${tot(x.drawerCount)} | day's cash Rs ${tot(x.dayCash)} | counted Rs ${tot(x.closingCount)} | expected Rs ${x.expected && x.expected.expectedCash} | variance ${x.variance}`;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');
    console.log('Now:  ', show(s));
    if (tot(s.drawerCount) === 0 && tot(s.closingCount) === TOTAL) return console.log('\nAlready fixed.');
    if (s.status !== 'closed') throw new Error(`Till is ${s.status}, expected closed`);
    if (tot(s.drawerCount) !== TOTAL) throw new Error(`Drawer is Rs ${tot(s.drawerCount)}, expected Rs ${TOTAL}. Not touching it.`);
    const expected = Number(s.expected && s.expected.expectedCash) || 0;
    if (!expected) throw new Error('Expected cash is 0 / missing. Not touching it.');
    const set = {
      drawerCount: { denominations: {}, total: 0 },
      dayCash: { denominations: NOTES, total: TOTAL },
      dayCashAt: s.dayCashAt || new Date(),
      closingCount: { denominations: NOTES, total: TOTAL },
      variance: Math.round((TOTAL - expected) * 100) / 100,
    };
    console.log('After:', show({ ...s, ...set }));
    if (apply) {
      await col.updateOne(
        { _id, status: 'closed' },
        {
          $set: set,
          $push: {
            history: { at: new Date(), by: null, action: 'day_cash', note: "Admin correction: Rs 195,000 was cash given, not left in drawer. Drawer set to Rs 0." },
          },
        }
      );
      console.log('Saved:', show(await col.findOne({ _id })));
    } else console.log('\nDry run only. Run again with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
