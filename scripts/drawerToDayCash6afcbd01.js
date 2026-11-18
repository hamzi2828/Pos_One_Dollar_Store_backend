// One-time (owner, 2026-11-18): till 6afcbd01703835aa7f238734 had the day's cash (Rs 231,550) saved as
// "left in the drawer" by mistake. The float is 0, so nothing was left in the drawer: move the notes to
// dayCash and set drawerCount to 0. closingCount (= drawer + day cash) and variance stay the same.
// Backed up first.
//
//   node scripts/drawerToDayCash6afcbd01.js          -> DRY RUN
//   node scripts/drawerToDayCash6afcbd01.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const ID = '6afcbd01703835aa7f238734';

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

    const s = await db.collection('cashsessions').findOne({ _id: new mongoose.Types.ObjectId(ID) });
    if (!s) throw new Error('Till not found');
    const show = (c) => (c ? JSON.stringify({ total: c.total, denominations: c.denominations }) : 'null');
    console.log(`${s.sessionNo} status=${s.status} float=${s.openingFloat && s.openingFloat.total} variance=${s.variance}`);
    console.log(`  closingCount ${show(s.closingCount)}`);
    console.log(`  drawerCount  ${show(s.drawerCount)}`);
    console.log(`  dayCash      ${show(s.dayCash)}`);

    const drawer = s.drawerCount || s.closingCount;
    if (!drawer || !(drawer.total > 0)) throw new Error('Nothing in the drawer to move');
    if (s.dayCash && s.dayCash.total > 0) throw new Error('Day cash already set; not merging blindly');
    if (s.openingFloat && s.openingFloat.total > 0) throw new Error('Float is not 0; check by hand');

    const now = new Date();
    const dayCash = { denominations: drawer.denominations || {}, total: drawer.total };
    const note = `Owner 2026-11-18: Rs ${drawer.total} was saved as "left in the drawer" by mistake; moved to the day's cash (float is 0).`;
    console.log(`\nWill set drawerCount -> 0, dayCash -> Rs ${dayCash.total}. closingCount and variance unchanged.`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_drawer_to_daycash_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'cashsessions', originalId: s._id, doc: s });
    console.log(`Backed up to ${backup}`);
    const r = await db.collection('cashsessions').updateOne(
      { _id: s._id, dayCash: s.dayCash ?? null },
      {
        $set: {
          drawerCount: { denominations: {}, total: 0 },
          dayCash,
          dayCashAt: s.dayCashAt || s.closedAt || now,
          ...(s.closingCount ? {} : { closingCount: dayCash }),
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
