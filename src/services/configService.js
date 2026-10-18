// src/services/configService.js
// Read/write small module settings stored in models/appConfig.js.
//
//   const config = require('../services/configService');
//   const pct = await config.get('demand.thresholdPct', 25);
//   await config.set('demand.thresholdPct', 30, req.access.userId);
//
// Values are cached for 30 s per process (serverless instances each have
// their own cache, so a change can take up to 30 s to reach every instance).
const AppConfig = require('../models/appConfig');

const TTL_MS = 30 * 1000;
const cache = new Map(); // key -> { at, value }

async function get(key, fallback = null) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value === undefined || hit.value === null ? fallback : hit.value;
  const doc = await AppConfig.findOne({ key }).lean();
  const value = doc ? doc.value : null;
  cache.set(key, { at: Date.now(), value });
  return value === undefined || value === null ? fallback : value;
}

/** Several keys at once -> { key: value|fallback }. `defaults` = { key: fallback }. */
async function getMany(defaults = {}) {
  const keys = Object.keys(defaults);
  const out = {};
  const missing = [];
  for (const k of keys) {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) out[k] = hit.value ?? defaults[k];
    else missing.push(k);
  }
  if (missing.length) {
    const docs = await AppConfig.find({ key: { $in: missing } }).lean();
    const byKey = new Map(docs.map((d) => [d.key, d.value]));
    for (const k of missing) {
      const value = byKey.has(k) ? byKey.get(k) : null;
      cache.set(k, { at: Date.now(), value });
      out[k] = value ?? defaults[k];
    }
  }
  return out;
}

async function set(key, value, userId = null) {
  const doc = await AppConfig.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy: userId || null } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  cache.set(key, { at: Date.now(), value: doc.value });
  return doc.value;
}

function clearCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

module.exports = { get, getMany, set, clearCache };
