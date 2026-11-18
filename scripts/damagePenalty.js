// Owner 2026-11-12: items broken by staff, rung up on a bill so the stock comes off.
// The broken part of the bill was never paid, so (same as Raja Asim, bill 2615):
//   1. the bill stays a full sale,
//   2. the unpaid amount is a Cash expense in "Pending Amount" linked to the bill
//      (bill's counter + branch, dated the bill's day) -> comes off that counter's till,
//   3. each employee gets an approved "damage" payroll deduction for their share.
//
//   node scripts/damagePenalty.js --order POS-20261112-536098-2860 --amount 600 \
//        --share EMP-2026-00013=300 --share EMP-2026-00012=300 [--note "..."]          -> DRY RUN
//   ... --apply                                                                         -> writes
//
// Safe to run again: a deduction (bill + employee) or expense (bill) that already exists is skipped.
// Verified till: refused. Bill backed up first.

const DB_NAME = 'pos_mirpur_dollar_shop';
const CATEGORY = 'Pending Amount';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
const args = (a, n) => a.reduce((out, x, i) => (x === n && a[i + 1] ? [...out, a[i + 1]] : out), []);

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const a = process.argv.slice(2);
  const apply = a.includes('--apply');
  const orderNumber = String(arg(a, '--order') || '').trim();
  const amount = round2(arg(a, '--amount'));
  const note = String(arg(a, '--note') || 'Broken items').trim();
  const shares = args(a, '--share').map((s) => {
    const [code, amt] = s.split('=');
    return { code: String(code || '').trim(), amount: round2(amt) };
  });
  if (!orderNumber || !(amount > 0) || !shares.length || shares.some((s) => !s.code || !(s.amount > 0))) {
    throw new Error('Usage: --order <bill no> --amount <rs> --share <EMP code>=<rs> [--share ...] [--note <text>] [--apply]');
  }
  if (Math.abs(shares.reduce((t, s) => t + s.amount, 0) - amount) > 0.01) throw new Error('Shares do not add up to the amount');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    const PayrollDeduction = require('../src/models/payrollDeduction');
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);
    if (amount > o.total) throw new Error(`Amount Rs ${amount} is more than the bill (Rs ${o.total})`);
    const session = o.cashSession ? await db.collection('cashsessions').findOne({ _id: o.cashSession }) : null;
    if (!session) throw new Error('Bill has no till');
    if (session.status === 'verified') throw new Error('Till already verified');

    const people = [];
    for (const s of shares) {
      const e = await db.collection('employees').findOne({ employeeCode: s.code });
      if (!e) throw new Error(`Employee ${s.code} not found`);
      const name = `${e.firstName || ''} ${e.lastName || ''}`.trim();
      const existing = await PayrollDeduction.findOne({ employee: e._id, refNo: orderNumber }).lean();
      people.push({ ...s, id: e._id, name, existing });
    }
    const who = people.map((p) => `${p.name} (${p.code}) Rs ${p.amount}`).join(', ');
    const existingExpense = await db.collection('expenses').findOne({ sourceType: 'POSOrder', sourceRef: o._id, isDeleted: { $ne: true } });

    console.log(`Bill ${orderNumber}: Rs ${o.total}, ${o.paymentStatus}, ${session.counterName} till ${session._id} (${session.status})`);
    console.log(`Expense "${CATEGORY}" Rs ${amount}${existingExpense ? ` -> already exists ${existingExpense._id}` : ''}`);
    people.forEach((p) => console.log(`Deduction (damage, approved) ${p.name} ${p.code}: Rs ${p.amount}${p.existing ? ` -> already exists ${p.existing._id}` : ''}`));
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_damage_penalty_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`Backed up the bill to ${backup}`);

    // 1. Deductions (refId left empty: one bill can carry several people's shares).
    const now = new Date();
    for (const p of people.filter((x) => !x.existing)) {
      const d = await PayrollDeduction.create({
        employee: p.id,
        type: 'damage',
        amount: p.amount,
        date: o.createdAt,
        refType: 'POSOrder',
        refId: null,
        refNo: orderNumber,
        note: `Penalty: ${note} (bill ${orderNumber}, Rs ${amount} total). Share Rs ${p.amount}; split: ${who}.`,
        status: 'approved',
        decidedAt: now,
      });
      p.dedId = d._id;
      console.log(`Deduction created ${d._id} (${p.name})`);
    }

    // 2. Category + expense linked to the bill.
    await db.collection('expensecategories').updateOne(
      { name: CATEGORY },
      { $setOnInsert: { name: CATEGORY, description: 'Bill money not received yet (linked to the bill)', isActive: true, isDeleted: false, deletedAt: null, deletedBy: null, createdAt: now, updatedAt: now } },
      { upsert: true }
    );
    if (!existingExpense) {
      const day = new Date(o.createdAt.getTime() + 5 * 3600000).toISOString().slice(0, 10); // shop day (PKT)
      const r = await db.collection('expenses').insertOne({
        title: `Pending amount: bill ${orderNumber} (${note.toLowerCase()} - ${people.map((p) => p.name).join(', ')})`,
        amount,
        category: CATEGORY,
        categories: [CATEGORY],
        date: new Date(`${day}T00:00:00.000Z`),
        paymentMethod: 'Cash',
        bank: null,
        investment: null,
        investmentTitle: '',
        bankName: '',
        counter: session.counter || o.counter || null,
        counterName: session.counterName || '',
        reference: orderNumber,
        notes: `${note}: Rs ${amount} of bill ${orderNumber} not received - recovered by salary deduction: ${who}. Bill id ${o._id}.`,
        receipt: null,
        receipts: [],
        isActive: true,
        branch: o.branch || session.branch || null,
        source: 'manual',
        sourceType: 'POSOrder',
        sourceRef: o._id,
        originalAmount: null,
        adjustments: [],
        fromPersonal: false,
        loan: null,
        loanNo: '',
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      console.log(`Expense created ${r.insertedId}`);
    }

    // 3. Bill note (bill stays a full sale).
    await orders.updateOne(
      { _id: o._id },
      { $set: { notes: `${o.notes || ''}\n2026-11-12 owner: ${note} Rs ${amount} not paid - "${CATEGORY}" expense; salary penalty ${who}.` } }
    );

    // 4. A closed (not verified) till is worked out again; an open till picks the expense up itself.
    if (session.status === 'closed') {
      const till = require('../src/services/tillService');
      const CashSession = require('../src/models/cashSession');
      const t = await till.refreshExpenses(await CashSession.findById(session._id).lean());
      console.log('Till now:', JSON.stringify({ expenses: t.expected.expenses, expectedCash: t.expected.expectedCash, variance: t.variance }));
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
