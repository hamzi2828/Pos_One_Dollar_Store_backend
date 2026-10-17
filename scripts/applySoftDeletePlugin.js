// One-time script: apply softDeletePlugin to every target model file by
// inserting `<schemaVar>.plugin(require('../helper/softDeletePlugin'));`
// immediately before the `mongoose.model(...)` export line.
//
// Idempotent — if the plugin line is already present, the file is left alone.

const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, '..', 'src', 'models');

// Map: filename -> schema variable name in that file
const targets = {
  'addOn.js': 'addOnSchema',
  'addOnOption.js': 'addOnOptionSchema',
  'category.js': 'categorySchema',
  'contactModel.js': 'contactSchema',
  'discount.js': 'discountSchema',
  'fabric.js': 'fabricSchema',
  'guideline.js': 'guidelineSchema',
  'kind.js': 'kindSchema',
  'pageModel.js': 'pageSchema',
  'preorder.js': 'preorderSchema',
  'print.js': 'printSchema',
  'product.js': 'productSchema',
  'review.js': 'reviewSchema',
  'shippingOption.js': 'shippingOptionSchema',
  'size.js': 'sizeSchema',
  'style.js': 'styleSchema',
  'user.js': 'userSchema',
  // BlogCategory is a candidate too (blog category controller uses soft delete service already, verify)
  'BlogCategory.js': 'blogCategorySchema',
  'blogModel.js': 'blogSchema',
  'blogCommentModel.js': 'blogCommentSchema',
};

const pluginRequire = "require('../helper/softDeletePlugin')";

let modified = 0;
let skipped = 0;
let missing = 0;

for (const [file, schemaVar] of Object.entries(targets)) {
  const full = path.join(modelsDir, file);
  if (!fs.existsSync(full)) {
    console.warn(`SKIP (not found): ${file}`);
    missing++;
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');

  if (src.includes('softDeletePlugin')) {
    console.log(`SKIP (already patched): ${file}`);
    skipped++;
    continue;
  }

  // Find the mongoose.model('Name', schemaVar) call. We insert the plugin line
  // directly before the line that calls mongoose.model(...).
  const modelCallRegex = /^(.*mongoose\.model\(\s*['"][A-Za-z]+['"]\s*,\s*[a-zA-Z_$][\w$]*\s*\).*)$/m;
  const match = src.match(modelCallRegex);
  if (!match) {
    console.warn(`SKIP (no mongoose.model call matched): ${file}`);
    skipped++;
    continue;
  }

  const pluginLine = `${schemaVar}.plugin(${pluginRequire});\n`;
  src = src.replace(modelCallRegex, `${pluginLine}$1`);

  fs.writeFileSync(full, src, 'utf8');
  console.log(`PATCHED: ${file}`);
  modified++;
}

console.log(`\nDone. Patched: ${modified} | Skipped: ${skipped} | Missing: ${missing}`);
