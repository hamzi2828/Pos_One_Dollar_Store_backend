// Give a role a permission (adds the actions; never removes any).
//
//   node scripts/grantRolePermission.js --role Cashier --key till_expenses --actions view,create,edit          -> DRY RUN
//   ... --apply                                                                                                 -> writes
//
// The key and actions must exist in src/constants/rolePermissions.js. Users get it within
// ~30 s (access cache) or at their next sign-in.

const DB_NAME = 'pos_mirpur_dollar_shop';
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const a = process.argv.slice(2);
  const apply = a.includes('--apply');
  const roleName = String(arg(a, '--role') || '').trim();
  const key = String(arg(a, '--key') || '').trim();
  const actions = String(arg(a, '--actions') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!roleName || !key || !actions.length) throw new Error('Usage: --role <name> --key <permission key> --actions view,create,edit [--apply]');

  const { PERMISSION_GROUPS } = require('../src/constants/rolePermissions');
  const group = PERMISSION_GROUPS.find((g) => g.key === key);
  if (!group) throw new Error(`Unknown permission key ${key}`);
  const bad = actions.filter((x) => !group.actions.includes(x));
  if (bad.length) throw new Error(`${key} has no action(s) ${bad.join(', ')} (allowed: ${group.actions.join(', ')})`);

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  try {
    if (mongoose.connection.name !== DB_NAME) throw new Error(`Wrong database ${mongoose.connection.name}`);
    const roles = mongoose.connection.db.collection('roles');
    const list = await roles.find({ name: new RegExp(`^${escapeRx(roleName)}$`, 'i'), isDeleted: { $ne: true } }).toArray();
    if (!list.length) throw new Error(`No role named ${roleName}`);
    const users = mongoose.connection.db.collection('users');
    console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run (nothing is written)\n');
    for (const r of list) {
      const perms = r.permissions || {};
      const now = Array.isArray(perms[key]) ? perms[key] : [];
      const next = group.actions.filter((x) => now.includes(x) || actions.includes(x));
      const n = await users.countDocuments({ staffRole: r._id });
      console.log(`Role ${r.name} (${n} user${n === 1 ? '' : 's'}): ${key} [${now.join(', ') || 'none'}] -> [${next.join(', ')}]`);
      if (apply && next.join() !== now.join()) {
        await roles.updateOne({ _id: r._id }, { $set: { [`permissions.${key}`]: next, updatedAt: new Date() } });
        console.log('  saved');
      }
    }
    if (!apply) console.log('\nDry run only. Run again with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
