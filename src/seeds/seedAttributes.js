// src/seeds/seedAttributes.js
// Seeds Sizes and Colors used by the product attributes admin page.
const mongoose = require('mongoose');
const Size = require('../models/size');
const Color = require('../models/color');
require('dotenv').config();

const slugify = (str) =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

const sizes = [
  // Standard clothing
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  '3XL',
  '4XL',
  '5XL',
  'Free Size',
  'One Size',

  // Auto-care volumes
  '50ml',
  '100ml',
  '250ml',
  '500ml',
  '750ml',
  '1L',
  '2L',
  '5L',
  '10L',
  '20L',

  // Weight / pack sizes
  '100g',
  '250g',
  '500g',
  '1kg',
  '5kg',
];

const colors = [
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Silver', hex: '#C0C0C0' },
  { name: 'Gray', hex: '#808080' },
  { name: 'Red', hex: '#E53935' },
  { name: 'Blue', hex: '#1E88E5' },
  { name: 'Navy', hex: '#0D1B4C' },
  { name: 'Green', hex: '#43A047' },
  { name: 'Yellow', hex: '#FDD835' },
  { name: 'Orange', hex: '#FB8C00' },
  { name: 'Brown', hex: '#6D4C41' },
  { name: 'Gold', hex: '#D4AF37' },
  { name: 'Beige', hex: '#F5F5DC' },
  { name: 'Maroon', hex: '#800000' },
  { name: 'Pink', hex: '#EC407A' },
  { name: 'Purple', hex: '#8E24AA' },
];

async function seedAttributes() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Sizes
    let sizeCreated = 0;
    let sizeUpdated = 0;
    for (const name of sizes) {
      const slug = slugify(name);
      const existing = await Size.findOne({ slug });
      if (existing) {
        await Size.findByIdAndUpdate(existing._id, { name, slug, active: true });
        console.log(`Updated size: ${name}`);
        sizeUpdated++;
      } else {
        await Size.create({ name, slug, active: true });
        console.log(`Created size: ${name}`);
        sizeCreated++;
      }
    }

    // Colors
    let colorCreated = 0;
    let colorUpdated = 0;
    for (const c of colors) {
      const slug = slugify(c.name);
      const existing = await Color.findOne({ slug });
      if (existing) {
        await Color.findByIdAndUpdate(existing._id, {
          name: c.name,
          slug,
          hex: c.hex,
          active: true,
        });
        console.log(`Updated color: ${c.name}`);
        colorUpdated++;
      } else {
        await Color.create({ name: c.name, slug, hex: c.hex, active: true });
        console.log(`Created color: ${c.name}`);
        colorCreated++;
      }
    }

    console.log('\n========================================');
    console.log('Attributes seeded successfully!');
    console.log(`Sizes  -> created: ${sizeCreated}, updated: ${sizeUpdated}`);
    console.log(`Colors -> created: ${colorCreated}, updated: ${colorUpdated}`);
    console.log('========================================\n');

    const totalSizes = await Size.countDocuments();
    const totalColors = await Color.countDocuments();
    console.log(`Total sizes in DB:  ${totalSizes}`);
    console.log(`Total colors in DB: ${totalColors}`);
  } catch (error) {
    console.error('Error seeding attributes:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedAttributes();
