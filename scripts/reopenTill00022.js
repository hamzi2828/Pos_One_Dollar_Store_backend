// One-time (owner, 2026-11-17): Raja Asim closed TILL-2026-00022 (Counter 2) at 22:12 by
// mistake and opened TILL-2026-00025. Move 00025's bills / POS activity to 00022, delete
// 00025 (soft: status 'deleted'), and REOPEN 00022 so Counter 2 keeps selling into it.
// The old close (count Rs 66,800, short Rs 7,100) is kept in 00022's history, then cleared.
// Backed up first.
//
//   node scripts/reopenTill00022.js          -> DRY RUN
//   node scripts/reopenTill00022.js --apply  -> writes

const KEEP = 'TILL-2026-00022';
const DEL = 'TILL-2026-00025';

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    const S = db.collection('cashsessions');
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');
    const keep = await S.findOne({ sessionNo: KEEP });
    const del = await S.findOne({ sessionNo: DEL });
    if (!keep || !del) throw new Error('Till not found');
    if (keep.status !== 'closed') throw new Error(`${KEEP} is ${keep.status}, expected closed`);
    if (del.status !== 'open') throw new Error(`${DEL} is ${del.status}, expected open`);
    if (String(keep.counter) !== String(del.counter) || String(keep.cashier) !== String(del.cashier)) {
      throw new Error('Tills are not the same counter / cashier');
    }

    const moveCols = ['posorders', 'expenses', 'posactivities', 'heldorders', 'offlinesales'];
    const refs = {};
    for (const c of moveCols) refs[c] = await db.collection(c).countDocuments({ cashSession: del._id });
    const notes = await db.collection('notifications').find({ 'meta.sessionId': { $in: [String(keep._id), String(del._id)] } }).toArray();
    console.log(`${KEEP}: closed ${keep.closedAt.toISOString()}, counted ${keep.closingCount && keep.closingCount.total}, variance ${keep.variance}`);
    console.log(`${DEL}: open since ${del.openedAt.toISOString()}`);
    console.log(`Move from ${DEL} -> ${KEEP}:`, refs);
    console.log('Alerts about these tills:', notes.map((n) => `${n.title || n.type}`));
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_reopen_till00022_${Date.now()}`;
    await db.collection(backup).insertMany([
      { collection: 'cashsessions', originalId: keep._id, doc: keep },
      { collection: 'cashsessions', originalId: del._id, doc: del },
      ...notes.map((n) => ({ collection: 'notifications', originalId: n._id, doc: n })),
    ]);
    console.log(`Backed up to ${backup}`);

    for (const c of moveCols) {
      if (refs[c]) await db.collection(c).updateMany({ cashSession: del._id }, { $set: { cashSession: keep._id } });
    }

    const now = new Date();
    // 1) delete 00025 first (only one open till per counter / cashier).
    const d = await S.updateOne(
      { _id: del._id, status: 'open' },
      {
        $set: { status: 'deleted', deletedAt: now, deletedBy: null, deleteReason: `Opened by mistake; ${KEEP} reopened instead` },
        $push: { history: { at: now, by: null, action: 'deleted', note: `Deleted (was open): opened by mistake, bills moved to ${KEEP}` } },
      }
    );
    if (d.modifiedCount !== 1) throw new Error('Delete of 00025 failed');

    // 2) reopen 00022, keeping the old close in its history.
    const old = `Reopened by owner (closed by mistake ${keep.closedAt.toISOString()}; counted Rs ${
      keep.closingCount ? keep.closingCount.total : 0
    }, variance Rs ${keep.variance})`;
    const r = await S.updateOne(
      { _id: keep._id, status: 'closed' },
      {
        $set: {
          status: 'open',
          closedAt: null,
          closedBy: null,
          closingCount: null,
          drawerCount: null,
          dayCash: null, // the close also saved the count here
          dayCashAt: null,
          dayCashNote: '',
          cardTotal: null,
          bankTransferTotal: null,
          jazzcashTotal: null,
          closeNote: '',
          lateClose: false,
          expected: {},
          variance: null,
          verifiedBy: null,
          verifiedAt: null,
          verifyNote: '',
        },
        $unset: { payoutIds: '' },
        $push: { history: { at: now, by: null, action: 'reopened', note: old } },
      }
    );
    if (r.modifiedCount !== 1) throw new Error('Reopen of 00022 failed');
    if (notes.length) await db.collection('notifications').deleteMany({ _id: { $in: notes.map((n) => n._id) } });
    console.log(`Done: ${DEL} deleted, ${KEEP} open again, ${notes.length} alert(s) removed.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
