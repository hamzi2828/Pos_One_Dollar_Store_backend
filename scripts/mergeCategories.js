// Merge one product category into another (owner, 2026-11-08).
// Products keep their category by NAME, so merging = move everything that
// uses the old name to the kept name, then delete (soft) the old category:
//   - products, racks (shelf categories), vendors (category lists)
//   - staff category assignments (renamed; if the kept category already has
//     one for the same branch, the old one is only reported, not touched)
//   - sub-categories of the old one move under the kept one
// Past sales / stock history keep the name they had (they are records of the past).
//
//   node scripts/mergeCategories.js --find food                         -> list categories whose name has "food"
//   node scripts/mergeCategories.js "<old name>" "<keep name>"          -> DRY RUN
//   node scripts/mergeCategories.js "<old name>" "<keep name>" --apply  -> merge
//
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (s) => new RegExp(`^\\s*${esc(String(s).trim())}\\s*$`, 'i');

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) throw new Error(`Refusing to run on database "${db.databaseName}" (expected ${EXPECTED_DB})`);
  const cats = db.collection('categories');
  const products = db.collection('products');
  const live = { isDeleted: { $ne: true } };

  const fi = argv.indexOf('--find');
  if (fi >= 0) {
    const rx = new RegExp(esc(argv[fi + 1] || ''), 'i');
    const rows = await cats.find({ ...live, name: rx }).project({ name: 1, parentId: 1 }).toArray();
    for (const c of rows) console.log(`"${c.name}"  · ${await products.countDocuments({ category: exact(c.name) })} products`);
    if (!rows.length) console.log('No category matches.');
    return;
  }

  const [fromName, intoName] = argv.filter((a) => !a.startsWith('--'));
  if (!fromName || !intoName) throw new Error('Usage: node scripts/mergeCategories.js "<old name>" "<keep name>" [--apply]');
  const from = await cats.findOne({ ...live, name: exact(fromName) });
  const into = await cats.findOne({ ...live, name: exact(intoName) });
  if (!from) throw new Error(`Category "${fromName}" not found`);
  if (!into) throw new Error(`Category "${intoName}" not found`);
  if (String(from._id) === String(into._id)) throw new Error('Same category twice.');
  const fromRx = exact(from.name);

  const counts = {
    products: await products.countDocuments({ category: fromRx }),
    keepProducts: await products.countDocuments({ category: exact(into.name) }),
    racks: await db.collection('racks').countDocuments({ categories: fromRx }),
    vendors: await db.collection('vendors').countDocuments({ $or: [{ categories: fromRx }, { category: fromRx }] }),
    children: await cats.countDocuments({ ...live, parentId: from._id }),
  };
  const fromAssign = await db.collection('categoryassignments').find({ categoryKey: from.name.trim().toLowerCase() }).toArray();
  const intoAssign = await db.collection('categoryassignments').find({ categoryKey: into.name.trim().toLowerCase() }).toArray();
  const clash = (a) => intoAssign.some((b) => String(b.branch || '') === String(a.branch || ''));

  console.log(`Merge "${from.name}" -> "${into.name}"`);
  console.log(`  products: ${counts.products} move (kept category has ${counts.keepProducts}; after: ${counts.products + counts.keepProducts})`);
  console.log(`  racks: ${counts.racks} · vendors: ${counts.vendors} · sub-categories: ${counts.children}`);
  console.log(`  staff assignments: ${fromAssign.length} (${fromAssign.filter(clash).length} left alone: kept category already has one)`);
  console.log(`  then "${from.name}" is deleted (soft; can be restored)`);
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Add --apply to merge.');
    return;
  }

  const now = new Date();
  await products.updateMany({ category: fromRx }, { $set: { category: into.name, updatedAt: now } });
  for (const coll of ['racks', 'vendors']) {
    const c = db.collection(coll);
    const ids = (await c.find({ categories: fromRx }).project({ _id: 1 }).toArray()).map((x) => x._id);
    if (ids.length) {
      await c.updateMany({ _id: { $in: ids } }, { $pull: { categories: fromRx } });
      await c.updateMany({ _id: { $in: ids } }, { $addToSet: { categories: into.name } });
    }
  }
  await db.collection('vendors').updateMany({ category: fromRx }, { $set: { category: into.name } });
  for (const a of fromAssign) {
    if (clash(a)) continue;
    await db.collection('categoryassignments').updateOne(
      { _id: a._id },
      { $set: { category: into.name, categoryKey: into.name.trim().toLowerCase() }, $push: { history: { at: now, action: 'merged', note: `From "${from.name}"` } } }
    );
  }
  await cats.updateMany({ ...live, parentId: from._id }, { $set: { parentId: into._id } });
  await cats.updateOne({ _id: from._id }, { $set: { isDeleted: true, deletedAt: now } });
  // The old name (and its own tags) become tags of the kept category, so typing it still finds it.
  await cats.updateOne({ _id: into._id }, { $addToSet: { tags: { $each: [from.name, ...(from.tags || [])] } } });
  console.log(`\nMerged. "${into.name}" now has ${await products.countDocuments({ category: exact(into.name) })} products; "${from.name}" deleted.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
