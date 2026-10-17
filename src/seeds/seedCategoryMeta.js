// src/seeds/seedCategoryMeta.js
// Seeds rich HTML descriptions and SEO meta fields (metaTitle, metaDescription, metaKeywords)
// for the 7 main parent categories used by HK Auto Care.
//
// Usage: npm run seed:category-meta
const mongoose = require('mongoose');
const Category = require('../models/category');
require('dotenv').config();

const slugify = (str) =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// Rich HTML content for each main parent category. The `description` field stores
// HTML produced by the admin rich-text editor; meta fields drive SEO/social.
const mainCategoryMeta = [
  {
    name: 'Lighting',
    description: `
<h2>Premium Car Lighting Solutions</h2>
<p>Transform the look and visibility of your vehicle with our complete range of automotive lighting. From <strong>LED headlight bulbs</strong> and <strong>projector assemblies</strong> to <strong>DRL strips</strong>, fog lamps and ambient interior lights â€” every product is hand-picked for brightness, durability and a clean factory-style fit.</p>
<h3>What you'll find here</h3>
<ul>
  <li>Headlight bulbs (LED, HID and halogen upgrades)</li>
  <li>LED tail lights and assemblies for popular Pakistani-market vehicles</li>
  <li>Flexible RGB and white LED strips for boot, dashboard and footwell</li>
  <li>Projector headlights with daytime running light rings</li>
  <li>Front and rear fog lamp kits with wiring harnesses</li>
</ul>
<p>All lighting products come with installation support and a workmanship guarantee.</p>
`.trim(),
    metaTitle: 'Car Lighting & LED Bulbs in Pakistan | HK Auto Care',
    metaDescription: 'Shop premium car LED headlights, DRLs, fog lamps, tail lights and interior lighting at HK Auto Care. Fitting available in Lahore.',
    metaKeywords: 'car lighting, LED headlights, DRL, fog lamps, projector headlights, car interior LED, HK Auto Care',
  },
  {
    name: 'Exterior',
    description: `
<h2>Exterior Styling & Protection</h2>
<p>Give your car a sharp, finished look while protecting the paint and bodywork. Our <strong>Exterior</strong> range covers everything from <strong>body kits and bumpers</strong> to <strong>vinyl wraps, paint protection film, chrome grilles, mirrors</strong> and <strong>wiper blades</strong>.</p>
<h3>Highlights</h3>
<ul>
  <li>Body kits, bumpers, lip kits and side skirts</li>
  <li>Self-healing paint protection film (PPF) and gloss/matte vinyl wraps</li>
  <li>Spoilers, window visors, mud flaps, chrome grilles</li>
  <li>Door handle covers, emblems and number plate accessories</li>
  <li>Hybrid and silicone wiper blades, full and half body covers</li>
</ul>
<p>Great fitment, OEM-grade materials, and professional installation available.</p>
`.trim(),
    metaTitle: 'Car Exterior Accessories & Body Kits | HK Auto Care',
    metaDescription: 'Body kits, vinyl wraps, PPF, chrome grilles, spoilers, mirrors, wiper blades and more. Premium car exterior accessories with fitting in Pakistan.',
    metaKeywords: 'car body kit, vinyl wrap, paint protection film, PPF, chrome grille, spoiler, wiper blades, mud flaps, HK Auto Care',
  },
  {
    name: 'Interior',
    description: `
<h2>Comfort, Style & Cabin Upgrades</h2>
<p>Refresh your daily drive with quality <strong>interior accessories</strong>. Our <strong>seat covers, 7D floor mats, steering wheel covers</strong> and <strong>armrests</strong> are tailored for the most popular Pakistani-market vehicles, with custom fits available on request.</p>
<h3>Popular categories</h3>
<ul>
  <li>Universal & custom-fit seat cover sets</li>
  <li>3D / 5D / 7D PU leather floor mats</li>
  <li>Leather and stitched steering wheel covers</li>
  <li>Center console armrests, gear knobs and pedal covers</li>
  <li>Sun shades, perfumes, fragrances and keychains</li>
</ul>
<p>Built to make every journey more comfortable while keeping your interior protected.</p>
`.trim(),
    metaTitle: 'Car Interior Accessories - Seat Covers, Floor Mats | HK Auto Care',
    metaDescription: 'Custom seat covers, 7D floor mats, steering covers, armrests and cabin accessories. Upgrade your car interior with HK Auto Care.',
    metaKeywords: 'seat covers, 7D floor mats, steering cover, car armrest, gear knob, sun shades, car perfumes, HK Auto Care',
  },
  {
    name: 'Car Care',
    description: `
<h2>Detailing & Car Care Products</h2>
<p>Keep your car looking showroom-fresh with our <strong>detailing</strong> range. From <strong>pH-balanced shampoos</strong> and <strong>carnauba waxes</strong> to <strong>professional ceramic coatings</strong>, microfiber towels and <strong>tire shine</strong>, we stock the brands trusted by professional detailers.</p>
<h3>What's inside</h3>
<ul>
  <li>Car shampoos, snow foams and pre-wash cleaners</li>
  <li>Wax, polish and ceramic coatings</li>
  <li>Interior cleaners, glass cleaners and dressings</li>
  <li>Tire shine sprays, gels and applicators</li>
  <li>Microfiber towels, mitts, buckets and wash tools</li>
</ul>
<p>Whether you're a weekend washer or a full-time enthusiast, you'll find the right product here.</p>
`.trim(),
    metaTitle: 'Car Care & Detailing Products in Pakistan | HK Auto Care',
    metaDescription: 'Premium car shampoos, ceramic coatings, polishes, tire shine, microfiber towels and detailing kits. Shop trusted brands at HK Auto Care.',
    metaKeywords: 'car shampoo, ceramic coating, car wax, tire shine, microfiber towel, car polish, car detailing Pakistan, HK Auto Care',
  },
  {
    name: 'Wheels & Performance',
    description: `
<h2>Wheels, Exhausts & Performance</h2>
<p>Upgrade your stance and your engine. Our <strong>Wheels &amp; Performance</strong> section features <strong>alloy rims (15"â€“18")</strong>, <strong>performance exhaust systems</strong>, <strong>cold air intakes</strong>, <strong>sport filters</strong> and <strong>suspension kits</strong> for daily driving and motorsport-inspired builds.</p>
<h3>Available in store</h3>
<ul>
  <li>Alloy rims and OEM hub caps</li>
  <li>Cat-back exhaust systems and tips</li>
  <li>Cold air intakes and high-flow sport filters</li>
  <li>Turbo kits, lowering / suspension kits and engine upgrades</li>
</ul>
<p>Tested fitment, road-tuned performance, and clean installation by our workshop team.</p>
`.trim(),
    metaTitle: 'Alloy Rims, Exhausts & Car Performance Parts | HK Auto Care',
    metaDescription: 'Alloy rims, performance exhausts, cold air intakes, sport filters and suspension kits. Upgrade your wheels and power at HK Auto Care.',
    metaKeywords: 'alloy rims, car exhaust, cold air intake, sport filter, suspension kit, turbo kit, performance parts, HK Auto Care',
  },
  {
    name: 'Electronics & Security',
    description: `
<h2>Smart Electronics & Vehicle Security</h2>
<p>Drive smarter and safer with our <strong>electronics &amp; security</strong> line-up. From <strong>dash cams</strong> and <strong>reverse cameras</strong> to <strong>parking sensors</strong>, <strong>GPS trackers</strong>, <strong>tire pressure monitors</strong> and <strong>anti-theft locks</strong> â€” everything you need to stay protected and connected on the road.</p>
<h3>Featured</h3>
<ul>
  <li>Front + rear dash cams with night vision</li>
  <li>Backup cameras and parking sensor kits</li>
  <li>Car stereos, speakers, subwoofers and amplifiers</li>
  <li>Phone holders, wireless chargers and Bluetooth kits</li>
  <li>Air horns, GPS trackers, TPMS and anti-theft locks</li>
</ul>
<p>Pair any product with our professional fitment for a clean, factory-style install.</p>
`.trim(),
    metaTitle: 'Car Dash Cams, Stereos & Security Devices | HK Auto Care',
    metaDescription: 'Shop dash cams, reverse cameras, parking sensors, car stereos, GPS trackers, TPMS and anti-theft locks at HK Auto Care.',
    metaKeywords: 'dash cam, reverse camera, parking sensor, car stereo, subwoofer, GPS tracker, TPMS, anti-theft lock, HK Auto Care',
  },
  {
    name: 'Bike Accessories',
    description: `
<h2>Motorcycle & Scooter Accessories</h2>
<p>Style and protect your two-wheeler with our growing range of <strong>bike accessories</strong>. We stock <strong>seat covers</strong>, <strong>body covers</strong>, <strong>LED lights</strong> and <strong>locks</strong> for the most popular bikes and scooters in Pakistan.</p>
<h3>What's available</h3>
<ul>
  <li>Custom-fit motorcycle seat covers</li>
  <li>Heavy-duty bike disc and chain locks</li>
  <li>Weatherproof full bike body covers</li>
  <li>LED lighting upgrades for motorcycles</li>
</ul>
<p>Affordable, durable and ready to ride.</p>
`.trim(),
    metaTitle: 'Motorcycle & Bike Accessories in Pakistan | HK Auto Care',
    metaDescription: 'Bike seat covers, body covers, LED lights and locks for motorcycles and scooters. Shop bike accessories at HK Auto Care.',
    metaKeywords: 'bike accessories, motorcycle seat cover, bike cover, bike LED, motorcycle lock, HK Auto Care',
  },
];

async function seedCategoryMeta() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    let updated = 0;
    let missing = 0;

    for (const cat of mainCategoryMeta) {
      const slug = slugify(cat.name);
      const result = await Category.findOneAndUpdate(
        { slug, parentId: null },
        {
          $set: {
            description: cat.description,
            metaTitle: cat.metaTitle,
            metaDescription: cat.metaDescription,
            metaKeywords: cat.metaKeywords,
          },
        },
        { new: true }
      );

      if (result) {
        console.log(`Updated meta + description: ${cat.name}`);
        updated++;
      } else {
        console.warn(`Skipped (not found as parent): ${cat.name} [slug: ${slug}]`);
        missing++;
      }
    }

    console.log('\n========================================');
    console.log('Category meta seeding complete!');
    console.log(`Updated: ${updated} | Missing: ${missing}`);
    console.log('========================================\n');
  } catch (error) {
    console.error('Error seeding category meta:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

seedCategoryMeta();
