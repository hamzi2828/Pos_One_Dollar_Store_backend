// Owner 2026-11-12: a bill whose money has NOT come in yet is shown as a FULL sale,
// and the unpaid amount as a cash expense in category "Pending Amount", linked to the
// bill (reference = bill no, sourceType 'POSOrder', sourceRef = bill id). The expense
// comes off the bill's till under "Expenses, payments & trip costs".
//
//   node scripts/pendingAmountExpense.js --order POS-20261111-977235-2615 --who "Raja Asim"            -> DRY RUN
//   node scripts/pendingAmountExpense.js --order POS-20261111-977235-2615 --who "Raja Asim" --apply    -> writes
//
// The bill: if pending, it is made a full cash sale (cash taken at the bill time, by its cashier).
// The expense: dated the bill's day, Cash, the bill's counter + branch -> lands on that counter's till.
// A closed (not verified) till is worked out again. Verified till: refused. Bill backed up first.

const DB_NAME = 'pos_mirpur_dollar_shop';
const CATEGORY = 'Pending Amount';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orderNumber = String(arg(args, '--order') || '').trim();
  const who = String(arg(args, '--who') || '').trim();
  if (!orderNumber) throw new Error('Usage: --order <bill no> [--who <name>] [--apply]');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run\n');

    const orders = db.collection('posorders');
    const o = await orders.findOne({ orderNumber, isDeleted: { $ne: true } });
    if (!o) throw new Error(`Bill ${orderNumber} not found`);
    const session = o.cashSession ? await db.collection('cashsessions').findOne({ _id: o.cashSession }) : null;
    if (!session) throw new Error('Bill has no till');
    if (session.status === 'verified') throw new Error('Till already verified');
    const existing = await db.collection('expenses').findOne({ sourceType: 'POSOrder', sourceRef: o._id, isDeleted: { $ne: true } });
    const amount = round2(o.paymentStatus === 'full' ? o.total : o.pendingAmount || o.total);
    const makeFull = o.paymentStatus !== 'full';

    console.log(`Bill ${orderNumber}: Rs ${o.total}, ${o.paymentStatus}, paid ${o.paidAmount}, pending ${o.pendingAmount || 0}`);
    console.log(`  -> ${makeFull ? `full cash sale (cash Rs ${o.total})` : 'already full'}`);
    console.log(`Expense "${CATEGORY}" Rs ${amount} on ${session.counterName} till ${session._id} (${session.status})${existing ? ` -> already exists ${existing._id}` : ''}`);
    if (!apply) return console.log('\nDRY RUN: nothing written. Run again with --apply.');

    const backup = `_backup_pending_expense_${Date.now()}`;
    await db.collection(backup).insertOne({ collection: 'posorders', originalId: o._id, doc: o });
    console.log(`Backed up the bill to ${backup}`);

    // 1. Bill -> full cash sale.
    if (makeFull) {
      const paidAt = new Date(o.createdAt);
      const set = {
        paidAmount: o.total,
        pendingAmount: 0,
        paymentStatus: 'full',
        orderStatus: 'completed',
        paymentMethod: 'cash',
        cashAmount: o.total,
        changeGiven: 0,
        completedAt: paidAt,
        paymentHistory: [
          { _id: new mongoose.Types.ObjectId(), amount: o.total, paymentMethod: 'cash', paidAt, receivedBy: o.cashier, note: 'Full payment', paymentStatus: 'full' },
        ],
        notes: `${o.notes || ''}\n2026-11-12 owner: shown as full sale; the Rs ${amount} not received is the "${CATEGORY}" expense${who ? ` against ${who}` : ''}.`,
      };
      await orders.updateOne({ _id: o._id }, { $set: set });
      console.log('Bill made a full cash sale');
    }

    // 2. Category.
    await db.collection('expensecategories').updateOne(
      { name: CATEGORY },
      { $setOnInsert: { name: CATEGORY, description: 'Bill money not received yet (linked to the bill)', isActive: true, isDeleted: false, deletedAt: null, deletedBy: null, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );

    // 3. Expense linked to the bill.
    if (!existing) {
      const day = new Date(o.createdAt.getTime() + 5 * 3600000).toISOString().slice(0, 10); // shop day (PKT)
      const now = new Date();
      const r = await db.collection('expenses').insertOne({
        title: `Pending amount: bill ${orderNumber}${who ? ` (${who})` : ''}`,
        amount,
        category: CATEGORY,
        categories: [CATEGORY],
        date: new Date(`${day}T00:00:00.000Z`),
        paymentMethod: 'Cash',
        bank: null,
        investment: null,
        investmentTitle: '',
        bankName: '',
        counter: session.counter || null,
        counterName: session.counterName || '',
        reference: orderNumber,
        notes: `Money for bill ${orderNumber} not received yet${who ? ` - against ${who}` : ''}. Bill id ${o._id}.`,
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

    // 4. Till.
    if (session.status === 'closed') {
      const till = require('../src/services/tillService');
      await till.refreshClosedSales(session._id, { note: `${orderNumber}: full sale; Rs ${amount} as "${CATEGORY}" expense` });
      const CashSession = require('../src/models/cashSession');
      const t = await till.refreshExpenses(await CashSession.findById(session._id).lean());
      console.log('Till now:', JSON.stringify({ cashSales: t.expected.cashSales, expenses: t.expected.expenses, expectedCash: t.expected.expectedCash, variance: t.variance }));
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
