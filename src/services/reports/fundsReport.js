// Money left (owner, 2026-11-04): the owner sets a starting balance (all money,
// cash + bank together) at a moment in time. From then on:
//   left = start + sales received - refunds - vendor payments - trip costs - expenses
// Only things ENTERED after the start count (everything before is inside the start).

const mongoose = require('mongoose');

const COL = 'fundbaselines';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

async function currentBaseline() {
  return mongoose.connection.db.collection(COL).find({}).sort({ at: -1, _id: -1 }).limit(1).next();
}

/** POST { amount, at? } — a new starting balance (the old ones stay as history). */
async function setBaseline(req, body = {}) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount)) throw bad('Enter the money you have now');
  const at = body.at ? new Date(body.at) : new Date();
  if (Number.isNaN(at.getTime())) throw bad('Bad date');
  if (at.getTime() > Date.now() + 60000) throw bad('The start cannot be in the future');
  const u = req.user || {};
  const doc = {
    amount: round2(amount),
    at,
    note: String(body.note || '').slice(0, 300),
    setBy: req.access && req.access.userId ? new mongoose.Types.ObjectId(String(req.access.userId)) : null,
    setByName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '',
    createdAt: new Date(),
  };
  await mongoose.connection.db.collection(COL).insertOne(doc);
  return funds();
}

async function funds() {
  const db = mongoose.connection.db;
  const base = await currentBaseline();
  if (!base) return { baseline: null, totals: null, left: null, movements: [] };
  const since = base.at;
  const movements = [];

  // Sales: money received on bills rung after the start, by Pakistan day.
  const sales = await db
    .collection('posorders')
    .aggregate([
      { $match: { createdAt: { $gte: since }, orderStatus: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Karachi' } },
          amount: { $sum: { $cond: [{ $gt: ['$paidAmount', 0] }, '$paidAmount', '$total'] } },
          bills: { $sum: 1 },
          last: { $max: '$createdAt' },
        },
      },
    ])
    .toArray();
  for (const s of sales) movements.push({ at: s.last, kind: 'sales', label: `Sales ${s._id} (${s.bills} bill${s.bills === 1 ? '' : 's'})`, amount: round2(s.amount) });

  const refunds = await db
    .collection('posorders')
    .find({ refundedAt: { $gte: since } })
    .project({ orderNumber: 1, invoiceNumber: 1, paidAmount: 1, total: 1, refundedAt: 1 })
    .toArray();
  for (const r of refunds) movements.push({ at: r.refundedAt, kind: 'refund', label: `Refund ${r.orderNumber || r.invoiceNumber || ''}`.trim(), amount: -round2(r.paidAmount || r.total) });

  const payments = await db
    .collection('vendorpayments')
    .find({ createdAt: { $gte: since }, status: 'active' })
    .project({ paymentNo: 1, vendorName: 1, amount: 1, method: 1, createdAt: 1 })
    .toArray();
  for (const p of payments) movements.push({ at: p.createdAt, kind: 'vendor_payment', label: `${p.paymentNo} · ${p.vendorName} (${p.method})`, amount: -round2(p.amount) });

  const pos = await db.collection('purchaseorders').find({ 'charges.createdAt': { $gte: since } }).project({ poNumber: 1, charges: 1 }).toArray();
  for (const po of pos)
    for (const c of po.charges || [])
      if (c.createdAt && c.createdAt >= since)
        movements.push({ at: c.createdAt, kind: 'trip_cost', label: `Trip cost ${po.poNumber} · ${c.type || ''}${c.note ? ` · ${c.note}` : ''}`, amount: -round2(c.amount) });

  const expenses = await db
    .collection('expenses')
    .find({ createdAt: { $gte: since }, isDeleted: { $ne: true }, source: { $ne: 'shop_use' } }) // shop use = own stock, no money out
    .project({ title: 1, amount: 1, paymentMethod: 1, createdAt: 1 })
    .toArray();
  for (const e of expenses) movements.push({ at: e.createdAt, kind: 'expense', label: `Expense · ${e.title || ''} (${e.paymentMethod || ''})`, amount: -round2(e.amount) });

  movements.sort((a, b) => new Date(a.at) - new Date(b.at));
  let run = base.amount;
  for (const m of movements) {
    run = round2(run + m.amount);
    m.balance = run;
  }
  const sum = (k) => round2(movements.filter((m) => m.kind === k).reduce((t, m) => t + m.amount, 0));
  const totals = {
    sales: sum('sales'),
    refunds: -sum('refund'),
    vendorPayments: -sum('vendor_payment'),
    tripCosts: -sum('trip_cost'),
    expenses: -sum('expense'),
  };
  return {
    baseline: { amount: base.amount, at: base.at, setByName: base.setByName || '', note: base.note || '' },
    totals,
    left: run,
    movements: movements.reverse(),
  };
}

module.exports = { funds, setBaseline };
