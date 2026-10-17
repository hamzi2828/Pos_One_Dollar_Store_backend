require('dotenv').config();
const { MongoClient } = require('mongodb');

// Clones one database into another on the same cluster.
//
// Credentials come from MONGO_URI (.env) — nothing is hardcoded here.
// Defaults clone the legacy shared database into this project's own database.
//
//   node cloneDatabase.js                 # hk_autocare -> hamzaMobile
//   CLONE_SOURCE_DB=x CLONE_TARGET_DB=y node cloneDatabase.js
//
// The target collections are DROPPED and replaced. The source is only read.

const SOURCE_DB = process.env.CLONE_SOURCE_DB || 'hk_autocare';
const TARGET_DB = process.env.CLONE_TARGET_DB || 'hamzaMobile';

// Both databases live on the cluster in MONGO_URI unless overridden.
const SOURCE_URI = process.env.CLONE_SOURCE_URI || process.env.MONGO_URI;
const TARGET_URI = process.env.CLONE_TARGET_URI || process.env.MONGO_URI;

const BATCH_SIZE = 1000;

function assertPreconditions() {
  if (!SOURCE_URI || !TARGET_URI) {
    throw new Error('MONGO_URI is not set. Add it to .env before running the clone.');
  }
  if (SOURCE_URI === TARGET_URI && SOURCE_DB === TARGET_DB) {
    throw new Error(`Source and target are the same database (${SOURCE_DB}). Refusing to run.`);
  }
}

async function cloneCollection(sourceDb, targetDb, collectionName) {
  const sourceCollection = sourceDb.collection(collectionName);
  const targetCollection = targetDb.collection(collectionName);

  const total = await sourceCollection.countDocuments();
  console.log(`\nCloning collection: ${collectionName} (${total} documents)`);

  // Start from a clean slate so re-runs are idempotent.
  try {
    await targetCollection.drop();
    console.log('  Dropped existing collection in target');
  } catch (err) {
    if (err.code !== 26) { // 26 = NamespaceNotFound
      console.log(`  Note: ${err.message}`);
    }
  }

  // Stream in batches so large collections don't have to fit in memory.
  let copied = 0;
  let batch = [];
  const cursor = sourceCollection.find({});

  const flush = async () => {
    if (batch.length === 0) return;
    await targetCollection.insertMany(batch, { ordered: false });
    copied += batch.length;
    batch = [];
    console.log(`  Inserted ${copied}/${total}`);
  };

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  // Recreate indexes so queries behave identically in the new database.
  const indexes = await sourceCollection.indexes();
  for (const index of indexes) {
    if (index.name === '_id_') continue;
    try {
      const { key, v, ns, ...options } = index;
      await targetCollection.createIndex(key, options);
      console.log(`  Created index: ${index.name}`);
    } catch (err) {
      console.log(`  Warning: could not create index ${index.name}: ${err.message}`);
    }
  }

  return { collectionName, total, copied };
}

async function cloneDatabase() {
  assertPreconditions();

  let sourceClient = null;
  let targetClient = null;

  try {
    console.log(`Connecting to source database (${SOURCE_DB})...`);
    sourceClient = new MongoClient(SOURCE_URI);
    await sourceClient.connect();
    const sourceDb = sourceClient.db(SOURCE_DB);

    console.log(`Connecting to target database (${TARGET_DB})...`);
    targetClient = new MongoClient(TARGET_URI);
    await targetClient.connect();
    const targetDb = targetClient.db(TARGET_DB);

    const collections = (await sourceDb.listCollections().toArray())
      .filter((col) => !col.name.startsWith('system.'));

    if (collections.length === 0) {
      console.log(`\nSource database "${SOURCE_DB}" has no collections. Nothing to clone.`);
      return;
    }

    console.log(`Found ${collections.length} collections to clone:`);
    collections.forEach((col) => console.log(`  - ${col.name}`));

    const results = [];
    for (const { name } of collections) {
      results.push(await cloneCollection(sourceDb, targetDb, name));
    }

    const mismatched = results.filter((r) => r.copied !== r.total);

    console.log('\n========================================');
    console.log('Database clone completed');
    console.log('========================================');
    console.log(`Source: ${SOURCE_DB}`);
    console.log(`Target: ${TARGET_DB}`);
    console.log(`Collections cloned: ${results.length}`);
    console.log(`Documents copied: ${results.reduce((sum, r) => sum + r.copied, 0)}`);

    if (mismatched.length > 0) {
      console.log('\n⚠️  Document counts did not match for:');
      mismatched.forEach((r) => console.log(`  - ${r.collectionName}: ${r.copied}/${r.total}`));
      throw new Error('Clone finished with mismatched document counts');
    }
  } finally {
    if (sourceClient) {
      await sourceClient.close();
      console.log('\nClosed source database connection');
    }
    if (targetClient) {
      await targetClient.close();
      console.log('Closed target database connection');
    }
  }
}

cloneDatabase()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nClone failed:', error.message);
    process.exit(1);
  });
