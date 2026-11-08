// Re-cost a trip whose cost share (charge rate) was frozen too early (owner, 2026-11-08).
//
// Bills sent to the warehouse one at a time froze the rate on the first bill:
// GRN-2026-00005 had 46,500 ÷ ~99,600 = 46.69% instead of 46,500 ÷ 1,930,000 = 2.41%.
// For each GRN this sets the right rate = PO charges ÷ goods of ALL bills, and fixes:
//   - every live entry: landedUnitCost = costPrice × (1 + rate) (+ its stock-code row)
//   - stock rows (stockmovements) of those receipts: unitCost / totalCost
//   - batches made by those receipts: costPrice
//   - product / variant average cost (product.costPrice / variant.costPrice)
//   - POS sales since the first entry: item.costPrice, order.cogs, order.giftCost
//     (only lowered, never raised) and their sale stock rows
//
// Average cost formula (see src/services/purchasing/recostService.js):
//   A receipt that went in e = (old landed − new landed) too high per piece added
//   e × qty ÷ stockAfter to the average. Each later costed receipt keeps
//   stockBefore ÷ stockAfter of that error (sales do not change the average).
//     err(t)   = error left in the average at time t (from the stock ledger)
//     new cost = current cost − err(now)            (never below 0)
//     a sale at time t: new item cost = saved cost − err(t)
//   With no other receipt in between this is simply: new cost = current − e,
//   i.e. the same per-piece fix for the stock left and for the pieces sold.
//   ("current − Σ e × qty ÷ stock" would take the sold pieces' error twice once
//   their sales are fixed too; it is only used when the ledger has no balance.)
//
//   node scripts/recostTrip.js GRN-2026-00005 GRN-2026-00003           -> DRY RUN, shows what would change
//   node scripts/recostTrip.js GRN-2026-00005 GRN-2026-00003 --apply   -> changes it
//
// Before changing a GRN, everything it changes is copied to the collection
// _backup_recost_<grn>_<timestamp>. Running it again is a no-op.
// Only runs against the DOLLAR & Co database (pos_mirpur_dollar_shop).

const path = require('path');

const EXPECTED_DB = 'pos_mirpur_dollar_shop';

const rs = (n) => (n === null || n === undefined ? '—' : `Rs ${Math.round(Number(n) * 100) / 100}`);
const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(Number(r) * 10000) / 100}%`);

/** Copy every doc the plan changes into _backup_recost_<grn>_<ts>. -> collection name */
async function backup(db, p, ts) {
  const name = `_backup_recost_${p.grnNumber}_${ts}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const docs = [];
  const add = async (coll, ids) => {
    const uniq = [...new Map(ids.filter(Boolean).map((id) => [String(id), id])).values()];
    if (!uniq.length) return;
    const rows = await db.collection(coll).find({ _id: { $in: uniq } }).toArray();
    for (const doc of rows) docs.push({ coll, docId: doc._id, doc });
  };
  await add('goodsreceipts', [p.grnId]);
  await add('products', p.units.map((u) => u.product));
  const orderIds = p.units.flatMap((u) => u.orders.map((o) => o.orderId));
  await add('posorders', orderIds);
  const moveIds = p.units.flatMap((u) => u.receipts.map((r) => r.movementId));
  const saleMoves = orderIds.length ? await db.collection('stockmovements').find({ refType: 'POSOrder', refId: { $in: orderIds } }, { projection: { _id: 1 } }).toArray() : [];
  await add('stockmovements', [...moveIds, ...saleMoves.map((m) => m._id)]);
  const codeProducts = p.entries.length ? await db.collection('products').find({ 'stockCodes.entries': { $in: p.entries.map((e) => e.entryId) } }, { projection: { _id: 1 } }).toArray() : [];
  await add('products', codeProducts.map((d) => d._id).filter((id) => !p.units.some((u) => String(u.product) === String(id))));
  if (docs.length) await db.collection(name).insertMany(docs.map((d) => ({ ...d, backedUpAt: new Date(ts) })));
  return { name, count: docs.length };
}

function print(p, log) {
  log(`\n${p.grnNumber} (${p.poNumber}, ${p.status}) · trip charges ${rs(p.chargesTotal)} ÷ all bills ${rs(p.goodsTotal)}`);
  log(`  cost share: ${pct(p.oldRate)} -> ${pct(p.rate)}`);
  if (!p.changed) {
    log('  nothing to change (already right)');
    return;
  }
  log(`  entries re-costed: ${p.entries.length}`);
  for (const e of p.entries) log(`    #${e.entryNo} ${e.productName}: ${e.stockQty} pcs, landed ${rs(e.old)} -> ${rs(e.new)}`);
  for (const u of p.units) {
    const sold = u.orders.reduce((s, o) => s + o.items.reduce((t, it) => t + it.qty, 0), 0);
    log(`  ${u.name}: cost ${rs(u.oldCost)} -> ${rs(u.newCost)} (stock ${u.stock}${u.method === 'simple' ? ', simple formula' : ''}) · ${u.orders.length} sales (${sold} pcs)`);
  }
  const orders = p.units.flatMap((u) => u.orders);
  const less = orders.reduce((s, o) => s + o.cogsOld - o.cogsNew, 0);
  log(`  sales changed: ${new Set(orders.map((o) => String(o.orderId))).size} bills, cost of sales − ${rs(less)}`);
  for (const w of p.warnings) log(`  ! ${w}`);
}

/**
 * Run for GRN numbers. `db` = native db of a connected mongoose. -> { plans, applied, backups }
 * (The database-name check is in main(); tests call this directly.)
 */
async function run({ grnNumbers, apply = false, log = console.log, now = new Date() }) {
  const GoodsReceipt = require('../src/models/goodsReceipt');
  const recost = require('../src/services/purchasing/recostService');
  const { mongoose } = require('../src/config/mongo');
  const db = mongoose.connection.db;

  const plans = [];
  for (const no of grnNumbers) {
    const grn = await GoodsReceipt.findOne({ grnNumber: no }).select('_id').lean();
    if (!grn) throw new Error(`Goods receipt ${no} not found`);
    plans.push(await recost.plan(grn._id));
  }
  plans.forEach((p) => print(p, log));
  const m = await recost.todayMargin(plans, now);
  log(`\nToday (${m.orders} bills, sales ${rs(m.revenue)}): cost of sales ${rs(m.cogsBefore)} -> ${rs(m.cogsAfter)} · margin ${m.marginBefore}% -> ${m.marginAfter}%`);

  if (!apply) {
    log('\nDRY RUN — nothing changed. Add --apply to change it.');
    return { plans, applied: false, backups: [], margin: m };
  }
  const backups = [];
  const ts = now.getTime();
  for (const first of plans) {
    // Plan again right before writing (an earlier GRN may share products).
    const p = await recost.plan(first.grnId);
    if (!p.changed) continue;
    const b = await backup(db, p, ts);
    backups.push(b);
    log(`\n${p.grnNumber}: backup ${b.name} (${b.count} docs)`);
    await recost.apply(p, { by: { userName: 'recostTrip script' }, note: 'repair' });
    log(`${p.grnNumber}: done`);
  }
  return { plans, applied: true, backups, margin: m };
}

async function main() {
  const grnNumbers = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!grnNumbers.length) throw new Error('Usage: node scripts/recostTrip.js <GRN number> [more GRN numbers] [--apply]');

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  await ensureConnection();
  const name = mongoose.connection.db.databaseName;
  if (name !== EXPECTED_DB) throw new Error(`Refusing to run on database "${name}" (expected ${EXPECTED_DB})`);
  await run({ grnNumbers, apply });
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { run, backup };
