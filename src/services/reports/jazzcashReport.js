// JazzCash wallet for a period (owner 2026-11-14, Cash in Hand → JazzCash tab).
// Every money movement recorded as JazzCash, by its own date (Pakistan days):
//   IN   POS payments by JazzCash (whole bills, the JazzCash part of a split, later
//        instalments). A JazzCash bill paid over its total: the customer sent the
//        amount + the cash change given back, so that is what reached the wallet.
//   OUT  full refunds given back by JazzCash, expenses paid by JazzCash (incl. part refunds),
//        vendor payments by JazzCash, trip costs paid by JazzCash.
// -> { from, to, totals: { in, out, net, bills }, rows: [{ date, kind, ref, label, in, out, balance }] }

const mongoose = require('mongoose');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const START = '2026-10-25';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const pkStart = (d) => new Date(`${d}T00:00:00.000+05:00`);
const pkEnd = (d) => new Date(`${d}T23:59:59.999+05:00`);
const pkToday = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);

async function jazzcash(query = {}) {
  const from = String(query.from || START);
  const to = String(query.to || pkToday());
  if (!DAY.test(from) || !DAY.test(to)) throw bad('Dates must be YYYY-MM-DD');
  if (from > to) throw bad('"From" is after "To"');
  const start = pkStart(from);
  const end = pkEnd(to);
  const db = mongoose.connection.db;
  const rows = [];
  const inRange = (d) => d && new Date(d) >= start && new Date(d) <= end;

  // ---- POS: money received by JazzCash ----
  const orders = await db
    .collection('posorders')
    .find({ isDeleted: { $ne: true }, paymentHistory: { $elemMatch: { paymentMethod: 'jazzcash', paidAt: { $gte: start, $lte: end } } } })
    .project({ orderNumber: 1, paymentMethod: 1, changeGiven: 1, paymentHistory: 1, customerInfo: 1, createdAt: 1 })
    .toArray();
  const billSet = new Set();
  for (const o of orders) {
    (o.paymentHistory || [])
      .filter((p) => p.paymentMethod === 'jazzcash' && Number(p.amount) > 0 && inRange(p.paidAt))
      .forEach((p, i) => {
        // Sent over the bill (whole-bill JazzCash only): the cash change came from the drawer.
        const change = o.paymentMethod === 'jazzcash' && i === 0 ? Number(o.changeGiven) || 0 : 0;
        billSet.add(String(o._id));
        rows.push({
          date: p.paidAt,
          kind: o.paymentMethod === 'split' ? 'split_part' : 'sale',
          ref: o.orderNumber || '',
          label: `${o.paymentMethod === 'split' ? 'Split bill (JazzCash part)' : 'Sale'}${o.customerInfo && o.customerInfo.name ? ` · ${o.customerInfo.name}` : ''}${change > 0 ? ` · incl. Rs ${round2(change)} given back in cash` : ''}`,
          in: round2(Number(p.amount) + change),
          out: 0,
        });
      });
  }

  // ---- POS: whole bills refunded by JazzCash ----
  const refunded = await db
    .collection('posorders')
    .find({ isDeleted: { $ne: true }, orderStatus: 'refunded', refundMethod: 'jazzcash', refundedAt: { $gte: start, $lte: end } })
    .project({ orderNumber: 1, paidAmount: 1, paymentHistory: 1, refundedAt: 1 })
    .toArray();
  for (const o of refunded) {
    const paid = round2((o.paymentHistory || []).reduce((t, p) => t + (Number(p.amount) || 0), 0)) || round2(o.paidAmount);
    if (paid > 0) rows.push({ date: o.refundedAt, kind: 'refund', ref: o.orderNumber || '', label: 'Full refund', in: 0, out: paid });
  }

  // ---- expenses paid by JazzCash (incl. part refunds; older part refunds were saved as 'Other') ----
  const jazzExpenses = await db
    .collection('expenses')
    .find({
      isDeleted: { $ne: true },
      displayOnly: { $ne: true },
      date: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T00:00:00.000Z`) },
      $or: [{ paymentMethod: 'JazzCash' }, { posOrder: { $type: 'objectId' }, paymentMethod: 'Other', notes: /\(JazzCash\)/ }],
    })
    .project({ title: 1, amount: 1, posOrderNumber: 1, posOrder: 1, category: 1, date: 1, createdAt: 1 })
    .toArray();
  for (const e of jazzExpenses) {
    const refund = !!e.posOrder;
    rows.push({
      date: e.createdAt || e.date,
      kind: refund ? 'part_refund' : 'expense',
      ref: refund ? e.posOrderNumber || '' : e.category || '',
      label: refund ? 'Part refund' : `Expense · ${e.title || ''}`,
      in: 0,
      out: round2(e.amount),
    });
  }

  // ---- vendor payments by JazzCash ----
  const vpays = await db
    .collection('vendorpayments')
    .find({ status: 'active', method: 'jazzcash', date: { $gte: start, $lte: end } })
    .project({ paymentNo: 1, vendorName: 1, amount: 1, date: 1, reference: 1 })
    .toArray();
  for (const v of vpays) {
    rows.push({ date: v.date, kind: 'vendor_payment', ref: v.paymentNo || '', label: `Vendor payment · ${v.vendorName || ''}`, in: 0, out: round2(v.amount) });
  }

  // ---- trip costs paid by JazzCash ----
  const pos = await db
    .collection('purchaseorders')
    .find({ status: { $ne: 'cancelled' }, charges: { $elemMatch: { method: 'jazzcash' } } })
    .project({ poNumber: 1, charges: 1 })
    .toArray();
  for (const po of pos) {
    for (const c of po.charges || []) {
      const at = c.date || c.createdAt;
      if (c.method !== 'jazzcash' || !inRange(at)) continue;
      rows.push({ date: at, kind: 'trip_cost', ref: po.poNumber || '', label: `Trip cost · ${String(c.type || 'other').replace(/_/g, ' ')}${c.note ? ` · ${c.note}` : ''}`, in: 0, out: round2(c.amount) });
    }
  }

  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  let balance = 0;
  rows.forEach((r) => {
    balance = round2(balance + r.in - r.out);
    r.balance = balance;
  });
  const totalIn = round2(rows.reduce((t, r) => t + r.in, 0));
  const totalOut = round2(rows.reduce((t, r) => t + r.out, 0));
  return { from, to, totals: { in: totalIn, out: totalOut, net: round2(totalIn - totalOut), bills: billSet.size }, rows };
}

module.exports = { jazzcash };
