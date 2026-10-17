// src/seeds/seedAutoCareCategories.js
// Seeds a SIMPLIFIED category structure: 7 main categories with subcategories nested underneath.
// Consolidates the previously seeded 23-parent Sehgal structure into a cleaner 7-parent tree.
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

// Old parent/child slugs from the previous Sehgal-inspired seed that no longer exist as PARENTS.
// Any of these that exist as parents in DB will be removed before the new structure is seeded.
// (Existing products referencing them by name may need to be re-seeded via `npm run seed:products`.)
const oldParentSlugsToRemove = [
  'led-lighting',
  'exterior-accessories',
  'interior-accessories',
  'modifications',
  'gadgets',
  'paint-protection-film',
  'car-mats',
  'car-wraps',
  'anti-theft-locks',
  'alloy-rims-wheels',
  'performance',
  'body-kits-extensions',
  'perfume-fragrances',
  'horns-sirens',
  'mobile-accessories',
  'fog-lamps-drl-covers',
  'wiper-blades',
  'music-stereo',
  'number-plate-accessories',
  'car-top-covers',
  'keychains-pouches',
  // older fashion-era slugs if still lingering
  'exterior-care',
  'interior-care',
  'glass-care',
  'wheel-tire-care',
  'polishing-compounds',
  'paint-protection',
  'engine-care',
  'tools-accessories',
];

// Thumbnails for each main category (Unsplash, royalty-free).
const categoryStructure = [
  {
    name: 'Lighting',
    description: 'Headlights, tail lights, DRLs, fog lamps, and interior lighting',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Headlight Bulbs', description: 'LED and HID headlight bulbs' },
      { name: 'Tail Lights', description: 'LED tail lights and assemblies' },
      { name: 'LED Strips', description: 'Flexible LED strip lighting' },
      { name: 'Interior LED Lights', description: 'Cabin and footwell LED lighting' },
      { name: 'DRL Lights', description: 'Daytime running lights' },
      { name: 'Projector Headlights', description: 'Projector-style headlight assemblies' },
      { name: 'Fog Lamps', description: 'Front and rear fog lamp kits' },
    ],
  },
  {
    name: 'Exterior',
    description: 'Body kits, wraps, mirrors, handles, and exterior accessories',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Body Kits & Bumpers', description: 'Front and rear bumpers, side skirts, lip kits' },
      { name: 'Spoilers', description: 'Rear and roof spoilers' },
      { name: 'Side Mirrors', description: 'Replacement and upgrade side mirrors' },
      { name: 'Door Handles', description: 'Chrome and carbon door handle covers' },
      { name: 'Chrome Grilles', description: 'Front grille upgrades' },
      { name: 'Emblems & Badges', description: 'Brand emblems and custom badges' },
      { name: 'Window Visors', description: 'Rain guards and window visors' },
      { name: 'Mud Flaps', description: 'Mud flaps and splash guards' },
      { name: 'Car Wraps', description: 'Vinyl, carbon fiber, and matte wraps' },
      { name: 'Paint Protection Film', description: 'PPF and paint protection solutions' },
      { name: 'Wiper Blades', description: 'Standard, hybrid, and silicone wiper blades' },
      { name: 'Car Top Covers', description: 'Full and half body car covers' },
      { name: 'Number Plate Accessories', description: 'Number plate frames, lights, and stickers' },
    ],
  },
  {
    name: 'Interior',
    description: 'Seat covers, mats, steering covers, and cabin accessories',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Seat Covers', description: 'Universal and custom seat cover sets' },
      { name: 'Steering Wheel Covers', description: 'Leather and fabric steering covers' },
      { name: 'Car Floor Mats', description: '3D, 5D, and 7D floor mats' },
      { name: 'Gear Knobs', description: 'Custom gear shift knobs' },
      { name: 'Pedal Covers', description: 'Sport pedal cover kits' },
      { name: 'Sun Shades', description: 'Windshield and window sun shades' },
      { name: 'Armrests', description: 'Center console armrests' },
      { name: 'Perfumes & Fragrances', description: 'Hanging, vent clip, and gel air fresheners' },
      { name: 'Keychains & Pouches', description: 'Leather keychains and key pouches' },
    ],
  },
  {
    name: 'Car Care',
    description: 'Cleaners, waxes, polishes, and detailing products',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Car Shampoo', description: 'pH-balanced car wash shampoos' },
      { name: 'Wax & Polish', description: 'Carnauba wax and polishing products' },
      { name: 'Ceramic Coating', description: 'Pro-grade ceramic coatings' },
      { name: 'Interior Cleaner', description: 'All-purpose interior cleaners' },
      { name: 'Glass Cleaner', description: 'Streak-free auto glass cleaners' },
      { name: 'Tire Shine', description: 'High-gloss tire shine sprays and gels' },
      { name: 'Microfiber Towels', description: 'Premium microfiber detailing towels' },
      { name: 'Wash Tools', description: 'Buckets, mitts, brushes, and wash accessories' },
    ],
  },
  {
    name: 'Wheels & Performance',
    description: 'Alloy rims, exhausts, and performance upgrades',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Alloy Rims', description: '15, 16, 17, 18 inch alloy wheel rims' },
      { name: 'Wheel Caps', description: 'Hub caps and center caps' },
      { name: 'Exhaust Systems', description: 'Performance exhaust systems and tips' },
      { name: 'Cold Air Intake', description: 'Cold air intake kits' },
      { name: 'Sports Filters', description: 'High-flow air filters' },
      { name: 'Turbo Kits', description: 'Turbocharger kits' },
      { name: 'Suspension Kits', description: 'Lowering and suspension kits' },
      { name: 'Engine Upgrades', description: 'Engine performance parts' },
    ],
  },
  {
    name: 'Electronics & Security',
    description: 'Dash cams, audio, gadgets, and anti-theft security',
    featured: true,
    thumbnailUrl: 'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Dash Cams', description: 'Front and rear dash cameras' },
      { name: 'Reverse Cameras', description: 'Backup and reverse cameras' },
      { name: 'Parking Sensors', description: 'Front and rear parking sensors' },
      { name: 'Car Stereos', description: 'Head units and car stereos' },
      { name: 'Speakers', description: 'Car speakers and components' },
      { name: 'Subwoofers', description: 'Car subwoofers and enclosures' },
      { name: 'Amplifiers', description: 'Car audio amplifiers' },
      { name: 'Phone Holders', description: 'Car phone mounts and wireless chargers' },
      { name: 'Bluetooth Kits', description: 'Bluetooth audio adapters' },
      { name: 'Horns & Sirens', description: 'Air horns, electric horns, and sirens' },
      { name: 'GPS Trackers', description: 'Vehicle GPS tracking devices' },
      { name: 'TPMS', description: 'Tire pressure monitoring systems' },
      { name: 'Anti-Theft Locks', description: 'Steering, gear, pedal, and wheel locks' },
    ],
  },
  {
    name: 'Bike Accessories',
    description: 'Motorcycle and scooter accessories',
    featured: false,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80',
    children: [
      { name: 'Bike Seat Covers', description: 'Motorcycle seat covers' },
      { name: 'Bike Locks', description: 'Motorcycle locks and security' },
      { name: 'Bike Covers', description: 'Motorcycle body covers' },
      { name: 'Bike LED Lights', description: 'LED lights for motorcycles' },
    ],
  },
];

async function seedAutoCareCategories() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // --- Step 1: Collect slugs that exist in the new structure ---
    const newParentSlugs = new Set(categoryStructure.map((c) => slugify(c.name)));
    const newChildSlugs = new Set();
    categoryStructure.forEach((p) => {
      (p.children || []).forEach((c) => newChildSlugs.add(slugify(c.name)));
    });

    // --- Step 2: Remove old parents that are no longer in the new structure ---
    // Their children will be re-parented below if their slug still exists in the new structure,
    // or deleted if they're truly obsolete.
    const deletableOldParents = oldParentSlugsToRemove.filter((s) => !newParentSlugs.has(s));
    const oldParentDocs = await Category.find({ slug: { $in: deletableOldParents }, parentId: null });
    const oldParentIds = oldParentDocs.map((c) => c._id);

    // Delete obsolete parents
    const parentDelete = await Category.deleteMany({ _id: { $in: oldParentIds } });
    console.log(`Cleanup: removed ${parentDelete.deletedCount} obsolete parent categories`);

    // Delete obsolete children whose slug is NOT in the new structure
    const childDelete = await Category.deleteMany({
      parentId: { $in: oldParentIds },
      slug: { $nin: Array.from(newChildSlugs) },
    });
    console.log(`Cleanup: removed ${childDelete.deletedCount} obsolete subcategories`);

    // --- Step 3: Upsert the new parent/child structure ---
    let parentCreated = 0;
    let parentUpdated = 0;
    let childCreated = 0;
    let childUpdated = 0;
    let sortOrder = 1;

    for (const cat of categoryStructure) {
      const parentSlug = slugify(cat.name);
      const parentPayload = {
        name: cat.name,
        slug: parentSlug,
        description: cat.description || '',
        featured: !!cat.featured,
        active: true,
        parentId: null,
        sortOrder: sortOrder++,
        thumbnailUrl: cat.thumbnailUrl || null,
        thumbnailUrls: cat.thumbnailUrl ? [cat.thumbnailUrl] : [],
      };

      let parent = await Category.findOne({ slug: parentSlug });
      if (parent) {
        await Category.findByIdAndUpdate(parent._id, parentPayload);
        console.log(`Updated parent: ${cat.name}`);
        parentUpdated++;
      } else {
        parent = await Category.create(parentPayload);
        console.log(`Created parent: ${cat.name}`);
        parentCreated++;
      }

      let childOrder = 1;
      for (const child of cat.children || []) {
        const childSlug = slugify(child.name);
        const childPayload = {
          name: child.name,
          slug: childSlug,
          description: child.description || '',
          featured: false,
          active: true,
          parentId: parent._id,
          sortOrder: childOrder++,
        };

        const existingChild = await Category.findOne({ slug: childSlug });
        if (existingChild) {
          await Category.findByIdAndUpdate(existingChild._id, childPayload);
          console.log(`  Updated child: ${child.name}`);
          childUpdated++;
        } else {
          await Category.create(childPayload);
          console.log(`  Created child: ${child.name}`);
          childCreated++;
        }
      }
    }

    console.log('\n========================================');
    console.log('Auto-care categories seeded successfully!');
    console.log(`Parents -> created: ${parentCreated}, updated: ${parentUpdated}`);
    console.log(`Children -> created: ${childCreated}, updated: ${childUpdated}`);
    console.log('========================================\n');

    const totalParents = await Category.countDocuments({ parentId: null });
    const totalChildren = await Category.countDocuments({ parentId: { $ne: null } });
    console.log(`Total parent categories: ${totalParents}`);
    console.log(`Total subcategories:     ${totalChildren}`);
  } catch (error) {
    console.error('Error seeding auto-care categories:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedAutoCareCategories();
