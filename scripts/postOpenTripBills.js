// One-time (safe to re-run): put the bills of purchase trips that are still
// OPEN into the vendor accounts. Since 2026-10-30 a bill counts in the vendor
// account as soon as it is added; trips started before that only posted on
// "Send to warehouse". Uses the same code as the app (syncBillAccounts), so a
// second run changes nothing.
//
//   node scripts/postOpenTripBills.js            -> DRY RUN, lists what would be posted
//   node scripts/postOpenTripBills.js --apply    -> writes
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';

async function main() {
  const apply = process.argv.includes('--apply');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${dbName}" (expected ${EXPECTED_DB})`);

  const PurchaseOrder = require('../src/models/purchaseOrder');
  const User = require('../src/models/user');
  const VendorLedgerEntry = require('../src/models/vendorLedgerEntry');
  const { syncBillAccounts } = require('../src/services/purchasing/purchaseOrderService');

  // Postings are recorded as done by the owner (first active super admin).
  const owner = await User.findOne({ isSuperAdmin: true, isActive: { $ne: false } }).select('_id email').lean();
  if (!owner) throw new Error('No active super admin found');
  const req = { access: { userId: String(owner._id), isSuperAdmin: true, can: () => true }, user: { _id: owner._id } };

  const open = await PurchaseOrder.find({ status: 'open' }).sort({ createdAt: 1 });
  console.log(`${dbName}: ${open.length} open trip(s). ${apply ? 'APPLYING' : 'DRY RUN (add --apply to write)'}`);
  let toPost = 0;
  for (const po of open) {
    for (const bill of po.bills) {
      const live = await VendorLedgerEntry.exists({ refType: 'PurchaseOrder', refId: bill._id, type: 'bill', isVoided: false });
      const line = `  ${po.poNumber} · ${bill.vendorName} ${bill.billNo || '(no bill no.)'} · bill Rs ${bill.billTotal} · paid now Rs ${bill.paidNow || 0}`;
      if (live && (!(bill.paidNow > 0) || bill.payment)) console.log(`${line} · already in the account`);
      else {
        toPost += 1;
        console.log(`${line} · ${apply ? 'posting' : 'would post'}`);
      }
    }
    if (apply) await syncBillAccounts(req, po);
  }
  console.log(`${toPost} bill(s) ${apply ? 'posted' : 'to post'}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message || err);
  try {
    await require('../src/config/mongo').mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
