// Fix a vendor bill on a purchase trip the same way "Edit bill" on the trip page does
// (purchaseOrderService.updateBill: bill row + "paid now" payment in the vendor account,
// goods receipt boxes all follow). Optionally publish a product so the POS can sell it.
//
//   node scripts/editTripBill.js --po PO-2026-00008 --vendor "Niamatullah" --amount 40800 --paid 1000 [--publish 43695]          -> DRY RUN
//   ... --apply                                                                                                                   -> writes
//
// --paid is "paid now" at the market (method stays as on the bill, cash by default; market
// payments never come off a till). Done as the shop's super admin (shown in the trip history).

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
  const vendorText = String(arg(a, '--vendor') || '').trim();
  const amount = Number(arg(a, '--amount'));
  const paid = arg(a, '--paid') !== undefined ? Number(arg(a, '--paid')) : undefined;
  const publish = String(arg(a, '--publish') || '').trim();
  if (!poNumber || !vendorText || !(amount >= 0) || (paid !== undefined && !(paid >= 0))) {
    throw new Error('Usage: --po <PO number> --vendor <vendor name> --amount <bill Rs> [--paid <paid now Rs>] [--publish <product code>] [--apply]');
  }
  if (paid !== undefined && paid > amount) throw new Error('Paid cannot be more than the bill');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const PurchaseOrder = require('../src/models/purchaseOrder');
    const User = require('../src/models/user');
    const Product = require('../src/models/product');
    const VendorLedgerEntry = require('../src/models/vendorLedgerEntry');
    const VendorPayment = require('../src/models/vendorPayment');
    const poService = require('../src/services/purchasing/purchaseOrderService');
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');

    const po = await PurchaseOrder.findOne({ poNumber });
    if (!po) throw new Error(`Trip ${poNumber} not found`);
    const bills = po.bills.filter((b) => new RegExp(escapeRx(vendorText), 'i').test(b.vendorName || ''));
    if (bills.length !== 1) throw new Error(`${bills.length} bills of "${vendorText}" on ${poNumber}`);
    const bill = bills[0];
    const ledger = await VendorLedgerEntry.findOne({ refType: 'PurchaseOrder', refId: bill._id, type: 'bill', isVoided: false }).lean();
    const pay = bill.payment ? await VendorPayment.findOne({ _id: bill.payment }).lean() : null;
    console.log(`Trip ${poNumber} (${po.status}) · bill ${bill.vendorName}`);
    console.log(`  now:  bill amount Rs ${bill.billAmount} (total Rs ${bill.billTotal}) · paid now Rs ${bill.paidNow || 0} ${bill.paidMethod || 'cash'}`);
    console.log(`        vendor account row: ${ledger ? `Rs ${ledger.credit}` : 'none'} · market payment: ${pay ? `Rs ${pay.amount} ${pay.method} (${pay.status})` : 'none'}`);
    console.log(`  will: bill amount Rs ${amount}${paid !== undefined ? ` · paid now Rs ${paid} ${bill.paidMethod || 'cash'}` : ''}`);
    console.log('        (old account row / payment are voided and new ones posted, exactly like Edit bill)');

    let product = null;
    if (publish) {
      const list = await Product.find({ isDeleted: { $ne: true }, $or: [{ shortCode: publish }, { sku: publish }] }).select('name status shortCode stock price').lean();
      if (list.length !== 1) throw new Error(`${list.length} products match ${publish}`);
      product = list[0];
      console.log(`\nProduct ${product.name} (#${product.shortCode}) · status ${product.status} -> published · stock ${product.stock} · price Rs ${product.price}`);
    }

    if (!apply) {
      console.log('\nDry run only. Run again with --apply to write.');
      return;
    }

    const admin = await User.findOne({ isSuperAdmin: true, isActive: { $ne: false } }).select('firstName lastName email').lean();
    if (!admin) throw new Error('No super admin user found');
    const req = {
      user: { _id: admin._id, id: admin._id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email },
      access: { userId: String(admin._id), isSuperAdmin: true, roleName: 'Super Admin', permissions: {}, can: () => true },
    };
    const body = { billAmount: amount };
    if (paid !== undefined) body.paidNow = paid;
    await poService.updateBill(req, po._id, bill._id, body);

    const after = (await PurchaseOrder.findById(po._id)).bills.id(bill._id);
    const ledger2 = await VendorLedgerEntry.findOne({ refType: 'PurchaseOrder', refId: bill._id, type: 'bill', isVoided: false }).lean();
    const pay2 = after.payment ? await VendorPayment.findOne({ _id: after.payment }).lean() : null;
    console.log(`\nBill now: total Rs ${after.billTotal} · paid now Rs ${after.paidNow || 0} · account row Rs ${ledger2 ? ledger2.credit : '-'} · payment ${pay2 ? `Rs ${pay2.amount} ${pay2.method}` : 'none'}`);

    if (product && product.status !== 'published') {
      await Product.updateOne({ _id: product._id }, { $set: { status: 'published' } });
      console.log(`Product ${product.name} published.`);
    }
    console.log('\nDone.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
