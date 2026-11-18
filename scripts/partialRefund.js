// Refund part of a CASH bill (the app only refunds whole bills).
//
//   node scripts/partialRefund.js --order POS-20261112-425550-2833 --sku JI-40865 --qty 1 [--reason "..."]          -> DRY RUN
//   ... --apply                                                                                                    -> writes
//
// What it does:
//   1. puts the pieces back into stock (stockService.restoreOrderItems, same as the app's refund:
//      'sale_return' ledger row with the bill refs),
//   2. bill: item quantity down (line removed at 0), subtotal / total / paid / cogs down,
//      the cash payment taken at the sale down by the refund (the till counts cash from it, so the
//      refunded cash leaves the bill's till), a line in notes. Tendered cash / change kept as printed.
// Only plain cash bills with no discount / tax, paid in full by one cash payment. Verified till: refused.
// A closed (not verified) till is worked out again; an open till recomputes live. Bill backed up first.

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
  const sku = String(arg(a, '--sku') || '').trim();
  const qty = Number(arg(a, '--qty') || 1);
  const reason = String(arg(a, '--reason') || 'Customer returned item').trim();
  if (!orderNumber || !sku || !Number.isInteger(qty) || qty < 1) throw new Error('Usage: --order <bill no> --sku <sku> [--qty 1] [--reason <text>] [--apply]');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);
    if (o.orderStatus !== 'completed' || o.paymentStatus !== 'full') throw new Error(`Bill is ${o.orderStatus} / ${o.paymentStatus}`);
    if (o.paymentMethod !== 'cash') throw new Error(`Bill was paid by ${o.paymentMethod}, only cash bills`);
    if ((Number(o.discount) || 0) > 0 || (Number(o.tax) || 0) > 0) throw new Error('Bill has a discount / tax; not handled here');
    const pays = (o.paymentHistory || []).filter((p) => Number(p.amount) > 0);
    if (pays.length !== 1 || pays[0].paymentMethod !== 'cash') throw new Error('Bill must have exactly one cash payment');
    const session = o.cashSession ? await db.collection('cashsessions').findOne({ _id: o.cashSession }) : null;
    if (!session) throw new Error('Bill has no till');
    if (session.status === 'verified') throw new Error('Till already verified');

    const idx = (o.items || []).findIndex((i) => i.sku === sku);
    if (idx < 0) throw new Error(`SKU ${sku} not on the bill`);
    const item = o.items[idx];
    if ((Number(item.discount) || 0) > 0 || item.isGift) throw new Error('Item has a discount / is a gift; not handled here');
    if (qty > item.quantity) throw new Error(`Bill has only ${item.quantity} of ${sku}`);
    const product = await db.collection('products').findOne({ _id: item.product }, { projection: { name: 1 } });
    const refund = round2(item.price * qty);
    const cogsOff = round2((Number(item.costPrice) || 0) * qty);
    const newTotal = round2(o.total - refund);
    const left = item.quantity - qty;

    console.log(`Bill ${orderNumber}: Rs ${o.total} cash, ${session.counterName} till ${session.status}`);
    console.log(`Refund ${qty} x ${sku} "${product ? product.name : ''}" @ Rs ${item.price} = Rs ${refund} cash`);
    console.log(`  line ${item.quantity} -> ${left}${left ? '' : ' (removed)'}; total ${o.total} -> ${newTotal}; cash payment ${pays[0].amount} -> ${round2(pays[0].amount - refund)}; cogs ${o.cogs} -> ${round2(o.cogs - cogsOff)}`);
    console.log(`  stock: +${qty} ${sku} back to the shop`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_partial_refund_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`Backed up the bill to ${backup}`);

    // 1. Bill (guarded on the values read, so a second run cannot take it off twice).
    const items = o.items.map((i, k) => (k === idx ? { ...i, quantity: left } : i)).filter((i) => i.quantity > 0);
    const paymentHistory = o.paymentHistory.map((p) => (String(p._id) === String(pays[0]._id) ? { ...p, amount: round2(p.amount - refund) } : p));
    const note = `2026-11-12 owner: refunded ${qty} x ${sku} (${product ? product.name : ''}) Rs ${refund} cash from ${session.counterName}. Reason: ${reason}. Bill was Rs ${o.total}, now Rs ${newTotal}.`;
    const r = await orders.updateOne(
      { _id: o._id, total: o.total, [`items.${idx}.quantity`]: item.quantity },
      {
        $set: {
          items,
          subtotal: round2(o.subtotal - refund),
          total: newTotal,
          paidAmount: round2(o.paidAmount - refund),
          cogs: round2(o.cogs - cogsOff),
          paymentHistory,
          notes: `${o.notes || ''}\n${note}`,
          updatedAt: new Date(),
        },
      }
    );
    if (!r.modifiedCount) throw new Error('Bill changed while running; nothing done');
    console.log('Bill updated');

    // 2. Stock back.
    const stockService = require('../src/services/stockService');
    const { orderMovement } = require('../src/services/sales/saleHelpers');
    const { errors, restored } = await stockService.restoreOrderItems([{ ...item, quantity: qty, batchAllocations: [] }], {
      branchId: String(o.branch),
      movement: orderMovement(o, null, `Partial refund: ${reason}`),
    });
    console.log(`Stock restored: ${restored}${errors.length ? ` WARN ${JSON.stringify(errors)}` : ''}`);

    // 3. Closed (not verified) till worked out again.
    if (session.status === 'closed') {
      const till = require('../src/services/tillService');
      await till.refreshClosedSales(session._id, { note: `${orderNumber}: partial refund Rs ${refund} cash` });
      console.log('Closed till worked out again.');
    }
    console.log('Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
