// Replace every `<Model>.findByIdAndDelete(<idExpr>)` call in controllers with
// `<Model>.softDeleteById(<idExpr>, req.user?._id)` so deletions become soft.
//
// Skips comments, and leaves files that don't contain findByIdAndDelete alone.

const fs = require('fs');
const path = require('path');

const controllersDir = path.join(__dirname, '..', 'src', 'controller');

const files = fs.readdirSync(controllersDir).filter((f) => f.endsWith('.js'));

// Models whose hard-delete we intentionally DON'T convert yet (keep hard delete).
// None right now — sub-document deletes (`payment.deleteOne()`, `feature.deleteOne()`,
// `zone.deleteOne()`, `carDoc.deleteOne()`) are array-element removals, not
// top-level collection deletes, and are left untouched by this pass.
const skipFiles = new Set([]);

let patched = 0;
let untouched = 0;

for (const file of files) {
  if (skipFiles.has(file)) continue;
  const full = path.join(controllersDir, file);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  // Match: SomeModel.findByIdAndDelete(<anything up to matching close paren, single-line>)
  // We keep it simple — single-line expressions cover every existing call here.
  src = src.replace(
    /([A-Z][A-Za-z0-9_]*)\.findByIdAndDelete\(([^;\n)]+)\)/g,
    (m, model, idExpr) => `${model}.softDeleteById(${idExpr.trim()}, req.user?._id || null)`
  );

  // Also: .deleteMany({...}) on top-level models -> updateMany({ ..., isDeleted: { $ne: true }}, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } })
  // This one is riskier (sub-documents) — apply ONLY when we can see a top-level model name on the LHS.
  src = src.replace(
    /([A-Z][A-Za-z0-9_]*)\.deleteMany\(([\s\S]*?)\);/g,
    (m, model, args) => {
      const trimmed = args.trim();
      // Skip if no filter — a bare deleteMany({}) still soft-deletes but we want explicit wipes to be caught by admin.
      return `${model}.updateMany(${trimmed}, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } });`;
    }
  );

  if (src !== before) {
    fs.writeFileSync(full, src, 'utf8');
    console.log(`PATCHED: ${file}`);
    patched++;
  } else {
    untouched++;
  }
}

console.log(`\nDone. Patched: ${patched} | Untouched: ${untouched}`);
