// Fix a bill that was paid part cash, part card but rung up with one method.
//
//   node scripts/fixSplitPayment.js --order POS-20261111-736637-2618 --cash 1500 --card 600            -> DRY RUN
//   node scripts/fixSplitPayment.js --order POS-20261111-736637-2618 --cash 1500 --card 600 --apply    -> writes
//
// What it changes on the bill (same shape createOrder saves for a 'split' sale):
//   paymentMethod = 'split', cashAmount, cardAmount, changeGiven = 0,
//   paymentHistory = one 'cash' entry + one 'card' entry (paidAt / receivedBy / note
//   taken from the original sale payment), and a line in notes.
// If the bill's till is closed (not verified) its expected cash / card are worked out again.
// An open till recomputes live, so nothing else to do. A verified till: refused.
// Before writing, the bill is copied to `_backup_fix_split_<timestamp>`.
// Only runs against the shop database `pos_mirpur_dollar_shop`.

const DB_NAME = 'pos_mirpur_dollar_shop';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orderNumber = String(arg(args, '--order') || '').trim();
  const cash = round2(arg(args, '--cash'));
  const card = round2(arg(args, '--card'));
  if (!orderNumber || !(cash > 0) || !(card > 0)) {
    console.error('Usage: node scripts/fixSplitPayment.js --order <bill no> --cash <amount> --card <amount> [--apply]');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set in .env');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const name = mongoose.connection.name;
  console.log(`Database: ${name}`);
  if (name !== DB_NAME) {
    console.error(`Refusing to run: database is "${name}", expected "${DB_NAME}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(apply ? 'Mode: APPLY (writes)\n' : 'Mode: dry run\n');

  const db = mongoose.connection.db;
  try {
    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);

    const pays = (o.paymentHistory || []).filter((p) => Number(p.amount) > 0);
    console.log(`Bill ${o.orderNumber}  created ${new Date(o.createdAt).toISOString()}`);
    console.log(`  total Rs ${o.total}, paid Rs ${o.paidAmount}, pending Rs ${o.pendingAmount || 0}`);
    console.log(`  status ${o.orderStatus} / ${o.paymentStatus}`);
    console.log(`  now: method ${o.paymentMethod}, cashAmount ${o.cashAmount ?? '-'}, cardAmount ${o.cardAmount ?? '-'}, change ${o.changeGiven ?? '-'}`);
    pays.forEach((p) => console.log(`  payment: ${p.paymentMethod} Rs ${p.amount} at ${new Date(p.paidAt).toISOString()}`));

    if (['refunded', 'cancelled'].includes(o.orderStatus) || o.paymentStatus === 'refunded') throw new Error('Bill is refunded / cancelled');
    if (!pays.length) throw new Error('Bill has no payments');
    if (Number(o.pendingAmount) > 0.004) throw new Error('Bill is not fully paid; fix it from the invoice instead');
    // Only the payment taken at the sale; later instalments would be lost.
    const first = pays[0];
    const SALE_GAP_MS = 5 * 60 * 1000;
    if (pays.some((p) => Math.abs(new Date(p.paidAt) - new Date(o.createdAt)) > SALE_GAP_MS)) {
      throw new Error('Bill has payments taken after the sale; not changed by this script');
    }
    const paid = round2(o.paidAmount || pays.reduce((s, p) => s + Number(p.amount), 0));
    if (round2(cash + card) !== paid) throw new Error(`cash ${cash} + card ${card} = ${round2(cash + card)}, but the bill was paid Rs ${paid}`);
    if (o.paymentMethod === 'split' && round2(o.cashAmount) === cash && round2(o.cardAmount) === card) {
      console.log('\nAlready split this way. Nothing to do.');
      return;
    }

    const CashSession = db.collection('cashsessions');
    const session = o.cashSession ? await CashSession.findOne({ _id: o.cashSession }) : null;
    console.log(`  till: ${session ? `${session._id} (${session.status})` : 'none'}`);
    if (session && session.status === 'verified') throw new Error('The till of this bill is already verified; the bill cannot change');

    const entry = (amount, method) => ({
      ...first,
      _id: new mongoose.Types.ObjectId(),
      amount,
      paymentMethod: method,
      bankTransferScreenshot: undefined,
    });
    const paymentHistory = [entry(cash, 'cash'), entry(card, 'card')];
    const note = `Payment changed ${o.paymentMethod} -> split (cash ${cash}, card ${card}) by script`;
    const set = {
      paymentMethod: 'split',
      cashAmount: cash,
      cardAmount: card,
      changeGiven: 0,
      paymentHistory,
      notes: `${o.notes ? `${o.notes}\n` : ''}${note}`,
    };
    console.log(`\nWill set: method split, cash Rs ${cash}, card Rs ${card}, change 0, payments [cash ${cash}, card ${card}]`);

    if (!apply) {
      console.log('\nDRY RUN: nothing written. Run again with --apply to write.');
      return;
    }

    const backup = `_backup_fix_split_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15)}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`\nBacked up the bill to ${backup}`);

    const r = await orders.updateOne({ _id: o._id, paymentMethod: o.paymentMethod }, { $set: set });
    console.log(`posorders: ${r.modifiedCount} changed`);

    if (session && session.status === 'closed') {
      const tillService = require('../src/services/tillService');
      await tillService.refreshClosedSales(session._id, { note: `${o.orderNumber}: ${note}` });
      console.log('Closed till worked out again.');
    }
    console.log('Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
