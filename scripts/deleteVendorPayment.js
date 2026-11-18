// Permanently delete a DUMMY vendor payment (owner, 2026-11-18: VP-2026-00046).
// Normally a wrong payment is voided; this removes it from the database for good,
// together with its vendor ledger row(s). Vendor balances are computed live from
// the ledger, so nothing else needs recalculating.
// Refuses when a trip bill or consignment settlement still points at it.
// Bank-check lines matched to it are un-matched (they show again as "Not in system"
// until the statement is re-checked).
//
//   node scripts/deleteVendorPayment.js VP-2026-00046            -> DRY RUN
//   node scripts/deleteVendorPayment.js VP-2026-00046 --apply    -> deletes (backup JSON written first)
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const fs = require('fs');
const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';

async function main() {
  const paymentNo = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!paymentNo) throw new Error('Usage: node scripts/deleteVendorPayment.js <paymentNo> [--apply]');

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);

  const pay = await db.collection('vendorpayments').findOne({ paymentNo: paymentNo.trim() });
  if (!pay) throw new Error(`Payment ${paymentNo} not found`);
  console.log(
    `${pay.paymentNo} · ${pay.vendorName} · Rs ${pay.amount} · ${pay.method}${pay.reference ? ` (${pay.reference})` : ''} · ${new Date(pay.date).toISOString().slice(0, 10)} · ${pay.status}${pay.notes ? ` · "${pay.notes}"` : ''}`
  );

  const ledgerFilter = { $or: [{ refType: 'VendorPayment', refId: pay._id }, ...(pay.ledgerEntry ? [{ _id: pay.ledgerEntry }] : [])] };
  const ledgerRows = await db.collection('vendorledgerentries').find(ledgerFilter).toArray();
  console.log(`  ledger rows: ${ledgerRows.length} (${ledgerRows.map((r) => `${r.type} debit ${r.debit}${r.status ? ` ${r.status}` : ''}`).join(', ')})`);

  const pos = await db
    .collection('purchaseorders')
    .find({ $or: [{ payment: pay._id }, { 'bills.payment': pay._id }] })
    .project({ poNumber: 1 })
    .toArray();
  const settlements = await db.collection('consignmentsettlements').find({ payment: pay._id }).project({ settlementNo: 1 }).toArray();
  const bankLines = await db.collection('bankstatementlines').find({ 'match.id': { $in: [pay._id, String(pay._id)] } }).project({ date: 1, amount: 1 }).toArray();
  console.log(`  trips pointing at it: ${pos.length ? pos.map((p) => p.poNumber).join(', ') : 'none'}`);
  console.log(`  consignment settlements: ${settlements.length ? settlements.map((s) => s.settlementNo || s._id).join(', ') : 'none'}`);
  console.log(`  bank-check lines matched to it: ${bankLines.length}`);

  if (pos.length || settlements.length) throw new Error('A trip or consignment settlement uses this payment — not a dummy. Not deleting.');

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Add --apply to delete for good.');
    return;
  }

  const backup = path.join(__dirname, `deleteVendorPayment-backup-${pay.paymentNo}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify({ payment: pay, ledgerRows, bankLines }, null, 2));
  console.log(`  backup: ${backup}`);

  if (bankLines.length) await db.collection('bankstatementlines').updateMany({ _id: { $in: bankLines.map((l) => l._id) } }, { $set: { match: null } });
  if (ledgerRows.length) await db.collection('vendorledgerentries').deleteMany({ _id: { $in: ledgerRows.map((r) => r._id) } });
  await db.collection('vendorpayments').deleteOne({ _id: pay._id });
  console.log(`\nDeleted ${pay.paymentNo}, ${ledgerRows.length} ledger row(s)${bankLines.length ? `, un-matched ${bankLines.length} bank line(s)` : ''}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
