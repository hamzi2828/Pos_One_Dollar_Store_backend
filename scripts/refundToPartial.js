// A cash bill was refunded IN FULL in the system, but the customer only returned some items
// (cash given back from the bill's counter right after the sale). Turn it into a part refund:
//
//   node scripts/refundToPartial.js --order POS-20261112-286792-2964 --sku D1D-67042 --qty 3          -> DRY RUN
//   ... --apply                                                                                      -> writes
//
//   1. stock: the full refund put every piece back; the pieces the customer KEPT are taken out
//      again ('sale' ledger rows with the bill refs, allowShort like the POS).
//   2. bill: completed / full again, refund fields cleared; the returned line(s) down (removed at 0);
//      subtotal / total / paid / cogs and the cash payment down by the returned amount; kept lines get
//      their new batch allocations; stockRestored = false (a later refund/delete puts the kept pieces back).
//   3. a closed (not verified) till is worked out again. Verified till: refused. Bill backed up first.
// Only plain cash bills (one cash payment, no discount / tax / gifts).

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
  const qty = Number(arg(a, '--qty') || 0);
  if (!orderNumber || !sku || !Number.isInteger(qty) || qty < 1) throw new Error('Usage: --order <bill no> --sku <returned sku> --qty <n> [--apply]');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);
    if (o.orderStatus !== 'refunded') throw new Error(`Bill is ${o.orderStatus}, expected refunded`);
    if (!o.stockRestored) throw new Error('Refund did not put stock back; not handled here');
    if (o.paymentMethod !== 'cash' || (Number(o.discount) || 0) > 0 || (Number(o.tax) || 0) > 0) throw new Error('Only plain cash bills');
    const pays = (o.paymentHistory || []).filter((p) => Number(p.amount) > 0);
    if (pays.length !== 1 || pays[0].paymentMethod !== 'cash') throw new Error('Bill must have exactly one cash payment');
    if ((o.items || []).some((i) => i.isGift || (Number(i.discount) || 0) > 0)) throw new Error('Bill has gift / discounted lines');
    const session = o.cashSession ? await db.collection('cashsessions').findOne({ _id: o.cashSession }) : null;
    if (!session) throw new Error('Bill has no till');
    if (session.status === 'verified') throw new Error('Till already verified');

    const idx = o.items.findIndex((i) => i.sku === sku);
    if (idx < 0) throw new Error(`SKU ${sku} not on the bill`);
    const ret = o.items[idx];
    if (qty > ret.quantity) throw new Error(`Bill has only ${ret.quantity} of ${sku}`);
    const refund = round2(ret.price * qty);
    const newTotal = round2(o.total - refund);
    // Pieces the customer kept: every line, the returned line minus qty.
    const kept = o.items.map((i, k) => ({ ...i, quantity: k === idx ? i.quantity - qty : i.quantity })).filter((i) => i.quantity > 0);
    const names = {};
    (await db.collection('products').find({ _id: { $in: o.items.map((i) => i.product) } }).project({ name: 1 }).toArray()).forEach((p) => (names[p._id] = p.name));
    const cogs = round2(kept.reduce((t, i) => t + (Number(i.costPrice) || 0) * i.quantity, 0));

    console.log(`Bill ${orderNumber}: Rs ${o.total} cash, ${o.orderStatus}; ${session.counterName} till ${session.sessionNo} (${session.status})`);
    console.log(`Returned: ${qty} x ${sku} "${names[ret.product]}" = Rs ${refund} cash`);
    console.log(`Kept (taken out of stock again): ${kept.map((i) => `${names[i.product]} x${i.quantity}`).join(', ')}`);
    console.log(`Bill -> completed / full, Rs ${newTotal}, cash payment ${pays[0].amount} -> ${round2(pays[0].amount - refund)}, cogs ${o.cogs} -> ${cogs}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_refund_to_partial_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`Backed up the bill to ${backup}`);

    // 1. Kept pieces out of stock again.
    const stockService = require('../src/services/stockService');
    const { orderMovement } = require('../src/services/sales/saleHelpers');
    const deducted = await stockService.deductOrderItems(kept.map((i) => ({ ...i, batchAllocations: [] })), {
      branchId: String(o.branch),
      movement: orderMovement(o, null, 'Full refund corrected to part refund: kept items sold again'),
      allowShort: true,
    });
    const items = kept.map((i, k) => {
      const d = deducted[k];
      const out = { ...i, batchAllocations: d ? d.allocations : i.batchAllocations };
      if (d && d.short > 0) out.outOfStockQty = d.short;
      else delete out.outOfStockQty;
      return out;
    });
    console.log(`Stock taken again: ${deducted.map((d, k) => `${names[kept[k].product]} ${d ? d.taken : 0}${d && d.short ? ` (short ${d.short})` : ''}`).join(', ')}`);

    // 2. Bill.
    const paymentHistory = o.paymentHistory.map((p) => (String(p._id) === String(pays[0]._id) ? { ...p, amount: round2(p.amount - refund) } : p));
    const note = `2026-11-13 owner: only ${qty} x ${sku} (${names[ret.product]}) Rs ${refund} was refunded, in cash right after the sale (not the whole bill). Bill was Rs ${o.total}, now Rs ${newTotal}.`;
    const r = await orders.updateOne(
      { _id: o._id, orderStatus: 'refunded' },
      {
        $set: {
          items,
          subtotal: round2(o.subtotal - refund),
          total: newTotal,
          paidAmount: round2(o.paidAmount - refund),
          cogs,
          paymentHistory,
          orderStatus: 'completed',
          paymentStatus: 'full',
          refundedAt: null,
          refundMethod: null,
          refundedBy: null,
          stockRestored: false,
          notes: `${o.notes || ''}\n${note}`,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`Bill updated: ${r.modifiedCount}`);

    // 3. Closed till worked out again.
    if (session.status === 'closed') {
      const till = require('../src/services/tillService');
      const t = await till.refreshClosedSales(session._id, { note: `${orderNumber}: full refund corrected to Rs ${refund} part refund` });
      console.log('Till now:', JSON.stringify({ cashSales: t.expected.cashSales, cashRefunds: t.expected.cashRefunds, expectedCash: t.expected.expectedCash, variance: t.variance }));
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
