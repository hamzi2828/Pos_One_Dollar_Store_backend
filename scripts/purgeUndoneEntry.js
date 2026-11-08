// Permanently delete an UNDONE goods-receipt entry (owner, 2026-11-08).
// "Undo" on Receive Goods only hides an entry; this removes it from the
// database for good, together with what belongs only to it:
//   - the entry itself (GoodsReceipt.entries[])
//   - its sticker print-log rows (same product + vendor bill), only when no
//     other live entry of that product is on that bill
//   - with --movements: its two stock movements (the receipt and the undo,
//     which cancel each other out, so stock stays the same)
// Refuses entries that are not undone.
//
//   node scripts/purgeUndoneEntry.js <grnId> <productName or entryNo>           -> DRY RUN, shows what would go
//   node scripts/purgeUndoneEntry.js <grnId> <productName or entryNo> --apply   -> deletes (cannot be undone)
//   add --movements to also delete the two stock movements
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  const withMoves = process.argv.includes('--movements');
  const [grnId, which] = args;
  if (!grnId || !which) throw new Error('Usage: node scripts/purgeUndoneEntry.js <grnId> <productName or entryNo> [--apply] [--movements]');

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);
  const { ObjectId } = mongoose.Types;

  const grn = await db.collection('goodsreceipts').findOne({ _id: new ObjectId(grnId) });
  if (!grn) throw new Error(`Goods receipt ${grnId} not found`);
  const byNo = /^\d+$/.test(which) ? Number(which) : null;
  const matches = (grn.entries || []).filter((e) =>
    byNo !== null ? e.entryNo === byNo : String(e.productName || '').trim().toLowerCase() === which.trim().toLowerCase()
  );
  if (!matches.length) throw new Error(`No entry "${which}" on ${grn.grnNumber}`);
  if (matches.length > 1) throw new Error(`${matches.length} entries match "${which}" on ${grn.grnNumber}; use the entry number instead: ${matches.map((e) => e.entryNo).join(', ')}`);
  const entry = matches[0];
  if (!entry.undone) throw new Error(`Entry ${entry.entryNo} (${entry.productName}) is NOT undone. Press Undo on Receive Goods first.`);

  console.log(`${grn.grnNumber} (${grn.poNumber}) · entry ${entry.entryNo}: ${entry.productName} · ${entry.qty} pcs × Rs ${entry.costPrice} · ${entry.vendorName} · undone ${entry.undoneAt ? new Date(entry.undoneAt).toISOString() : ''}`);

  // Print-log rows: same product + bill, only if nothing else of that product is live on the bill.
  const otherLive = (grn.entries || []).some(
    (e) => !e.undone && String(e._id) !== String(entry._id) && String(e.product) === String(entry.product) && String(e.bill) === String(entry.bill) && String(e.variantId || '') === String(entry.variantId || '')
  );
  const printFilter = { product: entry.product, bill: entry.bill, variantId: entry.variantId || null };
  const prints = otherLive ? [] : await db.collection('labelprints').find(printFilter).project({ count: 1, mode: 1, createdAt: 1 }).toArray();
  console.log(otherLive ? '  print log: kept (another live entry of this product is on the bill)' : `  print-log rows: ${prints.length}${prints.length ? ` (${prints.map((p) => `${p.mode} ${p.count}`).join(', ')})` : ''}`);

  const moveFilter = {
    refType: 'GoodsReceipt',
    refId: grn._id,
    note: { $regex: `^GRN entry ${entry.entryNo} (undone )?·` },
  };
  const moves = await db.collection('stockmovements').find(moveFilter).project({ type: 1, qtyChange: 1, note: 1 }).toArray();
  const net = moves.reduce((t, m) => t + (Number(m.qtyChange) || 0), 0);
  console.log(`  stock movements: ${moves.length} (${moves.map((m) => `${m.type} ${m.qtyChange}`).join(', ')}) net ${net} · ${withMoves ? 'WILL be deleted' : 'kept (add --movements to delete)'}`);
  if (withMoves && net !== 0) throw new Error('These stock movements do not cancel out (net is not 0). Not deleting them.');

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Add --apply to delete for good.');
    return;
  }
  await db.collection('goodsreceipts').updateOne({ _id: grn._id }, { $pull: { entries: { _id: entry._id } } });
  if (prints.length) await db.collection('labelprints').deleteMany({ _id: { $in: prints.map((p) => p._id) } });
  if (withMoves && moves.length) await db.collection('stockmovements').deleteMany({ _id: { $in: moves.map((m) => m._id) } });
  console.log(`\nDeleted: entry ${entry.entryNo}${prints.length ? `, ${prints.length} print-log rows` : ''}${withMoves && moves.length ? `, ${moves.length} stock movements` : ''}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
