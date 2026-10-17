// Seeder/createSingleProducts.js
// Creates 20 single-type products for HK Auto Care.
// Usage (from hk_autocare_backend):  node Seeder/createSingleProducts.js

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/product');

const MONGO_URI = process.env.MONGO_URI;

async function connectDB() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not set. Check backend .env file.');
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected to MongoDB database: ${mongoose.connection.name}`);
}

// Auto-care product catalog (20 entries)
const PRODUCTS = [
  {
    name: 'Premium Car Shampoo',
    category: 'Wash & Cleaning',
    subCategory: 'Shampoos',
    price: 24,
    discountedPrice: 19,
    shortDescription: 'pH-balanced foaming shampoo that lifts dirt without stripping wax.',
  },
  {
    name: 'Microfiber Wash Mitt',
    category: 'Wash & Cleaning',
    subCategory: 'Accessories',
    price: 14,
    shortDescription: 'Soft dual-sided microfiber mitt that safely traps dirt away from paint.',
  },
  {
    name: 'Wheel & Rim Cleaner',
    category: 'Wheels & Tires',
    subCategory: 'Cleaners',
    price: 18,
    discountedPrice: 14,
    shortDescription: 'Acid-free formula dissolves brake dust and road grime on contact.',
  },
  {
    name: 'Tire Shine Spray',
    category: 'Wheels & Tires',
    subCategory: 'Dressings',
    price: 16,
    shortDescription: 'Long-lasting glossy finish with UV protection for rubber.',
  },
  {
    name: 'Carnauba Car Wax',
    category: 'Paint Care',
    subCategory: 'Wax & Sealant',
    price: 32,
    discountedPrice: 27,
    shortDescription: 'Deep-warmth carnauba blend for a showroom gloss that lasts months.',
  },
  {
    name: 'Ceramic Coating Kit',
    category: 'Paint Care',
    subCategory: 'Coatings',
    price: 89,
    discountedPrice: 74,
    shortDescription: '9H ceramic coating with hydrophobic protection up to 2 years.',
  },
  {
    name: 'Clay Bar Decontamination Kit',
    category: 'Paint Care',
    subCategory: 'Decontamination',
    price: 28,
    shortDescription: 'Medium-grade clay bar with lubricant for a glass-smooth finish.',
  },
  {
    name: 'Polishing Compound',
    category: 'Paint Care',
    subCategory: 'Polish',
    price: 22,
    shortDescription: 'Removes light scratches and oxidation with a machine or by hand.',
  },
  {
    name: 'Interior Dashboard Cleaner',
    category: 'Interior Care',
    subCategory: 'Cleaners',
    price: 15,
    shortDescription: 'Non-greasy satin finish for dashboards, trim and plastics.',
  },
  {
    name: 'Leather Conditioner',
    category: 'Interior Care',
    subCategory: 'Leather',
    price: 26,
    discountedPrice: 21,
    shortDescription: 'Nourishes and protects leather seats against cracking and fading.',
  },
  {
    name: 'Fabric & Upholstery Cleaner',
    category: 'Interior Care',
    subCategory: 'Upholstery',
    price: 17,
    shortDescription: 'Deep foaming cleaner that lifts stains from carpets and cloth seats.',
  },
  {
    name: 'Glass & Windshield Cleaner',
    category: 'Interior Care',
    subCategory: 'Glass',
    price: 12,
    shortDescription: 'Streak-free ammonia-free formula safe on tinted windows.',
  },
  {
    name: 'Engine Bay Degreaser',
    category: 'Engine Care',
    subCategory: 'Degreasers',
    price: 19,
    shortDescription: 'Cuts through oil, grease and grime without damaging seals or wiring.',
  },
  {
    name: 'Headlight Restoration Kit',
    category: 'Restoration',
    subCategory: 'Headlights',
    price: 29,
    discountedPrice: 23,
    shortDescription: 'Restore yellowed, hazy headlights to factory clarity in minutes.',
  },
  {
    name: 'Trim & Plastic Restorer',
    category: 'Restoration',
    subCategory: 'Trim',
    price: 21,
    shortDescription: 'Revives faded black plastic trim with UV protection.',
  },
  {
    name: 'Microfiber Drying Towel',
    category: 'Tools & Accessories',
    subCategory: 'Towels',
    price: 16,
    shortDescription: 'Super-absorbent 1200 GSM towel dries an entire car scratch-free.',
  },
  {
    name: 'Detailing Brush Set',
    category: 'Tools & Accessories',
    subCategory: 'Brushes',
    price: 18,
    shortDescription: '5-piece boar hair brush set for vents, trim and tight spots.',
  },
  {
    name: 'Wash Bucket with Grit Guard',
    category: 'Tools & Accessories',
    subCategory: 'Buckets',
    price: 25,
    shortDescription: '20L bucket with grit guard insert to prevent swirl marks.',
  },
  {
    name: 'Car Air Freshener',
    category: 'Fragrance',
    subCategory: 'Air Fresheners',
    price: 8,
    shortDescription: 'Long-lasting hanging air freshener — fresh ocean scent.',
  },
  {
    name: 'Premium Car Cover',
    category: 'Protection',
    subCategory: 'Covers',
    price: 65,
    discountedPrice: 52,
    shortDescription: 'Waterproof, UV-resistant outdoor cover with elastic hem and buckles.',
  },
];

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') +
    '-' +
    Date.now().toString(36) +
    '-' +
    Math.floor(Math.random() * 1000)
  );
}

function placeholderImage(seed, index = 0) {
  // Stable Picsum seed → same-ish image per product, 380x480 matches the UI guidance.
  const cleanSeed = seed.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `https://picsum.photos/seed/${cleanSeed}-${index}/380/480`;
}

async function createProducts() {
  console.log(`Creating ${PRODUCTS.length} single products...\n`);

  let created = 0;
  let skipped = 0;

  for (const entry of PRODUCTS) {
    const slug = slugify(entry.name);
    const thumbnailUrl = placeholderImage(entry.name, 0);
    const bannerUrls = [1, 2, 3].map((i) => placeholderImage(entry.name, i));

    const doc = {
      name: entry.name,
      slug,
      category: entry.category,
      subCategory: entry.subCategory,
      price: entry.price,
      discountedPrice: entry.discountedPrice,
      stock: Math.floor(Math.random() * 80) + 20, // 20-100
      status: 'published',
      thumbnailUrl,
      bannerUrls,
      productType: 'single',
      displayOn: 'both',
      variants: [],
      description: `${entry.shortDescription} Engineered for HK Auto Care customers who want professional-grade results at home.`,
      shortDescription: entry.shortDescription,
      metaTitle: `${entry.name} | HK Auto Care`,
      metaDescription: entry.shortDescription,
      metaKeywords: [entry.category, entry.subCategory, 'auto care', 'car detailing']
        .filter(Boolean)
        .join(', ')
        .toLowerCase(),
      tags: [entry.category, entry.subCategory].filter(Boolean),
    };

    try {
      const existing = await Product.findOne({ name: entry.name });
      if (existing) {
        console.log(`  skip   ${entry.name} (already exists)`);
        skipped++;
        continue;
      }

      await Product.create(doc);
      created++;
      const pricing = entry.discountedPrice
        ? `$${entry.price} → $${entry.discountedPrice}`
        : `$${entry.price}`;
      console.log(`  create ${entry.name.padEnd(34)} ${entry.category.padEnd(22)} ${pricing}`);
    } catch (err) {
      console.error(`  error  ${entry.name}: ${err.message}`);
    }
  }

  return { created, skipped };
}

async function main() {
  try {
    await connectDB();
    const { created, skipped } = await createProducts();

    const singleCount = await Product.countDocuments({ productType: 'single' });
    const variantCount = await Product.countDocuments({ productType: 'variant' });

    console.log('\nSummary');
    console.log('-------');
    console.log(`  created   : ${created}`);
    console.log(`  skipped   : ${skipped}`);
    console.log(`  total single  in DB : ${singleCount}`);
    console.log(`  total variant in DB : ${variantCount}`);
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
}

main();
