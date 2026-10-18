// Seeder/seedDollarStore.js — set up the DOLLAR & Co shop.
//
//   npm run seed:dollar-store
//
// Creates what is missing and prints what it created vs skipped (safe to re-run):
//   - shop settings: name "DOLLAR & Co", currency PKR, time zone Asia/Karachi
//   - the shop (main branch) named "DOLLAR & Co"
//   - the Admin role + the ready-made roles (constants/rolePermissions.js DEFAULT_ROLES)
//   - dollar-store product categories and price tiers (Rs 99 ... Rs 999)
//   - racks A1–D20 with 4 shelves each
//   - sale counter "Counter 1" (10:00–22:00, float Rs 5,000)
//   - expense categories
// Existing records are never changed, except the shop name / currency / time
// zone in settings and the shop's name, which are set to the values above.
const mongoose = require('mongoose');
const Settings = require('../src/models/settings');
const Branch = require('../src/models/branch');
const Role = require('../src/models/role');
const Category = require('../src/models/category');
const PriceTier = require('../src/models/priceTier');
const SaleCounter = require('../src/models/saleCounter');
const ExpenseCategory = require('../src/models/expenseCategory');
const config = require('../src/services/configService');
const priceTierService = require('../src/services/sales/priceTierService');
const racksService = require('../src/services/inventory/racksService');
const { ensureAdminRole, createDefaultRoles } = require('../src/controller/roleController');

const SHOP = { siteName: 'DOLLAR & Co', currency: 'PKR', timezone: 'Asia/Karachi' };

const CATEGORIES = [
  'Kitchen & Dining',
  'Home Decor',
  'Storage & Organisers',
  'Cleaning',
  'Bath',
  'Stationery',
  'Toys',
  'Beauty & Personal Care',
  'Gifts',
  'Plastic Ware',
  'Seasonal',
];

const PRICE_TIERS = [
  { price: 99, color: '#22C55E' },
  { price: 150, color: '#14B8A6' },
  { price: 199, color: '#3B82F6' },
  { price: 280, color: '#F59E0B' },
  { price: 499, color: '#EF4444' },
  { price: 999, color: '#8B5CF6' },
];

const RACKS = { zones: ['A', 'B', 'C', 'D'], racksPerZone: 20, shelvesPerRack: 4 };

const COUNTER = { name: 'Counter 1', code: 'C1', openCutoff: '10:00', closeCutoff: '22:00', defaultFloat: 5000 };

const EXPENSE_CATEGORIES = [
  'Shop Use (from stock)',
  'Rent',
  'Electricity',
  'Salaries',
  'Transport',
  'Packaging',
  'Repairs',
  'Misc',
];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameName = (name) => new RegExp(`^${escapeRegex(name)}$`, 'i');
const slugify = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Run `create` for each item unless `exists` finds it. -> { created: [labels], skipped: [labels] } */
async function ensureEach(items, { label, exists, create }) {
  const out = { created: [], skipped: [] };
  for (const item of items) {
    if (await exists(item)) out.skipped.push(label(item));
    else {
      await create(item);
      out.created.push(label(item));
    }
  }
  return out;
}

async function seedSettings() {
  const current = await Settings.findOne({ isActive: true });
  if (!current) {
    await Settings.create({ ...Settings.DEFAULTS, ...SHOP, isActive: true });
    return { created: ['settings'], skipped: [] };
  }
  const changed = Object.keys(SHOP).filter((k) => current[k] !== SHOP[k]);
  if (!changed.length) return { created: [], skipped: ['settings'] };
  await Settings.updateSettings(SHOP);
  return { created: [], skipped: [], updated: changed };
}

async function seedShop() {
  const existed = await Branch.exists({});
  const shop = await Branch.getMain();
  if (shop.name !== Branch.SHOP_DEFAULTS.name) {
    shop.name = Branch.SHOP_DEFAULTS.name;
    await shop.save();
    return { shop, result: { created: [], skipped: [], updated: ['name'] } };
  }
  return { shop, result: existed ? { created: [], skipped: [shop.name] } : { created: [shop.name], skipped: [] } };
}

async function seedTimezone() {
  if (await config.get('store.timezone', null)) return { created: [], skipped: ['store.timezone'] };
  await config.set('store.timezone', SHOP.timezone);
  return { created: ['store.timezone'], skipped: [] };
}

async function seedRoles() {
  const hadAdmin = await Role.exists({ isSystem: true, isDeleted: { $ne: true } });
  await ensureAdminRole();
  const { created, skipped } = await createDefaultRoles();
  return hadAdmin ? { created, skipped: ['Admin', ...skipped] } : { created: ['Admin', ...created], skipped };
}

const seedCategories = () =>
  ensureEach(CATEGORIES.map((name, i) => ({ name, sortOrder: i })), {
    label: (c) => c.name,
    // Deleted ones count too: their slug is still taken.
    exists: (c) => Category.exists({ $or: [{ slug: slugify(c.name) }, { name: sameName(c.name) }] }).setOptions({ withDeleted: true }),
    create: (c) => Category.create({ name: c.name, slug: slugify(c.name), active: true, sortOrder: c.sortOrder }),
  });

const seedPriceTiers = () =>
  ensureEach(PRICE_TIERS.map((t, i) => ({ ...t, name: `Rs ${t.price}`, sortOrder: i })), {
    label: (t) => t.name,
    exists: (t) => PriceTier.exists({ $or: [{ name: sameName(t.name) }, { price: t.price }] }),
    create: (t) => priceTierService.create(t),
  });

async function seedRacks(shopId) {
  const r = await racksService.generateLayout({ branchId: shopId, ...RACKS });
  const counts = (racks, shelves) => [racks && `${racks} racks`, shelves && `${shelves} shelves`].filter(Boolean);
  return { created: counts(r.racksCreated, r.shelvesCreated), skipped: counts(r.racksSkipped, r.shelvesSkipped) };
}

const seedCounter = (shopId) =>
  ensureEach([COUNTER], {
    label: (c) => c.name,
    exists: (c) => SaleCounter.exists({ branch: shopId, $or: [{ name: sameName(c.name) }, { code: c.code }] }),
    create: (c) => SaleCounter.create({ ...c, branch: shopId, isActive: true }),
  });

const seedExpenseCategories = () =>
  ensureEach(EXPENSE_CATEGORIES, {
    label: (name) => name,
    // The name is unique even among deleted categories.
    exists: (name) => ExpenseCategory.exists({ name: sameName(name) }),
    create: (name) => ExpenseCategory.create({ name, isActive: true }),
  });

/** Set up the shop on the current mongoose connection. Returns { section: { created, skipped, updated? } }. */
async function seedDollarStore() {
  const summary = {};
  summary.settings = await seedSettings();
  const { shop, result } = await seedShop();
  summary.shop = result;
  summary.timezone = await seedTimezone();
  summary.roles = await seedRoles();
  summary.categories = await seedCategories();
  summary.priceTiers = await seedPriceTiers();
  summary.racks = await seedRacks(String(shop._id));
  summary.counter = await seedCounter(shop._id);
  summary.expenseCategories = await seedExpenseCategories();
  return summary;
}

function printSummary(summary) {
  for (const [section, r] of Object.entries(summary)) {
    const parts = [`created: ${r.created.length ? r.created.join(', ') : '-'}`, `skipped: ${r.skipped.length ? r.skipped.join(', ') : '-'}`];
    if (r.updated) parts.push(`updated: ${r.updated.join(', ')}`);
    console.log(`${section.padEnd(18)} ${parts.join(' | ')}`);
  }
}

async function main() {
  require('dotenv').config();
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (see .env.example)');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    printSummary(await seedDollarStore());
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('seed:dollar-store failed:', err.message);
    process.exit(1);
  });
}

module.exports = { seedDollarStore };
