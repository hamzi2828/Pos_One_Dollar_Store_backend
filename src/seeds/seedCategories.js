// src/seeds/seedCategories.js
const mongoose = require('mongoose');
const Category = require('../models/category');
require('dotenv').config();

const slugify = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// HK Auto Care category structure with parent â†’ children relationships.
// Child slugs are prefixed to keep them unique across parents.
const categoryStructure = [
  {
    name: 'Wash & Cleaning',
    slug: 'wash-cleaning',
    description: 'Shampoos, soaps and wash accessories for a scratch-free wash.',
    featured: true,
    active: true,
    children: [
      { name: 'Shampoos', slug: 'wash-shampoos', description: 'pH-balanced shampoos and snow foams.' },
      { name: 'Accessories', slug: 'wash-accessories', description: 'Mitts, sponges and wash pads.' },
      { name: 'Pre-Wash', slug: 'wash-pre-wash', description: 'Snow foams and citrus pre-wash cleaners.' },
    ],
  },
  {
    name: 'Wheels & Tires',
    slug: 'wheels-tires',
    description: 'Cleaners and dressings for alloys, rims and rubber.',
    featured: true,
    active: true,
    children: [
      { name: 'Cleaners', slug: 'wheel-cleaners', description: 'Acid-free wheel and brake dust cleaners.' },
      { name: 'Dressings', slug: 'tire-dressings', description: 'Glossy and satin finish tire shine.' },
      { name: 'Brushes', slug: 'wheel-brushes', description: 'Soft-bristle brushes for rims and barrels.' },
    ],
  },
  {
    name: 'Paint Care',
    slug: 'paint-care',
    description: 'Polish, wax, sealants and ceramic coatings for paintwork.',
    featured: true,
    active: true,
    children: [
      { name: 'Polish', slug: 'paint-polish', description: 'Compounds and polishes for swirl and scratch removal.' },
      { name: 'Wax & Sealant', slug: 'paint-wax-sealant', description: 'Carnauba wax and synthetic paint sealants.' },
      { name: 'Coatings', slug: 'paint-coatings', description: 'Ceramic and graphene protection coatings.' },
      { name: 'Decontamination', slug: 'paint-decontamination', description: 'Clay bars, iron removers and tar removers.' },
    ],
  },
  {
    name: 'Interior Care',
    slug: 'interior-care',
    description: 'Dashboards, leather, fabric and glass interior products.',
    featured: true,
    active: true,
    children: [
      { name: 'Cleaners', slug: 'interior-cleaners', description: 'All-purpose dashboard and plastic cleaners.' },
      { name: 'Leather', slug: 'interior-leather', description: 'Leather cleaners and conditioners.' },
      { name: 'Upholstery', slug: 'interior-upholstery', description: 'Fabric, carpet and upholstery care.' },
      { name: 'Glass', slug: 'interior-glass', description: 'Streak-free glass and windshield cleaners.' },
    ],
  },
  {
    name: 'Engine Care',
    slug: 'engine-care',
    description: 'Engine bay cleaners, degreasers and dressings.',
    featured: false,
    active: true,
    children: [
      { name: 'Degreasers', slug: 'engine-degreasers', description: 'Heavy-duty engine bay degreasers.' },
      { name: 'Dressings', slug: 'engine-dressings', description: 'Engine bay plastic and rubber dressings.' },
    ],
  },
  {
    name: 'Restoration',
    slug: 'restoration',
    description: 'Bring faded plastics, trim and headlights back to life.',
    featured: false,
    active: true,
    children: [
      { name: 'Headlights', slug: 'restoration-headlights', description: 'Headlight restoration kits and compounds.' },
      { name: 'Trim', slug: 'restoration-trim', description: 'Plastic and rubber trim restorers.' },
    ],
  },
  {
    name: 'Tools & Accessories',
    slug: 'tools-accessories',
    description: 'Microfiber towels, brushes, buckets and applicators.',
    featured: true,
    active: true,
    children: [
      { name: 'Towels', slug: 'tools-towels', description: 'Microfiber wash, drying and buffing towels.' },
      { name: 'Brushes', slug: 'tools-brushes', description: 'Detailing brushes for vents, trim and tight spots.' },
      { name: 'Buckets', slug: 'tools-buckets', description: 'Wash buckets and grit guards.' },
      { name: 'Applicators', slug: 'tools-applicators', description: 'Foam and microfiber applicator pads.' },
    ],
  },
  {
    name: 'Fragrance',
    slug: 'fragrance',
    description: 'In-car fragrances and odor eliminators.',
    featured: false,
    active: true,
    children: [
      { name: 'Air Fresheners', slug: 'fragrance-air-fresheners', description: 'Hanging and vent-clip air fresheners.' },
      { name: 'Odor Eliminators', slug: 'fragrance-odor-eliminators', description: 'Enzyme-based odor eliminators.' },
    ],
  },
  {
    name: 'Protection',
    slug: 'protection',
    description: 'Covers, paint protection film and accessories.',
    featured: false,
    active: true,
    children: [
      { name: 'Covers', slug: 'protection-covers', description: 'Waterproof and breathable car covers.' },
      { name: 'Paint Protection Film', slug: 'protection-ppf', description: 'Self-healing PPF kits and sheets.' },
    ],
  },
];

async function seedCategories() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    let createdCount = 0;
    let updatedCount = 0;
    let childrenCount = 0;

    for (const categoryData of categoryStructure) {
      const { children, ...parentData } = categoryData;

      // Check if parent category already exists
      let parentCategory = await Category.findOne({ slug: parentData.slug });

      if (parentCategory) {
        // Update existing parent category
        await Category.findByIdAndUpdate(parentCategory._id, {
          ...parentData,
          parentId: null,
        });
        console.log(`Updated parent: ${parentData.name}`);
        updatedCount++;
      } else {
        // Create new parent category
        parentCategory = await Category.create({
          ...parentData,
          parentId: null,
        });
        console.log(`Created parent: ${parentData.name}`);
        createdCount++;
      }

      // Process children if any
      if (children && children.length > 0) {
        for (const childData of children) {
          const existingChild = await Category.findOne({ slug: childData.slug });

          if (existingChild) {
            // Update existing child
            await Category.findByIdAndUpdate(existingChild._id, {
              ...childData,
              active: true,
              featured: false,
              parentId: parentCategory._id,
            });
            console.log(`  Updated child: ${childData.name}`);
            updatedCount++;
          } else {
            // Create new child category
            await Category.create({
              ...childData,
              active: true,
              featured: false,
              parentId: parentCategory._id,
            });
            console.log(`  Created child: ${childData.name}`);
            childrenCount++;
          }
        }
      }
    }

    console.log('\n========================================');
    console.log('Categories seeded successfully!');
    console.log(`Parent categories created: ${createdCount}`);
    console.log(`Subcategories created: ${childrenCount}`);
    console.log(`Categories updated: ${updatedCount}`);
    console.log('========================================\n');

    // Print summary
    const allCategories = await Category.find().populate('parentId', 'name');
    const parents = allCategories.filter(c => !c.parentId);
    const children = allCategories.filter(c => c.parentId);

    console.log('Category Summary:');
    console.log(`Total categories: ${allCategories.length}`);
    console.log(`Parent categories: ${parents.length}`);
    console.log(`Subcategories: ${children.length}`);

  } catch (error) {
    console.error('Error seeding categories:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedCategories();
