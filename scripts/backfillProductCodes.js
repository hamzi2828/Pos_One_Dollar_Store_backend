// One-time (safe to re-run) migration: give every existing product the new
// barcode fields — shortCode (per sellable unit), barcodes, batches,
// piecesPerBox and scanCodes — using the same rules as product create/update
// (src/helper/productCodes.js).
//
//   npm run migrate:product-codes                 -> DRY RUN, prints what would change
//   npm run migrate:product-codes -- --apply      -> writes to the database
//   npm run migrate:product-codes -- --limit 50   -> only the first 50 products (oldest first)
//
// Rules:
// - Only writes: shortCode, variants.N.{shortCode,barcodes,batches[,stock]},
//   barcodes, batches, piecesPerBox, scanCodes (+ stock only when batches exist).
//   Never touches SKUs, prices, names... and does not bump updatedAt.
// - Existing short codes are kept (idempotent). Products are processed oldest
//   first, one at a time, so generated codes never clash.
// - If a SKU is already used by another product (or by another variant of the
//   same product), it is left out of scanCodes for the newer one, the product
//   still gets a short code, and the clash is listed in the summary so the shop
//   can fix it.
// - Soft-deleted products are skipped (the model plugin filters them out).

const path = require('path');
const Product = require('../src/models/product');
const {
  PRODUCT_UNIT,
  normalizeCode,
  generateShortCode,
  prepareProductCodes,
  variantLabel,
} = require('../src/helper/productCodes');

// ---------- small helpers ----------

// Stable JSON: sorted keys, ObjectId -> hex, Date -> ISO, undefined dropped.
const stable = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value.toHexString === 'function') return JSON.stringify(value.toHexString());
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return `[${value.map((v) => stable(v) ?? 'null').join(',')}]`;
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
};
const same = (a, b) => stable(a) === stable(b);

const getPath = (obj, dotted) =>
  dotted.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);

const isVariantProduct = (p) => p.productType === 'variant';

// Units in a stable order with index keys (legacy variantIds may be missing/duplicated).
const unitsOf = (p) =>
  isVariantProduct(p)
    ? (p.variants || []).map((v, i) => ({ idx: i, unit: v, label: variantLabel(v) || v.variantId || `#${i + 1}` }))
    : [{ idx: PRODUCT_UNIT, unit: p, label: '' }];

// Every code a product already uses (or will keep): existing scanCodes, SKUs,
// short codes, barcodes, batch codes. Used to seed the "taken" set so a new
// short code never equals e.g. another product's (not yet indexed) SKU.
const knownCodesOf = (p) => {
  const out = new Set((p.scanCodes || []).map(normalizeCode));
  const add = (c) => {
    const n = normalizeCode(c);
    if (n) out.add(n);
  };
  const addUnit = (u) => {
    if (!u) return;
    add(u.sku);
    add(u.shortCode);
    (u.barcodes || []).forEach((b) => add(b && b.code));
    (u.batches || []).forEach((b) => b && (add(b.barcode), add(b.batchNo)));
  };
  addUnit(p);
  (p.variants || []).forEach(addUnit);
  out.delete('');
  return out;
};

// Shallow copy that prepareProductCodes may mutate without touching `orig`.
const workingCopy = (orig, droppedSkuUnits, assignedShortCodes) => {
  const work = { ...orig, variants: (orig.variants || []).map((v) => ({ ...v })) };
  for (const { idx, unit } of unitsOf(work)) {
    if (droppedSkuUnits.has(idx)) delete unit.sku;
    if (!normalizeCode(unit.shortCode) && assignedShortCodes.has(idx)) unit.shortCode = assignedShortCodes.get(idx);
  }
  return work;
};

// Build { $set, $unset, filter } from the prepared copy, keeping only real changes.
const buildUpdate = (orig, work) => {
  const set = {};
  const variant = isVariantProduct(orig);

  set.piecesPerBox = work.piecesPerBox;
  set.scanCodes = work.scanCodes;
  set.barcodes = work.barcodes || [];
  set.batches = work.batches || [];

  const filter = { _id: orig._id };
  if (variant) {
    let anyBatches = false;
    work.variants.forEach((v, i) => {
      set[`variants.${i}.shortCode`] = v.shortCode;
      set[`variants.${i}.barcodes`] = v.barcodes;
      set[`variants.${i}.batches`] = v.batches;
      if (v.batches && v.batches.length) {
        anyBatches = true;
        set[`variants.${i}.stock`] = v.stock;
      }
      // Guard: only write if the variant is still at the same position.
      if (orig.variants[i] && orig.variants[i].variantId) filter[`variants.${i}.variantId`] = orig.variants[i].variantId;
    });
    if (anyBatches) set.stock = work.stock;
  } else {
    set.shortCode = work.shortCode;
    if (work.batches && work.batches.length) set.stock = work.stock;
  }

  for (const key of Object.keys(set)) {
    if (same(set[key], getPath(orig, key))) delete set[key];
  }
  const unset = {};
  if (variant && orig.shortCode !== undefined && orig.shortCode !== null) unset.shortCode = 1;
  return { filter, set, unset };
};

// ---------- main logic (no connect/disconnect here, so it can be tested) ----------

// Main branch id for prepareProductCodes. A dry run must not create a branch,
// so when none exists yet it uses a temporary id (nothing is written anyway).
async function findMainBranchId(apply) {
  const Branch = require('../src/models/branch');
  const found =
    (await Branch.findOne({ isMain: true }).select('_id').lean()) ||
    (await Branch.findOne({}).sort({ createdAt: 1 }).select('_id').lean());
  if (found) return found._id;
  if (apply) return (await Branch.getMain())._id;
  return new (require('mongoose').Types.ObjectId)();
}

async function backfill({ apply = false, limit = 0, log = console.log, mainBranchId = null } = {}) {
  const mainId = mainBranchId || (await findMainBranchId(apply));
  const summary = {
    mode: apply ? 'APPLY' : 'DRY RUN',
    processed: 0,
    updated: 0, // in dry run: "would update"
    unchanged: 0,
    skipped: 0,
    duplicates: [], // { code, product, otherProduct, resolution }
    errors: [], // { product, message }
  };

  // 1) Light first pass over ALL products: names + every code already in use.
  const all = await Product.find(
    {},
    { name: 1, sku: 1, shortCode: 1, barcodes: 1, batches: 1, scanCodes: 1, 'variants.sku': 1, 'variants.shortCode': 1, 'variants.barcodes': 1, 'variants.batches': 1, createdAt: 1 }
  )
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const names = new Map(all.map((p) => [String(p._id), p.name]));
  const taken = new Set(); // codes nobody may get as a NEW short code
  const claims = new Map(); // code -> productId that owns it in scanCodes (DB + this run)
  for (const p of all) {
    knownCodesOf(p).forEach((c) => taken.add(c));
    (p.scanCodes || []).forEach((c) => claims.set(normalizeCode(c), String(p._id)));
  }

  const ids = all.map((p) => p._id);
  const todo = limit > 0 ? ids.slice(0, limit) : ids;
  log(`[${summary.mode}] ${all.length} products found, processing ${todo.length}.`);

  // 2) One product at a time (oldest first).
  for (const id of todo) {
    const orig = await Product.findById(id).lean();
    if (!orig) continue; // deleted meanwhile
    summary.processed++;
    const pid = String(orig._id);
    const pname = orig.name || pid;
    const units = unitsOf(orig);

    const droppedSkuUnits = new Set();
    const assigned = new Map(); // unit idx -> generated short code (reused between retries)
    let work = null;
    let failure = null;

    const recordDup = (code, otherId, resolution) =>
      summary.duplicates.push({
        code,
        product: { id: pid, name: pname },
        otherProduct: otherId && otherId !== pid ? { id: otherId, name: names.get(otherId) || otherId } : { id: pid, name: `${pname} (another variant of the same product)` },
        resolution,
      });

    // Returns true if the clash could be worked around (then we retry).
    const handleClash = (code, otherId) => {
      code = normalizeCode(code);
      // A short code we generated clashes (race with a live create) -> new one.
      for (const [idx, sc] of assigned) {
        if (sc === code) {
          assigned.delete(idx);
          return true;
        }
      }
      const sameProduct = !otherId || otherId === pid;
      let withSku = units.filter(({ idx, unit }) => !droppedSkuUnits.has(idx) && normalizeCode(unit.sku) === code);
      // Two variants share a SKU -> keep it on the first one only.
      if (sameProduct && withSku.length > 1) withSku = withSku.slice(1);
      if (!withSku.length) {
        recordDup(code, otherId, 'NOT FIXED - product skipped, fix this code by hand');
        return false;
      }
      withSku.forEach(({ idx }) => droppedSkuUnits.add(idx));
      recordDup(code, otherId, `SKU left out of scanCodes for ${withSku.map((u) => u.label || 'product').join(', ')}`);
      return true;
    };

    for (let attempt = 0; attempt < units.length + 10; attempt++) {
      // New short codes for units that have none.
      for (const { idx, unit } of units) {
        if (!normalizeCode(unit.shortCode) && !assigned.has(idx)) {
          assigned.set(idx, await generateShortCode(taken, orig._id));
        }
      }
      work = workingCopy(orig, droppedSkuUnits, assigned);
      try {
        await prepareProductCodes(work, { excludeId: orig._id, mainBranchId: mainId, defaultBranchId: mainId });
      } catch (err) {
        if (err && err.code === 'DUPLICATE_CODE') {
          if (handleClash(err.duplicateCode, err.conflictProductId ? String(err.conflictProductId) : null)) continue;
          failure = err.message;
        } else {
          failure = (err && err.message) || String(err);
        }
        break;
      }
      // Same check against codes claimed earlier in THIS run (matters in dry run,
      // where nothing was written, and for products not yet written).
      const clash = work.scanCodes.find((c) => claims.has(c) && claims.get(c) !== pid);
      if (clash) {
        if (handleClash(clash, claims.get(clash))) continue;
        failure = `Code "${clash}" is already used by product "${names.get(claims.get(clash)) || claims.get(clash)}"`;
      }
      break;
    }

    if (failure) {
      summary.skipped++;
      summary.errors.push({ product: { id: pid, name: pname }, message: failure });
      log(`  SKIP  ${pname} (${pid}): ${failure}`);
      continue;
    }

    const { filter, set, unset } = buildUpdate(orig, work);
    const changed = Object.keys(set).length + Object.keys(unset).length > 0;

    if (changed) {
      if (apply) {
        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        const res = await Product.updateOne(filter, update, { timestamps: false });
        const matched = res && (res.matchedCount ?? res.n ?? 1);
        if (!matched) {
          summary.skipped++;
          summary.errors.push({ product: { id: pid, name: pname }, message: 'Product changed while migrating, run again' });
          log(`  SKIP  ${pname} (${pid}): changed while migrating, run again`);
          continue;
        }
      }
      summary.updated++;
      const codes = isVariantProduct(work)
        ? work.variants.map((v, i) => `${units[i].label}=${v.shortCode}`).join(', ')
        : work.shortCode;
      log(`  ${apply ? 'UPDATED' : 'WOULD UPDATE'}  ${pname} (${pid}): ${codes} | scanCodes: ${work.scanCodes.join(' ')}`);
    } else {
      summary.unchanged++;
    }

    // Remember what this product now owns.
    for (const [code, owner] of claims) if (owner === pid) claims.delete(code);
    for (const c of work.scanCodes) {
      claims.set(c, pid);
      taken.add(c);
    }
  }

  // 3) Summary
  log('');
  log(`[${summary.mode}] processed: ${summary.processed} | ${apply ? 'updated' : 'would update'}: ${summary.updated} | unchanged: ${summary.unchanged} | skipped: ${summary.skipped}`);
  if (summary.duplicates.length) {
    log(`Duplicate codes (${summary.duplicates.length}) - please fix these in the product screens:`);
    for (const d of summary.duplicates) {
      log(`  "${d.code}": "${d.product.name}" (${d.product.id}) vs "${d.otherProduct.name}" (${d.otherProduct.id}) -> ${d.resolution}`);
    }
  }
  if (summary.errors.length) {
    log(`Skipped products (${summary.errors.length}):`);
    for (const e of summary.errors) log(`  "${e.product.name}" (${e.product.id}): ${e.message}`);
  }
  if (!apply) log('Dry run only. Run again with --apply to write these changes.');
  return summary;
}

const parseArgs = (argv) => {
  const args = { apply: argv.includes('--apply'), limit: 0 };
  const i = argv.findIndex((a) => a === '--limit' || a.startsWith('--limit='));
  if (i !== -1) {
    const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('--limit needs a positive number');
    args.limit = n;
  }
  return args;
};

module.exports = { backfill, parseArgs };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  (async () => {
    let code = 0;
    try {
      const args = parseArgs(process.argv.slice(2));
      await ensureConnection();
      await backfill(args);
    } catch (err) {
      console.error('Migration failed:', (err && err.message) || err);
      code = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
      process.exit(code);
    }
  })();
}
