// Match bank statement lines (money out) to POS records. No AI: exact amount,
// date window, name likeness and payment method, then a global best-score
// assignment so one record is used once.
const mongoose = require('mongoose');

const DAY = 86400000;
const PKT = 5 * 3600000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 'YYYY-MM-DD' helpers (shop days, Pakistan time).
const pktDay = (d) => (d ? new Date(new Date(d).getTime() + PKT).toISOString().slice(0, 10) : '');
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const startOf = (s) => new Date(Date.parse(`${s}T00:00:00Z`) - PKT); // PKT midnight as UTC
const endOf = (s) => new Date(Date.parse(`${s}T00:00:00Z`) - PKT + DAY);
const money = (n) => Number(round2(n)).toLocaleString('en-US');

const WINDOW_BEFORE = 3; // record may be up to 3 days before the bank date
const WINDOW_AFTER = 12; // ... or 12 days after (entered late)

// Payment method -> 'bank' | 'online' | 'card' | 'cheque' | 'cash' | 'salary' | 'other' | '' (none).
function methodKind(m) {
  const s = String(m || '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'cash') return 'cash';
  if (s === 'salary') return 'salary';
  if (s.includes('bank') || s === 'online' || s === 'ibft' || s === 'raast') return 'bank';
  if (s.includes('easypaisa') || s.includes('jazzcash')) return 'online';
  if (s.includes('card')) return 'card';
  if (s.includes('cheque') || s === 'check') return 'cheque';
  return 'other';
}
const BANKISH = new Set(['bank', 'online', 'card', 'cheque']);

const STOP = new Set(['the', 'and', 'co', 'company', 'traders', 'trader', 'trading', 'store', 'mart', 'shop', 'enterprises', 'muhammad', 'mohammad', 'm', 'ltd', 'pvt']);
const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

// 0..1: how alike two names are (word overlap or letter pairs, the better one).
function nameSim(a, b) {
  if (!a || !b) return 0;
  const ta = tokens(a).filter((t) => !STOP.has(t));
  const tb = new Set(tokens(b).filter((t) => !STOP.has(t)));
  let word = 0;
  if (ta.length && tb.size) {
    const hit = ta.filter((t) => tb.has(t) || [...tb].some((x) => x.length > 3 && t.length > 3 && (x.startsWith(t) || t.startsWith(x)))).length;
    word = hit / Math.min(ta.length, tb.size);
  }
  const ba = bigrams(a);
  const bb = bigrams(b);
  let dice = 0;
  if (ba.length && bb.length) {
    const pool = new Map();
    bb.forEach((g) => pool.set(g, (pool.get(g) || 0) + 1));
    let hit = 0;
    ba.forEach((g) => {
      if (pool.get(g) > 0) {
        hit += 1;
        pool.set(g, pool.get(g) - 1);
      }
    });
    dice = (2 * hit) / (ba.length + bb.length);
  }
  return Math.max(word, dice);
}

const CHARGE_LABEL = {
  car_rent: 'car rent',
  transport: 'transport',
  builty_freight: 'builty freight',
  loading: 'loading',
  unloading: 'unloading',
  landing: 'landing',
  labour: 'labour',
  misc: 'misc',
};

// Every money-out record of the POS with a date in [from, to] (PKT days).
// Candidate: { src, id, subId, ref, label, who, date, amount, method, kind, bank }
async function collectCandidates(from, to) {
  const db = mongoose.connection.db;
  const range = { $gte: startOf(from), $lt: endOf(to) };
  const inRange = (d) => {
    const s = pktDay(d);
    return s >= from && s <= to;
  };
  const out = [];
  const push = (c) => {
    if (!(Number(c.amount) > 0) || !c.date) return;
    out.push({ ...c, id: String(c.id), subId: c.subId ? String(c.subId) : '', amount: round2(c.amount), kind: methodKind(c.method), bank: c.bank ? String(c.bank) : '' });
  };

  const [vps, exps, pos, loans, invs, runs, advs, tips] = await Promise.all([
    db.collection('vendorpayments').find({ status: { $ne: 'voided' }, date: range }).toArray(),
    db
      .collection('expenses')
      .find({ isDeleted: { $ne: true }, source: { $nin: ['shop_use', 'payroll'] }, sourceType: { $ne: 'Tip' }, fromPersonal: { $ne: true }, date: range })
      .toArray(),
    db
      .collection('purchaseorders')
      .find({
        status: { $ne: 'cancelled' },
        $or: [{ 'charges.date': range }, { 'charges.createdAt': range }, { 'bills.billDate': range }, { 'bills.createdAt': range }],
      })
      .toArray(),
    db.collection('loans').find({ isDeleted: { $ne: true }, 'repayments.date': range }).toArray(),
    db.collection('investments').find({ isDeleted: { $ne: true }, 'payments.date': range }).toArray(),
    db.collection('payrollruns').find({ 'payments.date': range }).toArray(),
    db.collection('salaryadvances').find({ status: { $ne: 'cancelled' }, date: range }).toArray(),
    db.collection('stafftips').find({ isDeleted: { $ne: true }, method: { $nin: ['cash', 'salary'] }, date: range }).toArray(),
  ]);

  for (const v of vps)
    push({ src: 'vendor_payment', id: v._id, ref: v.paymentNo, label: `${v.paymentNo} ${v.vendorName || ''}`.trim(), who: [v.vendorName, v.reference, v.notes].filter(Boolean).join(' '), date: pktDay(v.date), amount: v.amount, method: v.method, bank: v.bank });
  for (const e of exps)
    push({ src: 'expense', id: e._id, ref: 'Expense', label: `Expense: ${e.title}`, who: [e.title, e.reference, e.notes].filter(Boolean).join(' '), date: pktDay(e.date), amount: e.amount, method: e.paymentMethod, bank: e.bank });
  for (const po of pos) {
    for (const c of po.charges || []) {
      const d = c.date || c.createdAt;
      if (!inRange(d)) continue;
      const what = CHARGE_LABEL[c.type] || c.type || 'trip cost';
      push({ src: 'trip_cost', id: po._id, subId: c._id, ref: po.poNumber, label: `${po.poNumber} ${what}${c.paidTo ? ` (${c.paidTo})` : ''}`, who: [c.paidTo, c.note].filter(Boolean).join(' '), date: pktDay(d), amount: c.amount, method: c.method || '', bank: c.bank, chargeType: what });
    }
    for (const b of po.bills || []) {
      if (!(b.paidNow > 0) || b.payment) continue; // a VendorPayment exists: matched there
      const d = b.billDate || b.createdAt;
      if (!inRange(d)) continue;
      push({ src: 'trip_bill', id: po._id, subId: b._id, ref: po.poNumber, label: `${po.poNumber} bill ${b.billNo || ''} ${b.vendorName || ''}`.replace(/\s+/g, ' ').trim(), who: b.vendorName || '', date: pktDay(d), amount: b.paidNow, method: b.paidMethod, bank: b.paidBank });
    }
  }
  for (const l of loans)
    for (const r of l.repayments || []) {
      if (!inRange(r.date)) continue;
      push({ src: 'loan', id: l._id, subId: r._id, ref: l.loanNo, label: `${l.loanNo} paid back to ${l.lenderName}`, who: [l.lenderName, r.note].filter(Boolean).join(' '), date: pktDay(r.date), amount: r.amount, method: r.method });
    }
  for (const i of invs)
    for (const p of i.payments || []) {
      if (!inRange(p.date)) continue;
      push({ src: 'investment', id: i._id, subId: p._id, ref: i.billNo || 'Investment', label: `Investment: ${i.title}${i.paidTo ? ` (${i.paidTo})` : ''}`, who: [i.paidTo, i.title, p.note].filter(Boolean).join(' '), date: pktDay(p.date), amount: p.amount, method: p.method || '' });
    }
  for (const r of runs)
    for (const p of r.payments || []) {
      if (!inRange(p.date)) continue;
      push({ src: 'payroll', id: r._id, subId: p._id, ref: r.runNo, label: `${r.runNo} salaries ${r.monthLabel || r.month || ''}`.trim(), who: 'salaries', date: pktDay(p.date), amount: p.amount, method: p.method });
    }
  for (const a of advs)
    push({ src: 'advance', id: a._id, ref: a.advanceNo, label: `${a.advanceNo} advance to ${a.employeeName}`, who: a.employeeName, date: pktDay(a.date), amount: a.amount, method: a.method });
  for (const t of tips)
    push({ src: 'tip', id: t._id, ref: t.tipNo, label: `${t.tipNo} tip to ${t.employeeName}`, who: t.employeeName, date: t.day || pktDay(t.date), amount: t.amount, method: t.method });
  return out;
}

const recKey = (c) => `${c.src}:${c.id}:${c.subId || ''}`;

// Status and plain-words issue for a line matched to candidate c.
function judge(line, c, ctx) {
  const diff = round2(line.amount - c.amount);
  const near = Math.abs(diff) >= 0.01;
  const issues = [];
  if (near) issues.push(`System ${money(c.amount)}, bank ${money(line.amount)}`);
  if (!c.kind) {
    if (c.src === 'trip_cost') issues.push(`Likely trip cost ${c.ref} ${c.chargeType || ''} - no payment method in system, check`.replace(/\s+/g, ' '));
    else issues.push('No payment method in system - check');
  } else if (c.kind === 'cash') issues.push('System says CASH, bank shows a transfer');
  else if (!BANKISH.has(c.kind)) issues.push(`System says ${c.method}, bank shows a transfer`);
  else if (c.bank && ctx.bankId && c.bank !== ctx.bankId) issues.push(`System says paid from ${ctx.bankNames[c.bank] || 'another bank'}`);
  return { status: issues.length ? 'fix' : 'ok', issue: issues.join('; ') };
}

/**
 * lines: [{ _tmp, date, amount, payee, particulars }] money out, still to match.
 * cands: from collectCandidates, minus records already linked.
 * ctx: { bankId, bankNames }
 * Returns Map(_tmp -> { status, issue, match }).
 */
function matchLines(lines, cands, ctx) {
  const pairs = [];
  lines.forEach((b, i) => {
    cands.forEach((o, j) => {
      const diff = Math.abs(o.amount - b.amount);
      const gap = dayDiff(o.date, b.date);
      if (gap < -WINDOW_BEFORE || gap > WINDOW_AFTER) return;
      const sim = Math.max(nameSim(b.payee, o.who), nameSim(b.payee, o.label));
      let score;
      if (diff < 0.01) score = 10;
      else if (diff <= Math.min(1000, b.amount * 0.02) && sim >= 0.5) score = 5; // close amount needs a good name
      else return;
      score += sim * 5 + (BANKISH.has(o.kind) ? 2 : 0) + (o.bank && o.bank === ctx.bankId ? 1 : 0) - Math.abs(gap) * 0.15;
      pairs.push({ score, i, j });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const usedI = new Set();
  const usedJ = new Set();
  const res = new Map();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    const b = lines[p.i];
    const c = cands[p.j];
    const { status, issue } = judge(b, c, ctx);
    res.set(b._tmp, {
      status,
      issue,
      match: { src: c.src, id: c.id, subId: c.subId || null, ref: c.ref, label: c.label, date: c.date, amount: c.amount, method: c.method || '' },
    });
  }
  for (const b of lines) {
    if (res.has(b._tmp)) continue;
    const issue = b.kind === 'charge' ? 'Bank charge / tax, not in the system' : 'Paid from bank, not in the system';
    res.set(b._tmp, { status: 'missing', issue, match: null });
  }
  return { results: res, usedKeys: new Set([...usedJ].map((j) => recKey(cands[j]))) };
}

// What a money-in line is, in plain words.
function inLabel(line) {
  if (line.kind === 'card') return 'Card machine settlement';
  if (line.kind === 'cash') return 'Cash deposit';
  if (line.kind === 'transfer_in') return `Transfer in from ${line.payee || 'someone'}`;
  return 'Money in';
}

module.exports = { collectCandidates, matchLines, inLabel, methodKind, nameSim, recKey, pktDay, addDays, dayDiff, startOf, endOf, BANKISH, round2 };
