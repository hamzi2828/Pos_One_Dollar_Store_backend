const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';

if (!process.env.MONGO_URI) {
  console.warn('⚠️  WARNING: Using hardcoded MongoDB credentials. Please set MONGO_URI in .env file for security.');
}

const connectionOptions = {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 1,
  family: 4,
};

mongoose.set('bufferCommands', true);

// Cache the connection promise on globalThis so it survives module re-imports
// across Vercel serverless invocations within the same warm lambda instance.
// Without this, every cold start re-establishes the Mongo handshake (~1–3s).
const globalCache = globalThis.__hkMongoCache || (globalThis.__hkMongoCache = { conn: null, promise: null });

const initializeConnection = async () => {
  if (globalCache.conn && mongoose.connection.readyState === 1) {
    return globalCache.conn;
  }

  if (!globalCache.promise) {
    globalCache.promise = mongoose
      .connect(MONGO_URI, connectionOptions)
      .then((connection) => {
        console.log(`✅ Connected to MongoDB Database: ${mongoose.connection.name}`);
        globalCache.conn = connection;
        return connection;
      })
      .catch((err) => {
        console.error('❌ MongoDB Connection Error:', err);
        globalCache.promise = null;
        if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
          process.exit(1);
        }
        throw err;
      });
  }

  return globalCache.promise;
};

initializeConnection().catch(console.error);

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB Connection Error (Runtime):', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('🔌 MongoDB disconnected');
  globalCache.conn = null;
  globalCache.promise = null;
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconnected');
});

const ensureConnection = async () => {
  if (mongoose.connection.readyState === 1) return;

  if (globalCache.promise) {
    try {
      await globalCache.promise;
      if (mongoose.connection.readyState === 1) return;
      globalCache.promise = null;
    } catch {
      globalCache.promise = null;
    }
  }

  if (mongoose.connection.readyState === 2) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
    return;
  }

  await initializeConnection();

  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
  }
};

module.exports = { mongoose, ensureConnection };
