// scripts/migrateToCoolify.js
// One-shot move from Vercel (Atlas + Vercel Blob) to Coolify (Mongo + S3).
// Run inside the Coolify backend container:   node scripts/migrateToCoolify.js
//
// Needs env: ATLAS_URI (live Vercel DB, only read), MONGO_URI (Coolify Mongo, overwritten),
// BLOB_READ_WRITE_TOKEN (only read), S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY.
// 1. copies the whole Atlas DB into the Coolify DB (target collections are dropped first)
// 2. copies every Blob file into S3 (same key)
// 3. rewrites Blob URLs in the Coolify DB to the S3 URL and checks nothing is left/missing
const { execFileSync } = require('child_process');
const path = require('path');

const dbOf = (uri) => new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
const { ATLAS_URI, MONGO_URI } = process.env;
if (!ATLAS_URI || !MONGO_URI) throw new Error('Set ATLAS_URI (source) and MONGO_URI (target)');
if (/mongodb\.net/.test(MONGO_URI)) throw new Error('MONGO_URI points at Atlas; it must be the Coolify Mongo.');
const SRC_DB = process.env.CLONE_SOURCE_DB || dbOf(ATLAS_URI);
const DST_DB = process.env.CLONE_TARGET_DB || dbOf(MONGO_URI);
if (!SRC_DB || !DST_DB) throw new Error('Database name missing in ATLAS_URI / MONGO_URI (…/<db>?…)');

const run = (file, args, env) => execFileSync(process.execPath, [path.join(__dirname, '..', file), ...args], {
  stdio: 'inherit', env: { ...process.env, ...env },
});

console.log(`\n== 1/2 Copy DB ${SRC_DB} (Atlas) -> ${DST_DB} (Coolify)`);
run('cloneDatabase.js', [], {
  CLONE_SOURCE_URI: ATLAS_URI, CLONE_TARGET_URI: MONGO_URI, CLONE_SOURCE_DB: SRC_DB, CLONE_TARGET_DB: DST_DB,
});

console.log('\n== 2/2 Copy Vercel Blob -> S3 and rewrite URLs');
run('scripts/migrateBlobToS3.js', ['--copy-refs', '--rewrite'], { TARGET_URI: MONGO_URI, TARGET_DB: DST_DB });
console.log('\nDone.');
