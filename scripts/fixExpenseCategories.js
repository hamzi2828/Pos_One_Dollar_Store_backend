// Put expenses in the right category (owner 2026-11-19, from the expenses review).
//
//   node scripts/fixExpenseCategories.js            -> DRY RUN (shows what would change)
//   node scripts/fixExpenseCategories.js --apply    -> writes
//
// Run inside the Coolify backend container (its MONGO_URI is the live DB).
// Safe to run again: an expense already in its new category is reported as "already done".
// Each rule must match exactly ONE expense (title start + amount + category it is in now),
// otherwise it is skipped. Refunds, partner draws and loan repayments are never touched
// (those categories are locked to their link). Amounts, dates and notes are never changed.

const DB_NAME = 'pos_mirpur_dollar_shop';

// New categories (created if missing).
const NEW_CATEGORIES = [
  ['Taxes & Fees', 'Government taxes, licence and municipal fees'],
  ['Software / Internet', 'Internet, website and software bills'],
  ['Cleaning & Supplies', 'Sweeper, cleaning items, washroom supplies'],
  ['Shop Setup / Equipment', 'One-time shop setup: equipment, fittings, sign boards (move to Assets / Investment later)'],
];

// [title starts with, amount, category now, new category]
const RULES = [
  // Generator running costs
  ['Wait for the generator petrol', 2000, 'Misc', 'Generator'],
  ['Petrol for the generator', 2000, 'Misc', 'Generator'],
  ['Paid for the generator', 4000, 'Electricity', 'Generator'],
  // Wages
  ['1,500 paid for the cashier', 1500, 'Misc', 'Salaries'],
  ['4,000 paid for the Salary', 4000, 'Misc', 'Salaries'],
  // "Tip" and "Staff Tips" were the same thing
  ['TIP for the cashier', 1300, 'Tip', 'Staff Tips'],
  ['Tip for the employees', 6300, 'Tip', 'Staff Tips'],
  ['Shopper expense', 22000, 'Misc', 'Shoping bags'],
  ['Balloons', 17700, 'Misc', 'Marketing'],
  // Water for the shop (the rest of the water is already in Food)
  ['For the water bottle', 270, 'Misc', 'Food'],
  ['water for the shop', 200, 'Misc', 'Food'],
  ['I have taken the water bottle', 110, 'Misc', 'Food'],
  ['Water bottles for the shop', 1600, 'Misc', 'Food'],
  ['Internet expense', 500, 'Misc', 'Software / Internet'],
  ['Vercel fees', 5600, 'Marketing', 'Software / Internet'],
  ['SIGN BOARD tax', 15000, 'cash', 'Taxes & Fees'],
  ['500 given to sweaper', 500, 'Repairs', 'Cleaning & Supplies'],
  ['news papers for glass cleaning', 100, 'Repairs', 'Cleaning & Supplies'],
  ['washroom accesories for shop', 150, 'Repairs', 'Cleaning & Supplies'],
  // One-time setup of the shop (not a running cost)
  ['shop use mouse', 930, 'Repairs', 'Shop Setup / Equipment'],
  ['Camera installation', 50000, 'camera', 'Shop Setup / Equipment'],
  ['Camera expense', 40000, 'camera', 'Shop Setup / Equipment'],
  ['Cash counter, cash drawer', 30800, 'Misc', 'Shop Setup / Equipment'],
  ['Signe board Venice', 30000, 'Misc', 'Shop Setup / Equipment'],
  ['Wood Pending', 21000, 'Misc', 'Shop Setup / Equipment'],
  ['Pending welding payment', 20000, 'Misc, Repairs', 'Shop Setup / Equipment'],
  ['Baskets for the shop', 13000, 'Misc', 'Shop Setup / Equipment'],
  ['2 stool for the shop', 2000, 'Misc', 'Shop Setup / Equipment'],
  ['Sign board fxing', 6000, 'Electricity', 'Shop Setup / Equipment'],
  ['generator payment', 90000, 'Generator', 'Shop Setup / Equipment'],
];

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rs = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const db = mongoose.connection.db;
    const expenses = db.collection('expenses');
    const categories = db.collection('expensecategories');
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');

    // 1. Categories
    for (const [name, description] of NEW_CATEGORIES) {
      const has = await categories.findOne({ name: new RegExp(`^${escapeRx(name)}$`, 'i'), isDeleted: { $ne: true } });
      if (has) {
        console.log(`Category "${name}": exists`);
        continue;
      }
      console.log(`Category "${name}": ${apply ? 'created' : 'would be created'}`);
      if (apply) {
        const now = new Date();
        await categories.insertOne({ name, description, isActive: true, isDeleted: false, deletedAt: null, deletedBy: null, createdAt: now, updatedAt: now, __v: 0 });
      }
    }
    console.log('');

    // 2. Expenses
    const live = { isDeleted: { $ne: true } };
    const count = { moved: 0, done: 0, skipped: 0 };
    for (const [title, amount, from, to] of RULES) {
      const base = { ...live, title: new RegExp(`^\\s*${escapeRx(title)}`, 'i'), amount: { $gte: amount - 0.5, $lte: amount + 0.5 } };
      const now = await expenses.find({ ...base, category: from }).toArray();
      const already = await expenses.countDocuments({ ...base, category: to });
      const label = `"${title}" ${rs(amount)}`;
      if (now.length === 0) {
        if (already) {
          count.done += 1;
          // Moved from the Expenses page: only `category` changed, the old `categories` list stayed.
          const stale = { ...base, category: to, categories: { $ne: [to] } };
          const n = await expenses.countDocuments(stale);
          console.log(`already done  ${label} is in ${to}${n ? (apply ? ' (category list tidied)' : ' (category list will be tidied)') : ''}`);
          if (n && apply) await expenses.updateMany(stale, { $set: { categories: [to], updatedAt: new Date() } });
        } else {
          count.skipped += 1;
          console.log(`NOT FOUND     ${label} in ${from}`);
        }
        continue;
      }
      if (now.length > 1) {
        count.skipped += 1;
        console.log(`SKIPPED       ${label}: ${now.length} expenses match, fix by hand`);
        continue;
      }
      const e = now[0];
      if (e.posOrder || e.partner || e.loanRepayLoan) {
        count.skipped += 1;
        console.log(`SKIPPED       ${label}: linked to a bill / partner / loan`);
        continue;
      }
      count.moved += 1;
      console.log(`${apply ? 'moved        ' : 'would move   '} ${label}  ${from} -> ${to}  (${String(e.date).slice(4, 15)})`);
      if (apply) await expenses.updateOne({ _id: e._id }, { $set: { category: to, categories: [to], updatedAt: new Date() } });
    }

    console.log(`\n${apply ? 'Moved' : 'Would move'} ${count.moved}, already done ${count.done}, skipped ${count.skipped}.`);

    // 3. Totals per category after the change (what the Expenses page shows)
    const totals = await expenses
      .aggregate([{ $match: live }, { $group: { _id: '$category', n: { $sum: 1 }, amount: { $sum: '$amount' } } }, { $sort: { amount: -1 } }])
      .toArray();
    console.log('\nCategory totals now:');
    for (const t of totals) console.log(`  ${String(t._id).padEnd(26)} ${String(t.n).padStart(3)}  ${rs(t.amount)}`);
    if (!apply) console.log('\nDry run only. Run again with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
