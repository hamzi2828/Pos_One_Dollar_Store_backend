// Put stock that is ALREADY in the shop under a vendor bill of a purchase trip,
// without adding the pieces again (owner 2026-11-14: Mix Key Chain 43695 under
// PO-2026-00008 / Niamatullah keychains basement).
//
//   node scripts/linkStockToGrn.js --code 43695 --po PO-2026-00008 --vendor "Niamatullah" --qty 204 --cost 200          -> DRY RUN
//   ... --apply                                                                                                          -> writes
//
// What it does:
//   1. adds an entry to the trip's goods receipt (Receive Goods → that vendor) for the product:
//      qty, cost, value = qty × cost, marked as already in stock (posted) so NO stock is added;
//   2. the stock row that brought these pieces in (opening / adjustment / receipt with no trip)
//      is pointed at that goods receipt and vendor, so the stock ledger shows where they came from;
//   3. the product's vendor / last purchase price follow the bill;
//   4. stickers already printed for the product outside receiving (no bill) move to this bill,
//      so Receive Goods shows them as printed (same code, nothing to reprint).
// It does NOT change the bill amount or what was paid: use "Edit bill" on the trip page
// (that keeps the vendor's account right).
// Refuses when: the product is already entered on that bill, more than one bill matches
// the vendor, the goods receipt is finished / cancelled, or the stock row is unclear
// (then it shows the rows and stops; pass --movement <id> to choose one, or --no-movement).

const DB_NAME = 'pos_mirpur_dollar_shop';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const a = process.argv.slice(2);
  const apply = a.includes('--apply');
  const code = String(arg(a, '--code') || '').trim();
  const poNumber = String(arg(a, '--po') || '').trim();
  const vendorText = String(arg(a, '--vendor') || '').trim();
  const qty = Number(arg(a, '--qty'));
  const cost = Number(arg(a, '--cost'));
  const movementArg = arg(a, '--movement');
  const noMovement = a.includes('--no-movement');
  if (!code || !poNumber || !vendorText || !Number.isInteger(qty) || qty < 1 || !(cost > 0)) {
    throw new Error('Usage: --code <short code> --po <PO number> --vendor <vendor name> --qty <pieces> --cost <Rs per piece> [--movement <id> | --no-movement] [--apply]');
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');

    // ---- product
    const products = await db
      .collection('products')
      .find({ isDeleted: { $ne: true }, $or: [{ shortCode: code }, { sku: code }, { scanCodes: code.toUpperCase() }] })
      .toArray();
    if (products.length !== 1) throw new Error(`${products.length} products match code ${code}`);
    const p = products[0];
    console.log(`Product: ${p.name} (#${p.shortCode || ''}, SKU ${p.sku || '-'}) · stock ${p.stock} · status ${p.status} · cost ${p.costPrice} · price ${p.price}`);
    if ((p.variants || []).length) throw new Error('Product has variants; not handled here');

    // ---- trip + vendor bill
    const po = await db.collection('purchaseorders').findOne({ poNumber });
    if (!po) throw new Error(`Trip ${poNumber} not found`);
    const bills = (po.bills || []).filter((b) => new RegExp(escapeRx(vendorText), 'i').test(b.vendorName || ''));
    if (bills.length !== 1) throw new Error(`${bills.length} bills of "${vendorText}" on ${poNumber}: ${bills.map((b) => b.vendorName).join(', ')}`);
    const bill = bills[0];
    console.log(`Trip ${poNumber} (${po.status}) · bill ${bill.vendorName} · bill total Rs ${bill.billTotal} · paid now Rs ${bill.paidNow || 0} · ${bill.cartons || 0} box/pack`);

    // ---- goods receipt
    const grn = await db.collection('goodsreceipts').findOne({ purchaseOrder: po._id });
    if (!grn) throw new Error(`${poNumber} has no goods receipt yet (send it to the warehouse first)`);
    if (['completed', 'cancelled'].includes(grn.status)) throw new Error(`Goods receipt ${grn.grnNumber} is ${grn.status}`);
    const same = (grn.entries || []).filter((e) => !e.undone && String(e.bill) === String(bill._id) && String(e.product) === String(p._id));
    if (same.length) throw new Error(`${p.name} is already entered on this bill (entry ${same.map((e) => e.entryNo).join(', ')})`);
    const boxes = (grn.boxes || []).find((b) => String(b.bill) === String(bill._id));
    console.log(`Goods receipt ${grn.grnNumber} (${grn.status}) · charge rate ${grn.chargeRate ?? 0} · ${grn.entries.length} entries · boxes ${boxes ? `${boxes.received}/${boxes.expected}` : '-'}`);

    // ---- the stock row that brought these pieces in
    const ins = await db
      .collection('stockmovements')
      .find({ product: p._id, direction: 'in' })
      .sort({ occurredAt: 1 })
      .toArray();
    console.log(`\nStock rows IN for this product (${ins.length}):`);
    ins.forEach((m) =>
      console.log(`  ${m._id}  ${new Date(m.occurredAt || m.createdAt).toISOString()}  ${m.type}  +${m.quantity}  ref ${m.refType || '-'} ${m.refNo || ''}  cost ${m.unitCost ?? '-'}  "${m.note || ''}"`)
    );
    let movement = null;
    if (movementArg) {
      movement = ins.find((m) => String(m._id) === String(movementArg));
      if (!movement) throw new Error(`Stock row ${movementArg} is not an IN row of this product`);
    } else if (!noMovement) {
      const free = ins.filter((m) => m.refType !== 'GoodsReceipt' && m.quantity === qty);
      if (free.length !== 1) {
        throw new Error(
          `Found ${free.length} stock rows of exactly +${qty} not from a trip. Pick one with --movement <id>, or --no-movement to only add the entry.`
        );
      }
      movement = free[0];
    }
    if (movement && movement.refType === 'GoodsReceipt') throw new Error(`Stock row ${movement._id} already belongs to ${movement.refNo}`);

    // ---- the entry (same shape as Receive Goods makes; already posted = no stock added)
    const entryNo = (grn.entrySeq || 0) + 1;
    const landedUnitCost = round2(cost * (1 + (Number(grn.chargeRate) || 0)));
    const entry = {
      _id: new ObjectId(),
      entryNo,
      requestId: '',
      bill: bill._id,
      vendor: bill.vendor,
      vendorName: bill.vendorName,
      billNo: bill.billNo || '',
      product: p._id,
      variantId: null,
      productName: p.name,
      code: p.shortCode || '',
      batchCode: '',
      salePrice: Number(p.price) || 0,
      qty,
      boxNo: boxes && boxes.expected === 1 ? 1 : 0,
      piecesPerSale: Math.max(1, Math.floor(Number(p.piecesPerSale) || 1)),
      damagedQty: 0,
      stockQty: qty,
      costPrice: cost,
      landedUnitCost,
      value: round2(qty * cost),
      line: null,
      lineQty: 0,
      lineDamaged: 0,
      posted: true,
      postedAt: new Date(),
      movement: movement ? movement._id : null,
      shelved: 0,
      shelf: null,
      shelfCode: '',
      createdBy: null,
      createdByName: 'script: linkStockToGrn',
      createdAt: new Date(),
      undone: false,
    };
    const tag = `GRN entry ${entryNo} ·`;

    console.log(`\nWill add to ${grn.grnNumber}, bill ${bill.vendorName}:`);
    console.log(`  entry ${entryNo}: ${p.name} × ${qty} at Rs ${cost} = Rs ${entry.value} (landed Rs ${landedUnitCost}) · already in stock: NO stock added`);
    if (movement) console.log(`  stock row ${movement._id} (${movement.type} +${movement.quantity}) -> ref ${grn.grnNumber}, vendor ${bill.vendorName}`);
    else console.log('  no stock row is changed');
    console.log(`  product vendor -> ${bill.vendorName}, last purchase price -> Rs ${cost}`);
    console.log(`  stock stays ${p.stock}`);
    // Stickers already printed for this product outside receiving (bill = none): they belong to
    // these pieces, so they move to this bill (the entry then shows "printed N of qty", no reprint).
    const prints = await db
      .collection('labelprints')
      .find({ product: p._id, variantId: null, bill: null, ignored: { $ne: true } })
      .sort({ createdAt: 1 })
      .toArray();
    const printedN = prints.reduce((t, x) => t + (Number(x.count) || 0), 0);
    console.log(`  sticker prints with no bill: ${prints.length} row(s), ${printedN} sticker(s) -> moved to this bill`);
    prints.forEach((x) => console.log(`    ${x._id}  ${new Date(x.createdAt).toISOString()}  ${x.count} x "${x.code || ''}"  ${x.mode}  ${x.userName || ''}`));
    console.log(`\nNot changed: bill total Rs ${bill.billTotal}, paid Rs ${bill.paidNow || 0}. Fix those with "Edit bill" on the trip page.`);

    if (!apply) {
      console.log('\nDry run only. Run again with --apply to write.');
      return;
    }

    const backup = { at: new Date(), grnEntrySeq: grn.entrySeq, movement, printIds: prints.map((x) => x._id), product: { vendor: p.vendor, lastVendorName: p.lastVendorName, lastPurchasePrice: p.lastPurchasePrice } };
    const fs = require('fs');
    const bfile = path.join(__dirname, `linkStockToGrn-backup-${code}-${Date.now()}.json`);
    fs.writeFileSync(bfile, JSON.stringify(backup, null, 2));
    console.log(`\nBackup: ${bfile}`);

    // Entry (guarded on entrySeq so a parallel Receive Goods save can't take the same number).
    const r = await db.collection('goodsreceipts').updateOne(
      { _id: grn._id, entrySeq: grn.entrySeq || 0 },
      { $push: { entries: entry }, $set: { entrySeq: entryNo, updatedAt: new Date() } }
    );
    if (r.modifiedCount !== 1) throw new Error('Goods receipt changed meanwhile (someone is entering goods). Run again.');
    if (movement) {
      await db.collection('stockmovements').updateOne(
        { _id: movement._id },
        {
          $set: {
            refType: 'GoodsReceipt',
            refId: grn._id,
            refNo: grn.grnNumber,
            vendor: bill.vendor,
            purchasePrice: cost,
            note: `${tag} ${bill.vendorName} · ${poNumber} (linked by script; was: ${movement.type} ${movement.refNo || ''} "${movement.note || ''}")`,
          },
        }
      );
    }
    if (prints.length) {
      await db.collection('labelprints').updateMany(
        { _id: { $in: prints.map((x) => x._id) }, bill: null },
        { $set: { bill: bill._id, note: `moved to ${poNumber} ${bill.vendorName} by script` } }
      );
    }
    await db.collection('products').updateOne(
      { _id: p._id },
      { $set: { vendor: bill.vendor, lastPurchasePrice: cost, lastVendorName: bill.vendorName } }
    );
    console.log(`\nDone: entry ${entryNo} added to ${grn.grnNumber}. Stock unchanged (${p.stock}). ${printedN} printed sticker(s) now count on this bill.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
