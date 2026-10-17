require('dotenv').config();
const mongoose = require('mongoose');
const Network = require('../src/models/network');
const { DEFAULT_NETWORKS } = require('../src/controller/networkController');

const MONGO_URI = process.env.MONGO_URI;

// The admin list also seeds these on first open, so running this is optional —
// it exists for setting up a database without touching the UI. Safe to re-run:
// existing networks are left exactly as they are.
async function createNetworks() {
    try {
        if (!MONGO_URI) {
            throw new Error('MONGO_URI is not set. Check backend .env file.');
        }

        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        let created = 0;
        let skipped = 0;

        for (const network of DEFAULT_NETWORKS) {
            const existing = await Network.findOne({
                code: network.code,
                isDeleted: { $ne: true },
            });

            if (existing) {
                console.log(`- ${network.name} (${network.code}) already exists, skipping`);
                skipped += 1;
                continue;
            }

            await Network.create(network);
            console.log(`+ created ${network.name} (${network.code})`);
            created += 1;
        }

        console.log(`\nDone. ${created} created, ${skipped} already present.`);
    } catch (error) {
        console.error('Failed to seed networks:', error.message);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
}

createNetworks();
