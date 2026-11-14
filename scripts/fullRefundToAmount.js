// A bill was refunded IN FULL by mistake (e.g. the amount typed in the "Reason" box):
// only part of the money was given back and the customer KEPT the goods.
// Turn it into a part refund of --amount (a "Refund" expense on the bill, same as
// POS orders → Part refund):
//
//   node scripts/fullRefundToAmount.js --order POS-20261114-605921-3477 --amount 600 --method cash          -> DRY RUN
//   ... --apply                                                                                             -> writes
//
//   1. bill backed up (collection _backup_full_refund_to_amount_<time>);
//   2. every piece taken out of stock again ('sale' ledger rows with the bill refs, allowShort like the POS);
//   3. bill: completed again, refund fields cleared (stockRestored = false);
//   4. Refund expense of --amount on the bill, given by the person who did the refund
//      (cash: their open till, else the bill's counter; bank_transfer / jazzcash / card: no till);
//   5. a closed (not verified) till of the refunder is worked out again. Verified till: refused.

const DB_NAME = 'pos_mirpur_dollar_shop';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const a = process.argv.slice(2);
  const apply = a.includes('--apply');
  const orderNumber = String(arg(a, '--order') || '').trim();
  const amount = round2(arg(a, '--amount'));
  const method = String(arg(a, '--method') || 'cash').trim();
  if (!orderNumber || !(amount > 0)) throw new Error('Usage: --order <bill no> --amount <Rs given back> [--method cash|bank_transfer|jazzcash|card] [--apply]');
  if (!['cash', 'bank_transfer', 'jazzcash', 'card'].includes(method)) throw new Error('Method must be cash, bank_transfer, jazzcash or card');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    // Models used by the services below.
    ['user', 'product', 'posOrder', 'expense', 'expenseCategory', 'cashSession', 'saleCounter'].forEach((m) => require(`../src/models/${m}`));
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');

    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);
    if (o.orderStatus !== 'refunded') throw new Error(`Bill is ${o.orderStatus}, expected refunded`);
    if (!o.stockRestored) throw new Error('The refund did not put stock back; not handled here');
    const paid = round2((o.paymentHistory || []).reduce((t, p) => t + (Number(p.amount) || 0), 0)) || round2(o.paidAmount);
    if (amount > paid) throw new Error(`Rs ${amount} is more than was paid on the bill (Rs ${paid})`);
    const refunder = o.refundedBy || o.cashier;
    const user = await db.collection('users').findOne({ _id: refunder }, { projection: { firstName: 1, lastName: 1, email: 1 } });
    // The refunder's till at the refund time (its cash refund figure changes).
    const tillAtRefund = await db.collection('cashsessions').findOne({
      cashier: refunder,
      openedAt: { $lte: o.refundedAt },
      $or: [{ closedAt: null }, { closedAt: { $gte: o.refundedAt } }],
      status: { $ne: 'deleted' },
    });
    if (tillAtRefund && tillAtRefund.status === 'verified') throw new Error(`Till ${tillAtRefund.sessionNo} is already verified`);
    const names = {};
    (await db.collection('products').find({ _id: { $in: o.items.map((i) => i.product).filter(Boolean) } }).project({ name: 1 }).toArray()).forEach((p) => (names[p._id] = p.name));
    const lines = o.items.filter((i) => i.quantity > 0);

    console.log(`Bill ${orderNumber}: Rs ${o.total} paid by ${o.paymentMethod} (Rs ${paid}) · refunded ${new Date(o.refundedAt).toISOString()} as ${o.refundMethod || '-'} by ${user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : refunder}`);
    console.log(`Refund reason on the bill: ${(o.notes || '').split('\n').filter((l) => /Refund reason/.test(l)).join(' | ') || '-'}`);
    console.log(`Refunder's till at that time: ${tillAtRefund ? `${tillAtRefund.sessionNo} ${tillAtRefund.counterName || ''} (${tillAtRefund.status})` : 'none'}`);
    console.log(`\nWill do:`);
    console.log(`  take back out of stock (customer kept them): ${lines.map((i) => `${names[i.product] || i.name || i.sku} x${i.quantity}`).join(', ')}`);
    console.log(`  bill -> completed / ${paid >= o.total - 0.004 ? 'full' : 'partial'}, full refund removed`);
    console.log(`  Refund expense Rs ${amount} (${method}) on the bill, given by the same person`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_full_refund_to_amount_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`\nBacked up the bill to ${backup}`);

    // 1. Pieces out of stock again.
    const stockService = require('../src/services/stockService');
    const { orderMovement } = require('../src/services/sales/saleHelpers');
    const deducted = await stockService.deductOrderItems(lines.map((i) => ({ ...i, batchAllocations: [] })), {
      branchId: String(o.branch),
      movement: orderMovement(o, null, `Full refund corrected to Rs ${amount} part refund: items kept by the customer`),
      allowShort: true,
    });
    const items = o.items.map((i) => {
      const k = lines.indexOf(i);
      const d = k >= 0 ? deducted[k] : null;
      const out = { ...i, batchAllocations: d ? d.allocations : i.batchAllocations };
      if (d && d.short > 0) out.outOfStockQty = d.short;
      else delete out.outOfStockQty;
      return out;
    });
    console.log(`Stock taken again: ${deducted.map((d, k) => `${names[lines[k].product] || lines[k].sku} ${d ? d.taken : 0}${d && d.short ? ` (short ${d.short})` : ''}`).join(', ')}`);

    // 2. Bill back to sold.
    const pending = round2(Math.max(0, o.total - paid));
    const note = `Full refund corrected: only Rs ${amount} (${method}) was given back, the goods were kept (Refund expense on this bill).`;
    const r = await orders.updateOne(
      { _id: o._id, orderStatus: 'refunded' },
      {
        $set: {
          items,
          orderStatus: pending > 0 ? 'pending' : 'completed',
          paymentStatus: pending > 0 ? 'partial' : 'full',
          pendingAmount: pending,
          refundedAt: null,
          refundMethod: null,
          refundedBy: null,
          stockRestored: false,
          notes: `${o.notes || ''}\n${note}`,
          updatedAt: new Date(),
        },
      }
    );
    if (r.modifiedCount !== 1) throw new Error('Bill changed meanwhile; stock was taken, check the bill by hand');
    console.log('Bill back to sold.');

    // 3. The part refund (same as POS orders → Part refund), as the refunder.
    const refundLink = require('../src/services/refundExpenseLink');
    const { expense } = await refundLink.createPartialRefund({
      orderId: o._id,
      amount,
      reason: 'corrected from a full refund',
      method,
      access: { userId: String(refunder) },
      user: user || {},
      branch: o.branch || null,
    });
    console.log(`Refund expense Rs ${expense.amount} ${expense.paymentMethod}${expense.counterName ? ` · ${expense.counterName}` : ''} saved.`);

    // 4. A closed (not verified) till: sales / refunds / expenses worked out again.
    if (tillAtRefund && tillAtRefund.status === 'closed') {
      const till = require('../src/services/tillService');
      await till.refreshClosedSales(tillAtRefund._id, { note: `${orderNumber}: full refund corrected to Rs ${amount} part refund` });
      const s = await db.collection('cashsessions').findOne({ _id: tillAtRefund._id });
      await till.refreshExpenses(s);
      console.log(`Till ${tillAtRefund.sessionNo} worked out again.`);
    }
    console.log('Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nError:', e.message);
  process.exit(1);
});
