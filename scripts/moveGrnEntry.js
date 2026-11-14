// Move an item entered on the WRONG vendor bill of a trip's goods receipt to the right one
// (owner 2026-11-14: Tomato Ketchup 26266 from Jan Dollar mart to Prime traders on PO-2026-00008).
//
//   node scripts/moveGrnEntry.js --po PO-2026-00008 --code 26266 --from "Jan Dollar" --to "Prime traders"          -> DRY RUN
//   ... --apply                                                                                                    -> writes
//
// Stock, quantities, cost and landed cost stay the same. Changes:
//   - the goods-receipt entry: bill / vendor / bill no / box (1 when the new bill has one box);
//   - its stock row (purchase receipt): vendor + note;
//   - printed stickers counted on the old bill move to the new one (labelPrintLog.moveBetweenBills);
//   - the product's vendor / last vendor name.
// Refuses: finished / cancelled receipt, entry ticking an expected (typed) item, more than one
// matching entry or bill.

const DB_NAME = 'pos_mirpur_dollar_shop';
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const a = process.argv.slice(2);
  const apply = a.includes('--apply');
  const poNumber = String(arg(a, '--po') || '').trim();
  const code = String(arg(a, '--code') || '').trim();
  // --from optional: the bill the item is entered on now. --to <vendor name> or --to-bill <bill id>
  // (the "vendor=" id in the Receive Goods link).
  const fromText = String(arg(a, '--from') || '').trim();
  const toText = String(arg(a, '--to') || '').trim();
  const toBillId = String(arg(a, '--to-bill') || '').trim();
  if (!poNumber || !code || (!toText && !toBillId)) throw new Error('Usage: --po <PO> --code <product code> [--from <vendor>] (--to <vendor> | --to-bill <bill id>) [--apply]');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');

    const products = await db.collection('products').find({ isDeleted: { $ne: true }, $or: [{ shortCode: code }, { sku: code }, { scanCodes: code.toUpperCase() }] }).toArray();
    if (products.length !== 1) throw new Error(`${products.length} products match ${code}`);
    const p = products[0];
    const po = await db.collection('purchaseorders').findOne({ poNumber });
    if (!po) throw new Error(`Trip ${poNumber} not found`);
    const billOf = (text) => {
      const list = (po.bills || []).filter((b) => new RegExp(escapeRx(text), 'i').test(b.vendorName || ''));
      if (list.length !== 1) throw new Error(`${list.length} bills match "${text}" on ${poNumber}`);
      return list[0];
    };
    const to = toBillId ? (po.bills || []).find((b) => String(b._id) === toBillId) : billOf(toText);
    if (!to) throw new Error(`Bill ${toBillId} not on ${poNumber}`);
    const grn = await db.collection('goodsreceipts').findOne({ purchaseOrder: po._id });
    if (!grn) throw new Error('No goods receipt');
    if (['completed', 'cancelled'].includes(grn.status)) throw new Error(`Goods receipt ${grn.grnNumber} is ${grn.status}`);
    const fromBill = fromText ? billOf(fromText) : null;
    const entries = (grn.entries || []).filter(
      (x) => !x.undone && String(x.product) === String(p._id) && String(x.bill) !== String(to._id) && (!fromBill || String(x.bill) === String(fromBill._id))
    );
    if (entries.length !== 1) throw new Error(`${entries.length} entries of ${p.name} to move (name the old vendor with --from)`);
    const e = entries[0];
    const from = (po.bills || []).find((b) => String(b._id) === String(e.bill));
    if (!from) throw new Error('The bill of the entry is not on the trip');
    if (e.line) throw new Error('The entry ticks an expected (typed) item of the old bill; not handled here');
    const toBoxes = (grn.boxes || []).find((b) => String(b.bill) === String(to._id));
    const boxNo = toBoxes && (toBoxes.received || toBoxes.expected) === 1 ? 1 : 0;
    const prints = await db
      .collection('labelprints')
      .aggregate([{ $match: { product: p._id, variantId: e.variantId || null, bill: from._id, ignored: { $ne: true } } }, { $group: { _id: null, n: { $sum: '$count' } } }])
      .toArray();
    const printed = (prints[0] && prints[0].n) || 0;
    const mv = e.movement ? await db.collection('stockmovements').findOne({ _id: e.movement }) : null;

    console.log(`${grn.grnNumber} (${grn.status}) · ${p.name} (#${p.shortCode}) · stock ${p.stock}`);
    console.log(`Entry ${e.entryNo}: ${e.qty} pcs at Rs ${e.costPrice} (landed ${e.landedUnitCost}) = Rs ${e.value} · box ${e.boxNo || '-'}`);
    console.log(`  from: ${from.vendorName} (bill Rs ${from.billTotal})`);
    console.log(`  to:   ${to.vendorName} (bill Rs ${to.billTotal}) · box ${boxNo || '-'}`);
    console.log(`  stock row: ${mv ? `${mv.type} +${mv.quantity} (vendor -> ${to.vendorName})` : 'none'}`);
    console.log(`  printed stickers on the old bill: ${printed} -> moved with it`);
    console.log(`  product vendor -> ${to.vendorName}`);
    console.log('  stock, qty, cost: unchanged');
    if (!apply) return console.log('\nDry run only. Run again with --apply to write.');

    const fs = require('fs');
    const bfile = path.join(__dirname, `moveGrnEntry-backup-${code}-${Date.now()}.json`);
    fs.writeFileSync(bfile, JSON.stringify({ grnId: grn._id, entry: e, movement: mv, product: { vendor: p.vendor, lastVendorName: p.lastVendorName } }, null, 2));
    console.log(`\nBackup: ${bfile}`);

    const r = await db.collection('goodsreceipts').updateOne(
      { _id: grn._id, 'entries._id': e._id, 'entries.bill': from._id },
      {
        $set: {
          'entries.$.bill': to._id,
          'entries.$.vendor': to.vendor,
          'entries.$.vendorName': to.vendorName,
          'entries.$.billNo': to.billNo || '',
          'entries.$.boxNo': boxNo,
          updatedAt: new Date(),
        },
      }
    );
    if (r.modifiedCount !== 1) throw new Error('Entry changed meanwhile; nothing else written');
    if (mv) {
      await db.collection('stockmovements').updateOne(
        { _id: mv._id },
        { $set: { vendor: to.vendor, note: String(mv.note || '').replace(from.vendorName, to.vendorName) || `${to.vendorName} · ${poNumber}` } }
      );
    }
    if (printed > 0) {
      require('../src/models/labelPrint');
      const labelPrintLog = require('../src/services/labelPrintLog');
      const n = await labelPrintLog.moveBetweenBills({
        productId: p._id,
        variantId: e.variantId || null,
        fromBill: from._id,
        toBill: to._id,
        count: printed,
        userName: 'script: moveGrnEntry',
        fromName: from.vendorName,
        toName: to.vendorName,
      });
      console.log(`Stickers moved: ${n}`);
    }
    await db.collection('products').updateOne({ _id: p._id }, { $set: { vendor: to.vendor, lastVendorName: to.vendorName } });
    console.log(`Done: ${p.name} now under ${to.vendorName}. Stock unchanged (${p.stock}).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
