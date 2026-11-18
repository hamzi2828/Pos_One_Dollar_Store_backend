// Set the basic salary of every active employee who has no salary yet (owner, 2026-11-17).
//   node scripts/setBasicSalary.js            -> dry run (shows what would change)
//   node scripts/setBasicSalary.js --apply    -> saves
//   --amount=20000   basic salary (default 20000)
//   --all            also change employees who already have a salary
require('dotenv').config();
const mongoose = require('mongoose');
const Employee = require('../src/models/employee');

const apply = process.argv.includes('--apply');
const all = process.argv.includes('--all');
const amountArg = process.argv.find((a) => a.startsWith('--amount='));
const AMOUNT = amountArg ? Number(amountArg.split('=')[1]) : 20000;

(async () => {
  if (!Number.isFinite(AMOUNT) || AMOUNT <= 0) throw new Error('Bad --amount');
  await mongoose.connect(process.env.MONGO_URI);
  const list = await Employee.find({ isDeleted: { $ne: true }, status: { $in: ['active', 'on_leave'] } });
  let changed = 0;
  for (const e of list) {
    const name = `${e.firstName || ''} ${e.lastName || ''}`.trim();
    const current = Number(e.salary) || 0;
    if (current > 0 && !all) {
      console.log(`skip   ${e.employeeCode}  ${name}  (already Rs ${current})`);
      continue;
    }
    const b = e.salaryBreakdown || {};
    e.salaryBreakdown = { basic: AMOUNT, allowances: b.allowances || [] };
    e.payType = 'monthly';
    // pre-save recomputes salary = basic + allowances; set it too in case it does not run.
    const allowances = (b.allowances || []).reduce((t, a) => t + (Number(a.amount) || 0), 0);
    e.salary = AMOUNT + allowances;
    console.log(`${apply ? 'set ' : 'would'}   ${e.employeeCode}  ${name}  Rs ${current} -> basic Rs ${AMOUNT}${allowances ? ` + allowances ${allowances}` : ''}`);
    if (apply) await e.save();
    changed += 1;
  }
  console.log(`\n${changed} employee(s) ${apply ? 'updated' : 'would be updated (dry run, add --apply)'}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
