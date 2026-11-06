// Spending report: what we bought from vendors, what we paid them, trip costs
// and shop expenses, for one period (Pakistan days).
//
// Periods (owner, 2026-11-04): the system starts on 25 Oct 2026. The first
// period runs 25 Oct to 30 Nov 2026; from 1 Dec 2026 every calendar month is
// one period. The page builds the list; the server takes any from / to.

const mongoose = require('mongoose');

const START = '2026-10-25';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// Pakistan day -> UTC instants (PKT is UTC+5, no daylight saving).
const pkStart = (d) => new Date(`${d}T00:00:00.000+05:00`);
const pkEnd = (d) => new Date(`${d}T23:59:59.999+05:00`);
const pkToday = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);

// Buying = what we owe vendors for goods; reductions other than payments are "adjusted".
const BUY_TYPES = ['bill', 'credit_note', 'consignment_settlement'];
const ADJUST_TYPES = ['adjustment', 'discount', 'debit_note'];

async function spending(query = {}) {
  const from = String(query.from || START);
  const to = String(query.to || pkToday());
  if (!DAY.test(from) || !DAY.test(to)) throw bad('Dates must be YYYY-MM-DD');
  if (from > to) throw bad('"From" is after "To"');
  const start = pkStart(from);
  const end = pkEnd(to);
  const db = mongoose.connection.db;

  // ---- vendor ledger (bills, payments, adjustments) ----
  const ledger = await db
    .collection('vendorledgerentries')
    .find({ isVoided: false, date: { $gte: start, $lte: end } })
    .project({ vendor: 1, vendorName: 1, type: 1, credit: 1, debit: 1, method: 1, refNo: 1, date: 1, description: 1 })
    .toArray();

  const vendors = new Map();
  const vrow = (e) => {
    const k = String(e.vendor);
    if (!vendors.has(k)) vendors.set(k, { vendorId: k, vendor: e.vendorName || '', bought: 0, opening: 0, paid: 0, adjusted: 0 });
    return vendors.get(k);
  };
  const byMethod = {};
  const payments = [];
  let bought = 0;
  let opening = 0;
  let paid = 0;
  let adjusted = 0;
  for (const e of ledger) {
    const v = vrow(e);
    if (BUY_TYPES.includes(e.type)) {
      const n = (e.credit || 0) - (e.debit || 0);
      bought += n;
      v.bought += n;
    } else if (e.type === 'opening_balance') {
      const n = (e.credit || 0) - (e.debit || 0);
      opening += n;
      v.opening += n;
    } else if (e.type === 'payment') {
      const n = (e.debit || 0) - (e.credit || 0);
      paid += n;
      v.paid += n;
      const m = e.method || 'other';
      byMethod[m] = round2((byMethod[m] || 0) + n);
      payments.push({ date: e.date, vendor: e.vendorName || '', refNo: e.refNo || '', method: m, amount: round2(n) });
    } else if (ADJUST_TYPES.includes(e.type)) {
      const n = (e.debit || 0) - (e.credit || 0);
      adjusted += n;
      v.adjusted += n;
    }
  }

  // ---- trip costs (purchase order charges, by the day they were added) ----
  const pos = await db
    .collection('purchaseorders')
    .find({ status: { $ne: 'cancelled' }, 'charges.0': { $exists: true } })
    .project({ poNumber: 1, charges: 1 })
    .toArray();
  const tripCosts = [];
  const tripByType = {};
  let trip = 0;
  for (const po of pos) {
    for (const c of po.charges || []) {
      const at = c.date || c.createdAt;
      if (!at || at < start || at > end) continue;
      const amount = Number(c.amount) || 0;
      trip += amount;
      tripByType[c.type || 'other'] = round2((tripByType[c.type || 'other'] || 0) + amount);
      tripCosts.push({ date: at, poNumber: po.poNumber || '', type: c.type || 'other', note: c.note || '', paidTo: c.paidTo || '', amount: round2(amount) });
    }
  }

  // ---- shop expenses ----
  const exp = await db
    .collection('expenses')
    .aggregate([
      { $match: { isDeleted: { $ne: true }, date: { $gte: start, $lte: end }, source: { $ne: 'shop_use' } } }, // shop use = own stock, never money out
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ])
    .toArray();
  const expenses = exp.reduce((t, r) => t + (r.total || 0), 0);

  const vendorRows = [...vendors.values()]
    .map((v) => ({ ...v, bought: round2(v.bought), opening: round2(v.opening), paid: round2(v.paid), adjusted: round2(v.adjusted), left: round2(v.bought + v.opening - v.paid - v.adjusted) }))
    .filter((v) => v.bought || v.opening || v.paid || v.adjusted)
    .sort((a, b) => b.bought + b.opening - (a.bought + a.opening));

  return {
    range: { from, to, systemStart: START },
    summary: {
      bought: round2(bought),
      opening: round2(opening),
      paid: round2(paid),
      adjusted: round2(adjusted),
      // Left on this period's buying (opening balances not included).
      left: round2(bought - paid - adjusted),
      tripCosts: round2(trip),
      expenses: round2(expenses),
      // Cost of everything: goods bought + trip costs + shop expenses (opening balances are older, not included).
      totalSpent: round2(bought + trip + expenses),
      // Money that actually went out: vendor payments + trip costs + shop expenses.
      cashOut: round2(paid + trip + expenses),
    },
    paidByMethod: byMethod,
    tripByType,
    vendors: vendorRows,
    payments: payments.sort((a, b) => b.date - a.date),
    tripCosts: tripCosts.sort((a, b) => b.date - a.date),
    expensesByCategory: exp.map((r) => ({ category: r._id || 'Other', total: round2(r.total), count: r.count })),
  };
}

module.exports = { spending, START };
