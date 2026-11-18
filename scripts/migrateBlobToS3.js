// scripts/migrateBlobToS3.js
// Copy every Vercel Blob file into S3 (same key), then rewrite the Blob URLs
// in a Mongo database to the S3 public URL.
//
//   BLOB_READ_WRITE_TOKEN=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//   TARGET_URI=mongodb://... TARGET_DB=pos_mirpur_dollar_shop node scripts/migrateBlobToS3.js [--copy] [--rewrite]
//
// --copy     list all blobs and copy any missing in S3 (re-runnable, skips existing)
// --copy-refs  copy every Blob URL referenced in TARGET_DB from its public URL (no token needed)
// --rewrite  replace https://<store>.public.blob.vercel-storage.com/<key> with S3_PUBLIC_URL/<key>
//            in every string of every document of TARGET_DB. Never run against the live Vercel DB.
// The Blob store is only read.
const { list } = require('@vercel/blob');
const { S3Client, PutObjectCommand, HeadObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { MongoClient } = require('mongodb');

const args = new Set(process.argv.slice(2));
const { BLOB_READ_WRITE_TOKEN, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, TARGET_URI, TARGET_DB } = process.env;
const PUBLIC_URL = (process.env.S3_PUBLIC_URL || `${S3_ENDPOINT}/${S3_BUCKET}`).replace(/\/+$/, '');
const BLOB_RE = /https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/([^\s"'<>)?#\\]+)(\?[^\s"'<>)#\\]*)?/gi;

const s3 = new S3Client({
  endpoint: S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});

const exists = async (Key) => {
  try { await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key })); return true; } catch { return false; }
};

async function copyAll() {
  try { await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET })); console.log(`Created bucket ${S3_BUCKET}`); }

  let cursor; let n = 0; let copied = 0; let skipped = 0; const failed = [];
  do {
    const page = await list({ token: BLOB_READ_WRITE_TOKEN, cursor, limit: 1000 });
    cursor = page.hasMore ? page.cursor : undefined;
    const jobs = page.blobs.map((b) => async () => {
      n++;
      const Key = decodeURIComponent(b.pathname);
      if (await exists(Key)) { skipped++; return; }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(b.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = Buffer.from(await res.arrayBuffer());
          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET, Key, Body: body,
            ContentType: res.headers.get('content-type') || 'application/octet-stream',
            CacheControl: 'public, max-age=31536000, immutable',
          }));
          copied++; return;
        } catch (e) { if (attempt === 3) failed.push(`${b.pathname}: ${e.message}`); }
      }
    });
    for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((j) => j()));
    console.log(`  listed ${n}, copied ${copied}, already there ${skipped}, failed ${failed.length}`);
  } while (cursor);
  if (failed.length) console.log('FAILED:\n' + failed.join('\n'));
  return { total: n, copied, skipped, failed };
}

async function copyRefs() {
  if (!TARGET_URI || !TARGET_DB) throw new Error('Set TARGET_URI and TARGET_DB');
  try { await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET })); console.log(`Created bucket ${S3_BUCKET}`); }
  const client = await MongoClient.connect(TARGET_URI);
  const db = client.db(TARGET_DB);
  const urls = new Map(); // key -> url
  for (const { name } of await db.listCollections({ type: 'collection' }).toArray()) {
    for await (const doc of db.collection(name).find({})) {
      for (const m of JSON.stringify(doc).matchAll(BLOB_RE)) urls.set(decodeURIComponent(m[1]), m[0].split('?')[0]);
    }
  }
  await client.close();
  console.log(`${urls.size} distinct Blob files referenced`);
  let copied = 0; let skipped = 0; const failed = [];
  const jobs = [...urls].map(([Key, url]) => async () => {
    if (await exists(Key)) { skipped++; return; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET, Key, Body: body,
          ContentType: res.headers.get('content-type') || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000, immutable',
        }));
        copied++; return;
      } catch (e) { if (attempt === 3) failed.push(`${url}: ${e.message}`); }
    }
  });
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map((j) => j()));
    if (i % 200 === 0) console.log(`  ${Math.min(i + 8, jobs.length)}/${jobs.length}`);
  }
  console.log(`copied ${copied}, already there ${skipped}, failed ${failed.length}`);
  if (failed.length) console.log('FAILED: ' + failed.join(' | '));
  return { total: urls.size, copied, skipped, failed: failed.length };
}

const fixStr = (s, refs) => s.replace(BLOB_RE, (_m, path) => { refs.add(decodeURIComponent(path)); return `${PUBLIC_URL}/${path}`; });
function walk(v, refs) {
  if (typeof v === 'string') { const r = fixStr(v, refs); return r === v ? undefined : r; }
  if (Array.isArray(v)) { let ch = false; const out = v.map((x) => { const r = walk(x, refs); if (r !== undefined) { ch = true; return r; } return x; }); return ch ? out : undefined; }
  if (v && typeof v === 'object' && v.constructor === Object) {
    let ch = false; const out = { ...v };
    for (const k of Object.keys(v)) { const r = walk(v[k], refs); if (r !== undefined) { ch = true; out[k] = r; } }
    return ch ? out : undefined;
  }
  return undefined;
}

async function rewrite() {
  if (!TARGET_URI || !TARGET_DB) throw new Error('Set TARGET_URI and TARGET_DB');
  if (/mongodb\.net/.test(TARGET_URI)) throw new Error('Refusing to rewrite an Atlas database (that is the live Vercel DB).');
  const client = await MongoClient.connect(TARGET_URI);
  const db = client.db(TARGET_DB);
  const refs = new Set(); let docs = 0;
  for (const { name } of await db.listCollections({ type: 'collection' }).toArray()) {
    const col = db.collection(name); let changed = 0;
    for await (const doc of col.find({})) {
      const r = walk(doc, refs);
      if (r) { await col.replaceOne({ _id: doc._id }, r); changed++; }
    }
    if (changed) console.log(`  ${name}: ${changed} docs rewritten`);
    docs += changed;
  }
  // Every referenced file must now be in S3.
  const missing = [];
  for (const k of refs) if (!(await exists(k))) missing.push(k);
  console.log(`Rewrote ${docs} docs; ${refs.size} distinct files referenced; ${missing.length} missing in S3`);
  if (missing.length) console.log(missing.slice(0, 50).join('\n'));
  // Nothing left pointing at Vercel Blob?
  let left = 0;
  for (const { name } of await db.listCollections({ type: 'collection' }).toArray()) {
    for await (const doc of db.collection(name).find({})) if (/blob\.vercel-storage\.com/.test(JSON.stringify(doc))) left++;
  }
  console.log(`Docs still mentioning blob.vercel-storage.com: ${left}`);
  await client.close();
  return { docs, refs: refs.size, missing: missing.length, left };
}

(async () => {
  if (args.has('--copy')) console.log('Copy:', await copyAll());
  if (args.has('--copy-refs')) console.log('Copy refs:', await copyRefs());
  if (args.has('--rewrite')) console.log('Rewrite:', await rewrite());
  if (!args.has('--copy') && !args.has('--copy-refs') && !args.has('--rewrite')) console.log('Pass --copy and/or --rewrite');
})().catch((e) => { console.error(e); process.exit(1); });
