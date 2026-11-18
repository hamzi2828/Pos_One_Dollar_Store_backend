// One-time (owner, 2026-11-17): TILL-2026-00022 (Junaid Ali, Counter 1) was opened late on 16 Nov
// by mistake and has nothing on it; he opens again in the morning. Delete it, renumber
// TILL-2026-00023 (Raja Asim, Counter 2) to TILL-2026-00022, and set the TILL-2026 sequence to 22
// so the next till is 00023. Refuses if 00022 has bills / expenses / is not open. Backed up first.
//
//   node scripts/deleteTill00022.js          -> DRY RUN
//   node scripts/deleteTill00022.js --apply  -> writes

const DB_NAME = 'pos_mirpur_dollar_shop';
const DEL = 'TILL-2026-00022';
const REN = 'TILL-2026-00023';

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

    const del = await db.collection('cashsessions').findOne({ sessionNo: DEL });
    const ren = await db.collection('cashsessions').findOne({ sessionNo: REN });
    if (!del || !ren) throw new Error('Till not found');
    const show = (s) => `${s.sessionNo} ${s.cashierName} ${s.counterName} ${s.status} opened ${s.openedAt.toISOString()}`;
    console.log('Delete :', show(del));
    console.log('Rename :', show(ren), `-> ${DEL}`);
    if (del.status !== 'open') throw new Error(`${DEL} is ${del.status}, expected open`);

    const refs = {};
    for (const c of ['posorders', 'expenses', 'posactivities']) {
      refs[c] = await db.collection(c).countDocuments({ cashSession: del._id });
    }
    console.log('Refs to deleted till:', refs);
    if (refs.posorders || refs.expenses) throw new Error(`${DEL} has bills / expenses, not deleting`);

    // Any other docs naming the numbers as text (notifications etc.)
    const cols = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('_backup'));
    const textHits = [];
    for (const c of cols) {
      for (const no of [DEL, REN]) {
        const n = await db.collection(c).countDocuments({ $or: [{ title: { $regex: no } }, { message: { $regex: no } }, { body: { $regex: no } }] });
        if (n) textHits.push(`${c}: ${n} x ${no}`);
      }
    }
    console.log('Text mentions:', textHits.length ? textHits : 'none');

    const seq = await db.collection('sequences').findOne({ _id: 'TILL-2026' });
    console.log('Sequence TILL-2026:', seq && seq.seq);
    if (!seq || seq.seq !== 23) throw new Error('Sequence is not 23, a newer till exists?');

    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_delete_till00022_${Date.now()}`;
    const delNotes = await db.collection('notifications').find({ 'meta.sessionId': String(del._id) }).toArray();
    const delActs = await db.collection('posactivities').find({ cashSession: del._id }).toArray();
    await db.collection(backup).insertMany([
      { collection: 'cashsessions', originalId: del._id, doc: del },
      { collection: 'cashsessions', originalId: ren._id, doc: ren },
      { collection: 'sequences', originalId: seq._id, doc: seq },
      ...delNotes.map((a) => ({ collection: 'notifications', originalId: a._id, doc: a })),
      ...delActs.map((a) => ({ collection: 'posactivities', originalId: a._id, doc: a })),
    ]);
    console.log(`Backed up to ${backup}`);

    const d = await db.collection('cashsessions').deleteOne({ _id: del._id, status: 'open' });
    if (d.deletedCount !== 1) throw new Error('Delete failed');
    if (delNotes.length) await db.collection('notifications').deleteMany({ _id: { $in: delNotes.map((x) => x._id) } });
    if (delActs.length) await db.collection('posactivities').deleteMany({ cashSession: del._id });
    const u = await db.collection('cashsessions').updateOne({ _id: ren._id, sessionNo: REN }, { $set: { sessionNo: DEL } });
    if (u.modifiedCount !== 1) throw new Error('Rename failed');
    await db.collection('sequences').updateOne({ _id: 'TILL-2026', seq: 23 }, { $set: { seq: 22 } });
    console.log(`Deleted ${DEL}, renamed ${REN} -> ${DEL}, sequence -> 22, ${delNotes.length} alert(s) removed. Done.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
