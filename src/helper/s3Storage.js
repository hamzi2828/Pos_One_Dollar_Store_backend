// src/helper/s3Storage.js
// S3-compatible storage (SeaweedFS on Coolify). Used when S3_BUCKET is set.
//
//   S3_ENDPOINT    https://media.dollarandco.org
//   S3_BUCKET      dollarandco
//   S3_ACCESS_KEY  / S3_SECRET_KEY
//   S3_REGION      optional, default us-east-1
//   S3_PUBLIC_URL  optional, default `${S3_ENDPOINT}/${S3_BUCKET}`
//
// Files are public-read; the URL saved in the DB is `${S3_PUBLIC_URL}/${key}`.
const BUCKET = process.env.S3_BUCKET || '';
const enabled = !!BUCKET;
const ENDPOINT = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.S3_PUBLIC_URL || (ENDPOINT && `${ENDPOINT}/${BUCKET}`)).replace(/\/+$/, '');

let client = null;
let sdk = null;
function getClient() {
  if (!client) {
    sdk = require('@aws-sdk/client-s3');
    client = new sdk.S3Client({
      endpoint: ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
    });
  }
  return client;
}

const isOwnUrl = (url) => enabled && !!PUBLIC_URL && typeof url === 'string' && url.startsWith(`${PUBLIC_URL}/`);
const keyOf = (url) => decodeURIComponent(url.slice(PUBLIC_URL.length + 1).split('?')[0]);
const urlOf = (key) => `${PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** @returns {Promise<string>} public URL */
async function putObject(key, buffer, contentType) {
  await getClient().send(new sdk.PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return urlOf(key);
}

async function deleteObject(url) {
  if (!isOwnUrl(url)) return;
  await getClient().send(new sdk.DeleteObjectCommand({ Bucket: BUCKET, Key: keyOf(url) }));
}

module.exports = { enabled, isOwnUrl, putObject, deleteObject, urlOf, PUBLIC_URL };
