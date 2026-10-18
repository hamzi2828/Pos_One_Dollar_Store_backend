// Server-side response cache for GET endpoints.
//
// Uses Redis when REDIS_URL is set so cache state is shared across instances;
// otherwise falls back to an in-memory Map. Behaviour is identical to the
// previous implementation: server-side only, clients/CDNs are told NOT to
// cache (so any tagged invalidate() propagates to every user immediately).
//
// Usage on a route:
//   router.get('/path', cache(60 * 60, 'tag'), handler);
//
// Invalidate from write handlers with:
//   const { invalidate } = require('../middleware/cache');
//   invalidate('tag');

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;

const KEY_PREFIX = 'pos:cache:';
const TAG_PREFIX = 'pos:cache:tag:';
const TAG_TS_PREFIX = 'pos:cache:tag-ts:';
const ALL_TS_KEY = 'pos:cache:all-ts';

const NO_CLIENT_CACHE = 'no-store';

// Redis client (may stay null if no URL or connection fails).
let client = null;
let redisReady = false;

if (REDIS_URL) {
  client = createClient({ url: REDIS_URL });
  client.on('error', (err) => {
    if (redisReady) console.error('[cache] redis error:', err.message);
    redisReady = false;
  });
  client.on('ready', () => {
    redisReady = true;
    console.log('[cache] redis connected');
  });
  client.on('end', () => {
    redisReady = false;
  });
  client.connect().catch((err) => {
    console.error('[cache] redis connect failed, falling back to in-memory:', err.message);
    redisReady = false;
  });
}

// In-memory fallback (also used when Redis is briefly unavailable).
const memStore = new Map(); // cacheKey -> { expires, status, body, contentType }
const memTagIndex = new Map(); // tag -> Set<cacheKey>
const memLastInvalidatedAt = new Map(); // tag -> epoch ms
let memLastInvalidatedAllAt = null;

function now() {
  return Date.now();
}

function cache(ttlSeconds, tag) {
  const ttlMs = Math.max(0, ttlSeconds * 1000);
  const ttlSec = Math.max(1, Math.floor(ttlSeconds));

  return async function cacheMiddleware(req, res, next) {
    const key = `${req.originalUrl || req.url}`;

    // ---- Read path ----
    try {
      if (redisReady && client) {
        const raw = await client.get(KEY_PREFIX + key);
        if (raw) {
          const hit = JSON.parse(raw);
          res.set('X-Cache', 'HIT');
          res.set('Cache-Control', NO_CLIENT_CACHE);
          if (hit.contentType) res.set('Content-Type', hit.contentType);
          return res.status(hit.status).send(hit.body);
        }
      } else {
        const hit = memStore.get(key);
        if (hit && hit.expires > now()) {
          res.set('X-Cache', 'HIT');
          res.set('Cache-Control', NO_CLIENT_CACHE);
          if (hit.contentType) res.set('Content-Type', hit.contentType);
          return res.status(hit.status).send(hit.body);
        }
        if (hit) memStore.delete(key);
      }
    } catch (err) {
      // Never let a cache failure break the request.
      console.error('[cache] read error:', err.message);
    }

    // ---- Write path (intercept res.json) ----
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entry = {
          status: res.statusCode,
          body: JSON.stringify(body),
          contentType: 'application/json; charset=utf-8',
        };

        if (redisReady && client) {
          // Fire-and-forget; never block the response on Redis.
          client
            .set(KEY_PREFIX + key, JSON.stringify(entry), { EX: ttlSec })
            .then(() => (tag ? client.sAdd(TAG_PREFIX + tag, key) : null))
            .catch((err) => console.error('[cache] write error:', err.message));
        } else {
          memStore.set(key, { ...entry, expires: now() + ttlMs });
          if (tag) {
            if (!memTagIndex.has(tag)) memTagIndex.set(tag, new Set());
            memTagIndex.get(tag).add(key);
          }
        }
      }
      res.set('X-Cache', 'MISS');
      res.set('Cache-Control', NO_CLIENT_CACHE);
      return originalJson(body);
    };

    next();
  };
}

async function invalidate(tag) {
  if (!tag) return;
  const ts = now();

  if (redisReady && client) {
    try {
      const tagKey = TAG_PREFIX + tag;
      const keys = await client.sMembers(tagKey);
      if (keys && keys.length) {
        const toDelete = keys.map((k) => KEY_PREFIX + k);
        await client.del(toDelete);
      }
      await client.del(tagKey);
      await client.set(TAG_TS_PREFIX + tag, String(ts));
    } catch (err) {
      console.error('[cache] invalidate error:', err.message);
    }
  }

  // Always clear in-memory mirror so we never serve a stale entry from a
  // node that lost its Redis connection mid-flight.
  memLastInvalidatedAt.set(tag, ts);
  const memKeys = memTagIndex.get(tag);
  if (memKeys) {
    for (const k of memKeys) memStore.delete(k);
    memTagIndex.delete(tag);
  }
}

async function invalidateAll() {
  const ts = now();

  if (redisReady && client) {
    try {
      for await (const batch of client.scanIterator({ MATCH: 'pos:cache:*', COUNT: 200 })) {
        const keys = Array.isArray(batch) ? batch : [batch];
        if (keys.length) await client.del(keys);
      }
      await client.set(ALL_TS_KEY, String(ts));
    } catch (err) {
      console.error('[cache] invalidateAll error:', err.message);
    }
  }

  memLastInvalidatedAllAt = ts;
  for (const tag of memTagIndex.keys()) memLastInvalidatedAt.set(tag, ts);
  memStore.clear();
  memTagIndex.clear();
}

async function getResetTimestamps() {
  if (redisReady && client) {
    try {
      const tags = {};
      for await (const batch of client.scanIterator({ MATCH: TAG_TS_PREFIX + '*', COUNT: 200 })) {
        const keys = Array.isArray(batch) ? batch : [batch];
        for (const key of keys) {
          const tag = key.slice(TAG_TS_PREFIX.length);
          const v = await client.get(key);
          if (v) tags[tag] = new Date(parseInt(v, 10)).toISOString();
        }
      }
      const allRaw = await client.get(ALL_TS_KEY);
      return {
        tags,
        lastInvalidatedAllAt: allRaw ? new Date(parseInt(allRaw, 10)).toISOString() : null,
        backend: 'redis',
      };
    } catch (err) {
      console.error('[cache] getResetTimestamps error:', err.message);
    }
  }

  const tags = {};
  for (const [tag, t] of memLastInvalidatedAt.entries()) {
    tags[tag] = new Date(t).toISOString();
  }
  return {
    tags,
    lastInvalidatedAllAt: memLastInvalidatedAllAt ? new Date(memLastInvalidatedAllAt).toISOString() : null,
    backend: 'memory',
  };
}

module.exports = { cache, invalidate, invalidateAll, getResetTimestamps };
