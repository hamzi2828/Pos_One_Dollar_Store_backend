// Seeder/createDemoBranches.js
// Demo data for the BRANCHES feature, on top of the dummy products made by
// Seeder/createDemoShopProducts.js (tag "dummy-seed").
//
// - "Branch 1" (B1, main) and "Branch 2" (B2).
//   If a main branch already exists it stays the main branch; it is renamed to
//   "Branch 1" ONLY if it still has the default name "Main Branch".
// - Splits the stock of each dummy product: about 60% Branch 1, 40% Branch 2
//   (whole pieces). Products with batches: the newest batch(es) go to Branch 2.
//   Totals do not change. Products that already have stock in Branch 2 are skipped.
// - Roles "Branch Manager" and "Cashier" (created if missing, same as the migration).
// - Demo users (created only if missing; existing users are NOT changed):
//     superadmin@demo.local  super admin, all branches
//     manager.b1@demo.local  Branch Manager, Branch 1
//     cashier.b1@demo.local  Cashier, Branch 1
//     manager.b2@demo.local  Branch Manager, Branch 2
//     cashier.b2@demo.local  Cashier, Branch 2
//   Random passwords are printed ONCE at the end. Save them.
//
// Usage (from pos_backend):
//   npm run seed:demo-branches                 create (safe to re-run)
//   npm run seed:demo-branches -- --remove     delete the demo users, move dummy products'
//                                              Branch 2 stock back to Branch 1 and delete
//                                              Branch 2 if nothing else uses it

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Branch = require('../src/models/branch');
const Product = require('../src/models/product');
const User = require('../src/models/user');
const Role = require('../src/models/role');
const { ensureDefaultRoles } = require('../scripts/migrateBranches');

const TAG = 'dummy-seed';
const B2_SHARE = 0.4;

const DEMO_USERS = [
  { email: 'superadmin@demo.local', firstName: 'Super', lastName: 'Admin', superAdmin: true },
  { email: 'manager.b1@demo.local', firstName: 'Manager', lastName: 'Branch 1', role: 'Branch Manager', branch: 'B1' },
  { email: 'cashier.b1@demo.local', firstName: 'Cashier', lastName: 'Branch 1', role: 'Cashier', branch: 'B1' },
  { email: 'manager.b2@demo.local', firstName: 'Manager', lastName: 'Branch 2', role: 'Branch Manager', branch: 'B2' },
  { email: 'cashier.b2@demo.local', firstName: 'Cashier', lastName: 'Branch 2', role: 'Cashier', branch: 'B2' },
];

// ---------- helpers ----------

const idStr = (v) => (v === undefined || v === null ? null : String(v));
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const isVariantProduct = (p) => p.productType === 'variant';
const unitsOf = (p) =>
  isVariantProduct(p)
    ? (p.variants || []).map((u, i) => ({ unit: u, prefix: `variants.${i}.`, i }))
    : [{ unit: p, prefix: '', i: -1 }];

// 12 chars, no look-alike characters, at least one upper, lower and digit.
function randomPassword(len = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  for (;;) {
    const bytes = crypto.randomBytes(len);
    const pw = Array.from(bytes, (b) => all[b % all.length]).join('');
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

// Pieces of a unit per branch (old data without branchStock/batch.branch = main).
function unitByBranch(unit, mainId) {
  const out = new Map();
  const add = (k, n) => out.set(k, (out.get(k) || 0) + num(n));
  const batches = Array.isArray(unit.batches) ? unit.batches : [];
  if (batches.length) batches.forEach((b) => add(idStr(b.branch) || idStr(mainId), b.quantity));
  else if (Array.isArray(unit.branchStock) && unit.branchStock.length) unit.branchStock.forEach((r) => add(idStr(r.branch), r.stock));
  else add(idStr(mainId), unit.stock);
  return out;
}

// Plan the split of ONE unit that is fully in Branch 1. Returns the $set for it.
function planUnitSplit(unit, prefix, b1, b2) {
  const set = {};
  const batches = Array.isArray(unit.batches) ? unit.batches : [];
  if (!batches.length) {
    const total = num(unit.stock);
    const s2 = Math.floor(total * B2_SHARE);
    set[`${prefix}branchStock`] = [
      { branch: b1, stock: total - s2 },
      { branch: b2, stock: s2 },
    ];
    return set;
  }
  // Batches: newest first go to Branch 2 until ~40%, at least one stays in Branch 1.
  const total = batches.reduce((a, b) => a + num(b.quantity), 0);
  const target = Math.round(total * B2_SHARE);
  const order = batches
    .map((b, i) => ({ i, at: new Date(b.receivedAt || 0).getTime() || 0 }))
    .sort((a, b) => b.at - a.at || b.i - a.i);
  const toB2 = new Set();
  let s2 = 0;
  for (const { i } of order) {
    if (toB2.size >= batches.length - 1 || s2 >= target) break;
    toB2.add(i);
    s2 += num(batches[i].quantity);
  }
  batches.forEach((_, i) => {
    set[`${prefix}batches.${i}.branch`] = toB2.has(i) ? b2 : b1;
  });
  set[`${prefix}branchStock`] = [
    { branch: b1, stock: total - s2 },
    { branch: b2, stock: s2 },
  ];
  return set;
}

// Returns { set } to split a product, or { skip: reason }.
function planProductSplit(p, b1, b2) {
  const units = unitsOf(p);
  const set = {};
  for (const { unit } of units) {
    const by = unitByBranch(unit, b1);
    if (by.has(idStr(b2))) return { skip: 'already has Branch 2 stock' };
    const others = [...by.keys()].filter((k) => k !== idStr(b1) && k !== idStr(b2));
    if (others.length) return { skip: 'has stock in another branch' };
  }
  for (const { unit, prefix } of units) Object.assign(set, planUnitSplit(unit, prefix, b1, b2));
  if (!Object.keys(set).length) return { skip: 'no sellable units' };
  return { set };
}

// Plan moving ALL Branch 2 pieces of a product back to Branch 1 (for --remove).
function planProductMerge(p, b1, b2) {
  const set = {};
  for (const { unit, prefix } of unitsOf(p)) {
    const batches = Array.isArray(unit.batches) ? unit.batches : [];
    const by = unitByBranch(unit, b1);
    if (!by.has(idStr(b2))) continue;
    if (batches.length) {
      // Re-tag Branch 2 batches; if Branch 1 already has a batch with the same
      // batchNo, add the pieces to it and drop the Branch 2 copy.
      const kept = [];
      for (const b of batches) {
        if (idStr(b.branch) !== idStr(b2)) {
          kept.push({ ...b });
          continue;
        }
        const twin = kept.find((k) => k.batchNo === b.batchNo && (idStr(k.branch) || idStr(b1)) === idStr(b1));
        if (twin) twin.quantity = num(twin.quantity) + num(b.quantity);
        else kept.push({ ...b, branch: b1 });
      }
      set[`${prefix}batches`] = kept;
    }
    const rows = [];
    for (const [k, n] of by) {
      if (k === idStr(b2)) continue;
      rows.push({ branch: k === idStr(b1) ? b1 : new mongoose.Types.ObjectId(k), stock: n + (k === idStr(b1) ? by.get(idStr(b2)) : 0) });
    }
    if (!rows.some((r) => idStr(r.branch) === idStr(b1))) rows.unshift({ branch: b1, stock: by.get(idStr(b2)) });
    set[`${prefix}branchStock`] = rows;
  }
  return set;
}

const productFilter = (p) => {
  const f = { _id: p._id };
  if (p.updatedAt !== undefined) f.updatedAt = p.updatedAt;
  return f;
};

// ---------- branches ----------

async function ensureBranches(log) {
  // Branch 1 = the main branch (same rule as Branch.getMain(), which old stock
  // and sales without a branch belong to).
  if (!(await Branch.findOne({}))) {
    const deletedB1 = await Branch.findOne({ code: 'B1' }).setOptions({ withDeleted: true });
    if (deletedB1) {
      deletedB1.isDeleted = false;
      deletedB1.deletedAt = null;
      deletedB1.isActive = true;
      deletedB1.isMain = true;
      await deletedB1.save();
      log(`  ~ branch "${deletedB1.name}" (B1) restored as main`);
    } else {
      await Branch.create({ name: 'Branch 1', code: 'B1', isMain: true });
      log('  + branch "Branch 1" (B1, main)');
    }
  }
  const b1 = await Branch.getMain();
  if (b1.name === 'Main Branch') {
    b1.name = 'Branch 1';
    await b1.save();
    log(`  ~ renamed main branch "Main Branch" -> "Branch 1" (${b1.code})`);
  } else {
    log(`  = main branch "${b1.name}" (${b1.code}) is used as Branch 1`);
  }

  let b2 = await Branch.findOne({ code: 'B2' }).setOptions({ withDeleted: true });
  if (b2) {
    if (b2.isDeleted || b2.isActive === false) {
      b2.isDeleted = false;
      b2.deletedAt = null;
      b2.isActive = true;
      await b2.save();
      log(`  ~ branch "${b2.name}" (B2) restored`);
    } else {
      log(`  = branch "${b2.name}" (B2) exists`);
    }
  } else {
    b2 = await Branch.create({ name: 'Branch 2', code: 'B2', isMain: false });
    log('  + branch "Branch 2" (B2)');
  }
  if (idStr(b1._id) === idStr(b2._id)) throw new Error('The main branch has code B2 - give it another code first');
  return { b1, b2 };
}

// ---------- create ----------

async function splitDummyStock(b1, b2, log) {
  const products = await Product.collection.find({ tags: TAG }).toArray();
  let split = 0;
  let skipped = 0;
  for (const p of products) {
    const plan = planProductSplit(p, b1._id, b2._id);
    if (plan.skip) {
      skipped++;
      log(`  = ${p.name}: ${plan.skip}`);
      continue;
    }
    const res = await Product.collection.updateOne(productFilter(p), { $set: plan.set });
    if (!(res && (res.matchedCount ?? res.n ?? 0))) {
      skipped++;
      log(`  ! ${p.name}: changed while seeding, run again`);
      continue;
    }
    split++;
    const parts = unitsOf(p).map(({ prefix }) => {
      const rows = plan.set[`${prefix}branchStock`];
      return `${rows[0].stock}/${rows[1].stock}`;
    });
    log(`  ~ ${p.name}: B1/B2 ${parts.join(', ')}`);
  }
  log(`Stock split: ${split} product(s), skipped ${skipped}, dummy products found ${products.length}`);
}

async function createUsers(b1, b2, log) {
  const roles = await ensureDefaultRoles({ apply: true, log });
  const roleId = (name) => {
    const r = roles.roles.find((x) => x.name === name);
    return r && r.id ? new mongoose.Types.ObjectId(r.id) : null;
  };
  const branchId = { B1: b1._id, B2: b2._id };
  const created = [];
  for (const d of DEMO_USERS) {
    const exists = await User.findOne({ email: d.email }).setOptions({ withDeleted: true });
    if (exists) {
      log(`  = ${d.email} exists (not changed)`);
      continue;
    }
    const password = randomPassword(12);
    const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
    await User.create({
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email,
      password: hash,
      provider: 'local',
      role: 'admin',
      isActive: true,
      isSuperAdmin: !!d.superAdmin,
      staffRole: d.superAdmin ? null : roleId(d.role),
      branch: d.superAdmin ? null : branchId[d.branch],
    });
    created.push({ email: d.email, password, access: d.superAdmin ? 'Super admin (all branches)' : `${d.role}, ${d.branch === 'B1' ? b1.name : b2.name}` });
    log(`  + ${d.email}`);
  }
  return created;
}

async function create(log = console.log) {
  log('Branches:');
  const { b1, b2 } = await ensureBranches(log);
  log('Stock:');
  await splitDummyStock(b1, b2, log);
  log('Users:');
  const created = await createUsers(b1, b2, log);
  if (created.length) {
    log('\nNEW DEMO LOGINS - shown only once, save them now:');
    log(`  ${'Email'.padEnd(24)} ${'Password'.padEnd(14)} Access`);
    log(`  ${'-'.repeat(24)} ${'-'.repeat(14)} ${'-'.repeat(30)}`);
    for (const u of created) log(`  ${u.email.padEnd(24)} ${u.password.padEnd(14)} ${u.access}`);
  } else {
    log('\nNo new users (all demo users already exist; passwords unchanged).');
  }
  return { b1, b2, created };
}

// ---------- remove ----------

async function remove(log = console.log) {
  const emails = DEMO_USERS.map((u) => u.email);
  const res = await User.deleteMany({ email: { $in: emails } }).setOptions({ withDeleted: true });
  log(`Deleted ${res.deletedCount || 0} demo user(s)`);

  const b2 = await Branch.findOne({ code: 'B2' }).setOptions({ withDeleted: true });
  if (!b2) {
    log('Branch 2 not found - nothing else to do');
    return;
  }
  const main = await Branch.findOne({ isMain: true });
  if (!main) {
    log('No main branch - Branch 2 stock not moved, Branch 2 kept');
    return;
  }
  if (idStr(main._id) === idStr(b2._id)) {
    log('Branch 2 is the main branch - kept');
    return;
  }

  // Move dummy products' Branch 2 pieces back to the main branch.
  const dummy = await Product.collection.find({ tags: TAG }).toArray();
  let moved = 0;
  for (const p of dummy) {
    const set = planProductMerge(p, main._id, b2._id);
    if (!Object.keys(set).length) continue;
    const r = await Product.collection.updateOne(productFilter(p), { $set: set });
    if (r && (r.matchedCount ?? r.n ?? 0)) moved++;
    else log(`  ! ${p.name}: changed meanwhile, Branch 2 stock not moved`);
  }
  log(`Moved Branch 2 stock back to ${main.name} for ${moved} dummy product(s)`);

  // Anything else still pointing at Branch 2?
  const id = b2._id;
  const refs = [];
  const stockRef = await Product.collection.countDocuments({
    $or: [
      { branchStock: { $elemMatch: { branch: id, stock: { $gt: 0 } } } },
      { 'variants.branchStock': { $elemMatch: { branch: id, stock: { $gt: 0 } } } },
      { 'batches.branch': id },
      { 'variants.batches.branch': id },
    ],
  });
  if (stockRef) refs.push(`${stockRef} product(s) with stock`);
  const recordModels = [
    ['POS orders', '../src/models/posOrder'],
    ['held orders', '../src/models/heldOrder'],
    ['purchases', '../src/models/purchase'],
    ['expenses', '../src/models/expense'],
    ['users', '../src/models/user'],
  ];
  for (const [label, modPath] of recordModels) {
    const n = await require(modPath).collection.countDocuments({ branch: id });
    if (n) refs.push(`${n} ${label}`);
  }
  try {
    const StockTransfer = require('../src/models/stockTransfer');
    const n = await StockTransfer.collection.countDocuments({ $or: [{ fromBranch: id }, { toBranch: id }] });
    if (n) refs.push(`${n} stock transfer(s)`);
  } catch (_) {
    /* model not deployed yet */
  }
  if (refs.length) {
    log(`Branch 2 kept - still used by: ${refs.join(', ')}`);
    return;
  }
  await Branch.collection.deleteOne({ _id: id });
  log('Deleted Branch 2');
}

// ---------- run ----------

async function connect() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set. Check backend .env file.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Database: ${mongoose.connection.name} @ ${mongoose.connection.host}`);
}

module.exports = {
  create,
  remove,
  planProductSplit,
  planProductMerge,
  randomPassword,
  DEMO_USERS,
};

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  (async () => {
    const args = process.argv.slice(2);
    try {
      await connect();
      if (args.includes('--remove')) await remove();
      else await create();
    } catch (e) {
      console.error('Seeder failed:', e.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}
