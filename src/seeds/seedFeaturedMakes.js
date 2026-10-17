/**
 * One-time migration: set the initial featured makes for homepage "Browse by Make".
 *
 * Usage:  node src/seeds/seedFeaturedMakes.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const CarMake = require('../models/carMake');

const FEATURED = [
  'Toyota', 'Honda', 'Suzuki', 'Hyundai', 'Kia',
  'BMW', 'Mercedes', 'Audi', 'Lexus', 'Porsche',
  'Land Rover', 'MG',
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  // Reset all to false first
  await CarMake.updateMany({}, { $set: { featuredOnHome: false } });

  // Set featured makes
  for (const name of FEATURED) {
    const result = await CarMake.updateOne(
      { name: { $regex: new RegExp(`^${name}$`, 'i') } },
      { $set: { featuredOnHome: true } }
    );
    console.log(`${name}: ${result.modifiedCount ? 'featured' : 'not found'}`);
  }

  console.log('Done!');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
