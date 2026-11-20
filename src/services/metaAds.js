// src/services/metaAds.js
// Facebook / Instagram ads (Meta Marketing API) for the Advertisements page.
//
// Settings live in AppConfig under "metaAds":
//   { accessToken, adAccountId: 'act_123…', apiVersion: 'v23.0' }
// The token is a secret: publicSettings() masks it and saveSettings() keeps the
// stored token when the browser sends back an empty value.
//
// Token: Meta Business Settings -> Users -> System users -> Generate token,
// with ads_read (view) and ads_management (pause / start / budget).
const config = require('./configService');

const CONFIG_KEY = 'metaAds';
const MASK = '••••';
const DEFAULT_VERSION = 'v23.0';
const CACHE_MS = 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------- settings

async function getSettings() {
  const raw = (await config.get(CONFIG_KEY, {})) || {};
  return {
    accessToken: raw.accessToken || '',
    adAccountId: raw.adAccountId || '',
    apiVersion: raw.apiVersion || DEFAULT_VERSION,
  };
}

function publicSettings(s) {
  const t = s.accessToken;
  return {
    adAccountId: s.adAccountId,
    apiVersion: s.apiVersion,
    hasToken: !!t,
    token: t ? (t.length > 8 ? `${MASK}${t.slice(-4)}` : MASK) : '',
  };
}

function normalizeAccountId(v) {
  const digits = str(v, 40).replace(/^act_/i, '').replace(/\D/g, '');
  return digits ? `act_${digits}` : '';
}

async function saveSettings(body, userId) {
  const cur = await getSettings();
  const next = { ...cur };
  if (body.adAccountId !== undefined) next.adAccountId = normalizeAccountId(body.adAccountId);
  if (body.apiVersion !== undefined) {
    const v = str(body.apiVersion, 10);
    if (v && !/^v\d{1,3}\.\d$/.test(v)) throw httpError(400, 'API version looks like v23.0');
    next.apiVersion = v || DEFAULT_VERSION;
  }
  const tok = str(body.accessToken, 1000);
  if (tok && !tok.startsWith(MASK)) next.accessToken = tok;
  if (body.clearToken === true) next.accessToken = '';
  await config.set(CONFIG_KEY, next, userId);
  cache.clear();
  return publicSettings(next);
}

// ---------------------------------------------------------------- Graph API

const cache = new Map(); // url -> { at, data }

async function graph(path, { params = {}, method = 'GET', settings, noCache = false } = {}) {
  const s = settings || (await getSettings());
  if (!s.accessToken || !s.adAccountId) {
    throw Object.assign(httpError(400, 'Meta ads are not connected yet. Add the access token and ad account ID in Settings.'), {
      code: 'NOT_CONNECTED',
    });
  }
  const url = new URL(`https://graph.facebook.com/${s.apiVersion}/${path}`);
  const body = new URLSearchParams();
  const target = method === 'GET' ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    target.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const key = method === 'GET' ? url.toString() : null;
  if (key && !noCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }
  // Token goes in the header, never in the cached URL / logs.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${s.accessToken}` },
      body: method === 'GET' ? undefined : body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw httpError(502, e.name === 'AbortError' ? 'Meta did not answer in time. Try again.' : 'Could not reach Meta.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.error_user_msg || data.error?.message || `Meta error ${res.status}`;
    const status = data.error?.code === 190 ? 401 : 400; // 190 = token expired / invalid
    throw httpError(status, `Meta: ${msg}`);
  }
  if (key) cache.set(key, { at: Date.now(), data });
  if (method !== 'GET') cache.clear();
  return data;
}

/** Follow paging.next until done (max 10 pages). */
async function graphAll(path, opts) {
  const first = await graph(path, opts);
  const rows = [...(first.data || [])];
  let next = first.paging?.next;
  let pages = 1;
  const s = opts.settings || (await getSettings());
  while (next && pages < 10) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${s.accessToken}` } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) break;
    rows.push(...(d.data || []));
    next = d.paging?.next;
    pages += 1;
  }
  return rows;
}

// ---------------------------------------------------------------- metrics

const INSIGHT_FIELDS = [
  'ad_id', 'ad_name', 'adset_id', 'campaign_id',
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpm',
  'actions',
  'video_play_actions',
  'video_continuous_2_sec_watched_actions',
  'video_thruplay_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions',
  'video_avg_time_watched_actions',
].join(',');

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
const actionVal = (list, type) => {
  if (!Array.isArray(list)) return 0;
  const hit = type ? list.find((a) => a.action_type === type) : list[0];
  return hit ? num(hit.value) : 0;
};
const sumActions = (list, types) => types.reduce((t, k) => t + actionVal(list, k), 0);

/** One insights row -> flat numbers the page shows. */
function shapeRow(r) {
  const a = r.actions;
  return {
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    frequency: num(r.frequency),
    clicks: num(r.clicks),
    ctr: num(r.ctr),
    cpm: num(r.cpm),
    linkClicks: actionVal(a, 'link_click'),
    engagement: actionVal(a, 'post_engagement'),
    messages: sumActions(a, ['onsite_conversion.messaging_conversation_started_7d']),
    videoPlays: actionVal(r.video_play_actions),
    plays2s: actionVal(r.video_continuous_2_sec_watched_actions),
    plays3s: actionVal(a, 'video_view'),
    thruplays: actionVal(r.video_thruplay_watched_actions),
    p25: actionVal(r.video_p25_watched_actions),
    p50: actionVal(r.video_p50_watched_actions),
    p75: actionVal(r.video_p75_watched_actions),
    p95: actionVal(r.video_p95_watched_actions),
    p100: actionVal(r.video_p100_watched_actions),
    avgWatchSec: actionVal(r.video_avg_time_watched_actions),
  };
}

const BREAKDOWNS = {
  platform: 'publisher_platform',
  placement: 'publisher_platform,platform_position',
  age_gender: 'age,gender',
  region: 'region',
  device: 'impression_device',
};

// Meta's own last_7d / last_14d / last_30d leave TODAY out. The page wants
// "the last N days up to now", so those are sent as a time_range ending today
// in the ad account's time zone.
let tzCache = { at: 0, tz: '' };
async function accountTimezone(s) {
  if (tzCache.tz && Date.now() - tzCache.at < 60 * 60 * 1000) return tzCache.tz;
  try {
    const a = await graph(s.adAccountId, { settings: s, params: { fields: 'timezone_name' } });
    tzCache = { at: Date.now(), tz: a.timezone_name || 'Asia/Karachi' };
  } catch {
    tzCache = { at: Date.now(), tz: 'Asia/Karachi' };
  }
  return tzCache.tz;
}

function ymdInTz(date, tz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

async function dateRange(q, s) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const since = re.test(q.since || '') ? q.since : null;
  const until = re.test(q.until || '') ? q.until : null;
  if (since && until) return { time_range: { since, until } };
  const preset = q.preset || 'last_7d';
  const days = { last_7d: 7, last_14d: 14, last_30d: 30 }[preset];
  if (days) {
    const tz = await accountTimezone(s);
    const now = new Date();
    const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    return { time_range: { since: ymdInTz(start, tz), until: ymdInTz(now, tz) } };
  }
  const presets = ['today', 'yesterday', 'this_month', 'last_month', 'maximum'];
  return { date_preset: presets.includes(preset) ? preset : 'maximum' };
}

// ---------------------------------------------------------------- public API

async function account() {
  const s = await getSettings();
  return graph(s.adAccountId, {
    settings: s,
    params: { fields: 'name,currency,timezone_name,account_status,amount_spent,balance' },
  });
}

/** Every ad with its status, ad set budget, campaign and the totals for the range. */
async function listAds(q = {}) {
  const s = await getSettings();
  const range = await dateRange(q, s);
  const [ads, insights] = await Promise.all([
    graphAll(`${s.adAccountId}/ads`, {
      settings: s,
      params: {
        fields:
          'id,name,status,effective_status,created_time,campaign{id,name,objective,status},adset{id,name,status,daily_budget,lifetime_budget,end_time},creative{thumbnail_url,image_url}',
        limit: 100,
      },
    }),
    graphAll(`${s.adAccountId}/insights`, {
      settings: s,
      params: { level: 'ad', fields: INSIGHT_FIELDS, limit: 500, ...range },
    }),
  ]);
  const byAd = new Map(insights.map((r) => [r.ad_id, shapeRow(r)]));
  const rows = ads.map((ad) => ({
    id: ad.id,
    name: ad.name,
    status: ad.status,
    effectiveStatus: ad.effective_status,
    createdTime: ad.created_time,
    thumbnail: ad.creative?.thumbnail_url || ad.creative?.image_url || '',
    campaign: ad.campaign ? { id: ad.campaign.id, name: ad.campaign.name, objective: ad.campaign.objective } : null,
    adset: ad.adset
      ? {
          id: ad.adset.id,
          name: ad.adset.name,
          status: ad.adset.status,
          // Meta sends budgets in minor units (paisa for PKR).
          dailyBudget: ad.adset.daily_budget ? num(ad.adset.daily_budget) / 100 : null,
          lifetimeBudget: ad.adset.lifetime_budget ? num(ad.adset.lifetime_budget) / 100 : null,
          endTime: ad.adset.end_time || null,
        }
      : null,
    stats: byAd.get(ad.id) || null,
  }));
  // Running first, then by spend.
  rows.sort(
    (x, y) =>
      (y.effectiveStatus === 'ACTIVE') - (x.effectiveStatus === 'ACTIVE') || (y.stats?.spend || 0) - (x.stats?.spend || 0)
  );
  return { rows, range };
}

/** One ad: totals, daily trend and a breakdown (platform / age_gender / region / …). */
async function adInsights(adId, q = {}) {
  if (!/^\d{1,25}$/.test(String(adId))) throw httpError(400, 'Bad ad id');
  const s = await getSettings();
  const range = await dateRange(q, s);
  const breakdownKey = BREAKDOWNS[q.breakdown] ? q.breakdown : 'platform';
  const [total, daily, split] = await Promise.all([
    graph(`${adId}/insights`, { settings: s, params: { fields: INSIGHT_FIELDS, ...range } }),
    graphAll(`${adId}/insights`, { settings: s, params: { fields: INSIGHT_FIELDS, time_increment: 1, limit: 100, ...range } }),
    graphAll(`${adId}/insights`, {
      settings: s,
      params: { fields: INSIGHT_FIELDS, breakdowns: BREAKDOWNS[breakdownKey], limit: 200, ...range },
    }),
  ]);
  const t = total.data?.[0];
  return {
    total: t ? shapeRow(t) : null,
    daily: daily.map((r) => ({ date: r.date_start, ...shapeRow(r) })),
    breakdown: breakdownKey,
    rows: split.map((r) => ({
      label: {
        platform: r.publisher_platform,
        position: r.platform_position,
        age: r.age,
        gender: r.gender,
        region: r.region,
        device: r.impression_device,
      },
      ...shapeRow(r),
    })),
  };
}

/** Pause or start one ad. */
async function setAdStatus(adId, status) {
  if (!/^\d{1,25}$/.test(String(adId))) throw httpError(400, 'Bad ad id');
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw httpError(400, 'Status must be ACTIVE or PAUSED');
  await graph(adId, { method: 'POST', params: { status } });
  return { id: adId, status };
}

/** Change an ad set's daily budget (rupees). */
async function setDailyBudget(adsetId, rupees) {
  if (!/^\d{1,25}$/.test(String(adsetId))) throw httpError(400, 'Bad ad set id');
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 100 || n > 1000000) throw httpError(400, 'Daily budget must be between Rs 100 and Rs 1,000,000');
  await graph(adsetId, { method: 'POST', params: { daily_budget: Math.round(n * 100) } });
  return { id: adsetId, dailyBudget: Math.round(n * 100) / 100 };
}

module.exports = {
  getSettings,
  publicSettings,
  saveSettings,
  account,
  listAds,
  adInsights,
  setAdStatus,
  setDailyBudget,
  BREAKDOWNS,
};
