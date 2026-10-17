// Seeder/createDemoShopProducts.js
// Dummy products for a MOBILE SHOP and a STATIONERY SHOP that use every
// product shape: simple items, variants (phones), boxes, batches, extra barcodes.
//
// Goes through the real createProductService, so short codes, batch codes,
// full-box codes and duplicate checks are made exactly like the admin form.
//
// All products: tag "dummy-seed", slug starts with "demo-", displayOn "pos"
// (not shown on the website), status "published".
//
// Usage (from pos_backend):
//   node Seeder/createDemoShopProducts.js --check    show which database, counts; writes nothing
//   node Seeder/createDemoShopProducts.js            create (skips ones that already exist)
//   node Seeder/createDemoShopProducts.js --remove   delete all dummy products + demo categories

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/product');
const Category = require('../src/models/category');
const createProductService = require('../src/services/products/createProductService');
const { variantLabel } = require('../src/helper/productCodes');

const TAG = 'dummy-seed';
const CATEGORY_NOTE = 'Demo category (dummy-seed)';

// Fake maker barcodes in the 200-299 "in-store" EAN range, so they can never
// clash with real retail barcodes. Valid EAN-13 check digit.
let eanCounter = 0;
const fakeEan = () => {
  eanCounter += 1;
  const base = `2009${String(eanCounter).padStart(8, '0')}`; // 12 digits
  const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
};
const ean = (label = 'manufacturer') => ({ code: fakeEan(), qty: 1, label });

const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

// ---------- Categories ----------
const CATEGORIES = [
  { name: 'Mobile Phones', children: ['Smartphones', 'Feature Phones'] },
  { name: 'Mobile Accessories', children: ['Chargers & Cables', 'Protection', 'Audio', 'Power & Storage'] },
  { name: 'Stationery', children: ['Pens & Pencils', 'Paper & Notebooks', 'Office Supplies', 'Art & School'] },
];

// ---------- Products ----------
// v(attrs, price, stock, extra) -> one phone/variant row
// Color goes in the normal `color` field (website uses it); the rest in attributes.
const v = (attributes, price, stock, extra = {}) => {
  const { Color, ...rest } = attributes;
  return {
    color: Color || '',
    attributes: Object.keys(rest).length ? rest : undefined,
    price,
    stock,
    ...extra,
  };
};

const PRODUCTS = [
  // ======================= MOBILE SHOP =======================
  // --- Phones with variants (Storage / RAM / Color) ---
  {
    name: 'Samsung Galaxy A15',
    category: 'Mobile Phones', subCategory: 'Smartphones',
    productType: 'variant',
    shortDescription: '6.5" Super AMOLED, 50MP camera, 5000mAh battery.',
    variants: [
      v({ Storage: '128GB', RAM: '6GB', Color: 'Black' }, 52999, 4, { costPrice: 48500, barcodes: [ean()] }),
      v({ Storage: '128GB', RAM: '6GB', Color: 'Light Blue' }, 52999, 3, { costPrice: 48500, barcodes: [ean()] }),
      v({ Storage: '256GB', RAM: '8GB', Color: 'Black' }, 59999, 2, { costPrice: 55000, barcodes: [ean()] }),
    ],
  },
  {
    name: 'Apple iPhone 13',
    category: 'Mobile Phones', subCategory: 'Smartphones',
    productType: 'variant',
    shortDescription: 'A15 Bionic, dual 12MP camera, PTA approved.',
    variants: [
      v({ Storage: '128GB', Color: 'Midnight' }, 189999, 2, { costPrice: 178000, barcodes: [ean()] }),
      v({ Storage: '128GB', Color: 'Starlight' }, 189999, 1, { costPrice: 178000, barcodes: [ean()] }),
      v({ Storage: '256GB', Color: 'Midnight' }, 214999, 1, { costPrice: 201000, barcodes: [ean()] }),
    ],
  },
  {
    name: 'Infinix Hot 40i',
    category: 'Mobile Phones', subCategory: 'Smartphones',
    productType: 'variant',
    variants: [
      v({ RAM: '8GB', Storage: '128GB', Color: 'Starlit Black' }, 33999, 6, { costPrice: 30500 }),
      v({ RAM: '8GB', Storage: '256GB', Color: 'Palm Blue' }, 37999, 4, { costPrice: 34200 }),
    ],
  },
  {
    name: 'Xiaomi Redmi Note 13',
    category: 'Mobile Phones', subCategory: 'Smartphones',
    productType: 'variant',
    variants: [
      v({ RAM: '6GB', Storage: '128GB', Color: 'Midnight Black' }, 54999, 3, { costPrice: 50500 }),
      v({ RAM: '8GB', Storage: '256GB', Color: 'Ice Blue' }, 62999, 2, { costPrice: 58000 }),
      v({ RAM: '8GB', Storage: '256GB', Color: 'Mint Green' }, 62999, 2, { costPrice: 58000 }),
    ],
  },
  {
    name: 'Tecno Spark 20',
    category: 'Mobile Phones', subCategory: 'Smartphones',
    productType: 'variant',
    variants: [
      v({ RAM: '8GB', Storage: '256GB', Color: 'Gravity Black' }, 38999, 5, { costPrice: 35500 }),
      v({ RAM: '8GB', Storage: '256GB', Color: 'Cyber White' }, 38999, 3, { costPrice: 35500 }),
    ],
  },
  {
    name: 'Nokia 105 (2023)',
    category: 'Mobile Phones', subCategory: 'Feature Phones',
    productType: 'variant',
    shortDescription: 'Dual SIM keypad phone, long battery life.',
    variants: [
      v({ Color: 'Charcoal' }, 5499, 10, { costPrice: 4700 }),
      v({ Color: 'Blue' }, 5499, 8, { costPrice: 4700 }),
      v({ Color: 'Red' }, 5499, 5, { costPrice: 4700 }),
    ],
  },

  // --- Accessories: boxes ---
  {
    name: 'Tempered Glass Screen Protector (Universal 6.5")',
    category: 'Mobile Accessories', subCategory: 'Protection',
    price: 350, costPrice: 90,
    piecesPerBox: 50, boxes: 4, loosePieces: 12, addFullBoxBarcode: true,
    shortDescription: 'Box of 50. Scan the box sticker once per piece sold.',
  },
  {
    name: 'USB-C to USB-C Cable 1m',
    category: 'Mobile Accessories', subCategory: 'Chargers & Cables',
    price: 600, costPrice: 260,
    piecesPerBox: 20, boxes: 3, loosePieces: 7, addFullBoxBarcode: true,
    barcodes: [ean()],
  },
  {
    name: 'SIM Ejector Pin',
    category: 'Mobile Accessories', subCategory: 'Protection',
    price: 20, costPrice: 3,
    piecesPerBox: 100, boxes: 2, loosePieces: 40,
  },
  {
    name: 'Micro USB Cable 1m',
    category: 'Mobile Accessories', subCategory: 'Chargers & Cables',
    price: 300, costPrice: 120,
    piecesPerBox: 25, boxes: 2, loosePieces: 0, addFullBoxBarcode: true,
  },

  // --- Accessories: variants ---
  {
    name: 'Silicone Back Cover - iPhone 13',
    category: 'Mobile Accessories', subCategory: 'Protection',
    productType: 'variant',
    variants: [
      v({ Color: 'Black' }, 1200, 15, { costPrice: 450 }),
      v({ Color: 'Navy Blue' }, 1200, 10, { costPrice: 450 }),
      v({ Color: 'Pink' }, 1200, 8, { costPrice: 450 }),
    ],
  },
  {
    name: 'Wireless Earbuds Pro',
    category: 'Mobile Accessories', subCategory: 'Audio',
    productType: 'variant',
    variants: [
      v({ Color: 'White' }, 3499, 12, { costPrice: 2100, barcodes: [ean()] }),
      v({ Color: 'Black' }, 3499, 9, { costPrice: 2100, barcodes: [ean()] }),
    ],
  },

  // --- Accessories: simple items ---
  {
    name: 'Fast Charger 25W USB-C',
    category: 'Mobile Accessories', subCategory: 'Chargers & Cables',
    price: 2499, costPrice: 1500, stock: 18,
    barcodes: [ean()],
  },
  {
    name: 'Lightning to USB-C Cable 1m',
    category: 'Mobile Accessories', subCategory: 'Chargers & Cables',
    price: 1499, costPrice: 700, stock: 22,
  },
  {
    name: 'Mobile Phone Stand (Foldable)',
    category: 'Mobile Accessories', subCategory: 'Protection',
    price: 650, costPrice: 280, stock: 30,
  },
  {
    name: 'Wired Earphones 3.5mm',
    category: 'Mobile Accessories', subCategory: 'Audio',
    price: 450, costPrice: 180, stock: 40,
  },

  // --- Accessories: batches (different purchase lots / cost prices) ---
  {
    name: 'Power Bank 10000mAh',
    category: 'Mobile Accessories', subCategory: 'Power & Storage',
    price: 4299, costPrice: 3000,
    barcodes: [ean()],
    batches: [
      { quantity: 6, costPrice: 2900, receivedAt: daysAgo(60), note: 'Lot from Hall Road' },
      { quantity: 10, costPrice: 3100, receivedAt: daysAgo(5), note: 'New lot, price increased' },
    ],
  },
  {
    name: 'SanDisk microSD Card 64GB',
    category: 'Mobile Accessories', subCategory: 'Power & Storage',
    price: 1899, costPrice: 1350,
    batches: [
      { quantity: 15, costPrice: 1300, receivedAt: daysAgo(40) },
      { quantity: 20, costPrice: 1400, receivedAt: daysAgo(3) },
    ],
  },

  // ======================= STATIONERY SHOP =======================
  // --- Boxes ---
  {
    name: 'Dollar Ball Pen - Blue',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 30, costPrice: 18,
    piecesPerBox: 10, boxes: 20, loosePieces: 5, addFullBoxBarcode: true,
    barcodes: [ean()],
  },
  {
    name: 'Piano Ball Pen - Black',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 25, costPrice: 14,
    piecesPerBox: 10, boxes: 15, loosePieces: 0, addFullBoxBarcode: true,
  },
  {
    name: 'HB Pencil',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 20, costPrice: 10,
    piecesPerBox: 12, boxes: 10, loosePieces: 6, addFullBoxBarcode: true,
  },
  {
    name: 'Eraser (Small)',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 15, costPrice: 7,
    piecesPerBox: 20, boxes: 5, loosePieces: 3,
  },
  {
    name: 'Pencil Sharpener',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 25, costPrice: 11,
    piecesPerBox: 24, boxes: 4, loosePieces: 10,
  },
  {
    name: 'Staple Pins No. 10',
    category: 'Stationery', subCategory: 'Office Supplies',
    price: 40, costPrice: 22,
    piecesPerBox: 20, boxes: 3, loosePieces: 8,
    shortDescription: 'Sold per small box; carton holds 20 small boxes.',
  },

  // --- Variants ---
  {
    name: 'Gel Pen 0.5mm',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    productType: 'variant',
    piecesPerBox: 12, addFullBoxBarcode: true,
    variants: [
      v({ 'Ink Color': 'Blue' }, 60, 48, { costPrice: 35 }),
      v({ 'Ink Color': 'Black' }, 60, 36, { costPrice: 35 }),
      v({ 'Ink Color': 'Red' }, 60, 24, { costPrice: 35 }),
      v({ 'Ink Color': 'Green' }, 60, 12, { costPrice: 35 }),
    ],
  },
  {
    name: 'Whiteboard Marker',
    category: 'Stationery', subCategory: 'Office Supplies',
    productType: 'variant',
    piecesPerBox: 10, addFullBoxBarcode: true,
    variants: [
      v({ Color: 'Black' }, 120, 40, { costPrice: 70 }),
      v({ Color: 'Blue' }, 120, 30, { costPrice: 70 }),
      v({ Color: 'Red' }, 120, 20, { costPrice: 70 }),
    ],
  },
  {
    name: 'Single Line Notebook',
    category: 'Stationery', subCategory: 'Paper & Notebooks',
    productType: 'variant',
    variants: [
      v({ Pages: '100 pages' }, 120, 50, { costPrice: 75 }),
      v({ Pages: '200 pages' }, 220, 40, { costPrice: 140 }),
      v({ Pages: '300 pages' }, 320, 25, { costPrice: 210 }),
    ],
  },
  {
    name: 'Sticky Notes 3x3"',
    category: 'Stationery', subCategory: 'Office Supplies',
    productType: 'variant',
    variants: [
      v({ Color: 'Yellow' }, 150, 30, { costPrice: 85 }),
      v({ Color: 'Neon Mix' }, 180, 20, { costPrice: 100 }),
    ],
  },

  // --- Simple items ---
  {
    name: 'A4 Paper Ream 80gsm (500 sheets)',
    category: 'Stationery', subCategory: 'Paper & Notebooks',
    price: 1850, costPrice: 1550, stock: 25,
    barcodes: [ean()],
  },
  {
    name: 'Office Register 200 Pages',
    category: 'Stationery', subCategory: 'Paper & Notebooks',
    price: 450, costPrice: 300, stock: 20,
  },
  {
    name: 'Geometry Box',
    category: 'Stationery', subCategory: 'Art & School',
    price: 550, costPrice: 340, stock: 15,
  },
  {
    name: 'Highlighter Set (5 colors)',
    category: 'Stationery', subCategory: 'Office Supplies',
    price: 400, costPrice: 240, stock: 18,
  },
  {
    name: 'Scientific Calculator fx-991',
    category: 'Stationery', subCategory: 'Office Supplies',
    price: 3200, costPrice: 2500, stock: 8,
    barcodes: [ean()],
  },
  {
    name: 'Stapler (Medium)',
    category: 'Stationery', subCategory: 'Office Supplies',
    price: 650, costPrice: 420, stock: 12,
  },

  // --- Batches with expiry dates ---
  {
    name: 'Glue Stick 21g',
    category: 'Stationery', subCategory: 'Art & School',
    price: 120, costPrice: 70,
    batches: [
      { quantity: 24, costPrice: 65, expiryDate: daysFromNow(45), receivedAt: daysAgo(90) },
      { quantity: 36, costPrice: 72, expiryDate: daysFromNow(400), receivedAt: daysAgo(7) },
    ],
  },
  {
    name: 'Correction Pen',
    category: 'Stationery', subCategory: 'Pens & Pencils',
    price: 90, costPrice: 50,
    batches: [
      { quantity: 18, costPrice: 48, expiryDate: daysFromNow(120), receivedAt: daysAgo(30) },
      { quantity: 30, costPrice: 52, expiryDate: daysFromNow(500), receivedAt: daysAgo(2) },
    ],
  },
  {
    name: 'Printer Ink Bottle - Black 70ml',
    category: 'Stationery', subCategory: 'Office Supplies',
    price: 950, costPrice: 650,
    barcodes: [ean()],
    batches: [
      { quantity: 6, costPrice: 620, expiryDate: daysFromNow(200), receivedAt: daysAgo(60) },
      { quantity: 10, costPrice: 680, expiryDate: daysFromNow(700), receivedAt: daysAgo(1) },
    ],
  },
];

// ---------- helpers ----------
const slugify = (s) =>
  'demo-' +
  String(s)
    .toLowerCase()
    .replace(/["'()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function connect() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set. Check backend .env file.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Database: ${mongoose.connection.name} @ ${mongoose.connection.host}`);
}

async function ensureCategories() {
  for (const parent of CATEGORIES) {
    const slug = slugify(parent.name).replace(/^demo-/, '');
    let p = await Category.findOne({ $or: [{ slug }, { name: parent.name }] });
    if (!p) {
      p = await Category.create({ name: parent.name, slug, description: CATEGORY_NOTE, active: true });
      console.log(`  + category ${parent.name}`);
    }
    for (const child of parent.children) {
      const cslug = `${slug}-${slugify(child).replace(/^demo-/, '')}`;
      const exists = await Category.findOne({ $or: [{ slug: cslug }, { name: child, parentId: p._id }] });
      if (!exists) {
        await Category.create({ name: child, slug: cslug, description: CATEGORY_NOTE, parentId: p._id, active: true });
        console.log(`    + sub-category ${child}`);
      }
    }
  }
}

function toPayload(item) {
  const payload = {
    ...item,
    slug: slugify(item.name),
    status: 'published',
    displayOn: 'pos',
    tags: [TAG],
  };
  if (!payload.productType) payload.productType = 'single';
  if (payload.productType === 'single' && payload.stock === undefined) payload.stock = 0;
  return payload;
}

function printSummary(p) {
  const units = p.productType === 'variant'
    ? p.variants.map((x) => ({ label: variantLabel(x), u: x }))
    : [{ label: '', u: p }];
  for (const { label, u } of units) {
    const extra = (u.barcodes || []).map((b) => (b.qty > 1 ? `${b.code} (x${b.qty})` : b.code));
    const batches = (u.batches || []).map((b) => `${b.batchNo}:${b.quantity}`);
    console.log(
      `    ${String(u.shortCode).padEnd(6)} ${(label || '-').padEnd(34)} stock ${String(u.stock).padStart(4)}` +
        (extra.length ? `  codes ${extra.join(', ')}` : '') +
        (batches.length ? `  batches ${batches.join(', ')}` : '')
    );
  }
}

async function create() {
  await ensureCategories();
  let created = 0;
  let skipped = 0;
  const failed = [];
  for (const item of PRODUCTS) {
    const payload = toPayload(item);
    const exists = await Product.findOne({ slug: payload.slug }).setOptions({ withDeleted: true });
    if (exists) {
      skipped++;
      console.log(`  = ${item.name} (already exists, skipped)`);
      continue;
    }
    try {
      const p = await createProductService.createProduct(payload, {});
      // createProductService does not take tags; mark the product as dummy data.
      await Product.updateOne({ _id: p._id }, { $set: { tags: [TAG] } });
      created++;
      const how = p.batches?.length ? 'batches' : p.piecesPerBox > 1 ? `box of ${p.piecesPerBox}` : p.productType;
      console.log(`  + ${p.name}  [${how}]  /products/${p._id}/labels`);
      printSummary(p);
    } catch (e) {
      failed.push({ name: item.name, error: e.message });
      console.log(`  ! ${item.name}: ${e.message}`);
    }
  }
  console.log(`\nCreated ${created}, skipped ${skipped}, failed ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

async function remove() {
  const res = await Product.deleteMany({ tags: TAG, slug: /^demo-/ }).setOptions({ withDeleted: true });
  console.log(`Deleted ${res.deletedCount} dummy products`);
  // Remove demo categories only when no product uses them any more.
  const cats = await Category.find({ description: CATEGORY_NOTE }).sort({ parentId: -1 });
  let removed = 0;
  for (const c of cats) {
    const inUse = await Product.exists({ $or: [{ category: c.name }, { subCategory: c.name }] });
    const hasChildren = await Category.exists({ parentId: c._id });
    if (!inUse && !hasChildren) {
      await Category.deleteOne({ _id: c._id });
      removed++;
    }
  }
  console.log(`Deleted ${removed} demo categories`);
}

async function check() {
  const total = await Product.countDocuments({});
  const dummy = await Product.countDocuments({ tags: TAG });
  const cats = await Category.countDocuments({});
  console.log(`Products: ${total} (dummy: ${dummy}), categories: ${cats}`);
  console.log(`This seeder would add up to ${PRODUCTS.length} products.`);
}

(async () => {
  const args = process.argv.slice(2);
  try {
    await connect();
    if (args.includes('--check')) await check();
    else if (args.includes('--remove')) await remove();
    else await create();
  } catch (e) {
    console.error('Seeder failed:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
