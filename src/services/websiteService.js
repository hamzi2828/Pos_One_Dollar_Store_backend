// src/services/websiteService.js
// Content of the public marketing website (docs/WEBSITE_CMS.md).
// One SiteContent document (key 'main'). Everything the browser sends is
// validated against SPEC below: unknown keys are dropped, limits enforced, and
// URLs checked because they render on a public site (no javascript:/data:).
// Output always has every field (stored values over the defaults).
const SiteContent = require('../models/siteContent');
const User = require('../models/user');
const { WEBSITE_DEFAULTS, WEBSITE_ICONS } = require('../constants/websiteDefaults');

const KEY = 'main';
const LIMITS = Object.freeze({ line: 120, text: 1500, body: 5000, url: 2000, items: 24, galleryItems: 40 });
const HOOK_TIMEOUT_MS = 4000;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ spec
// Leaf kinds: line (<=120, one line), text (<=1500), body (<=5000), bool,
// boolTrue (bool, true when missing in a new item), url (image/video: http(s) or /path),
// link (button: url, #anchor, mailto:, tel:), absUrl (http(s) only), map (Google Maps embed),
// icon, price, date (YYYY-MM-DD or ''), phone, whatsapp, email.
const list = (fields, max = LIMITS.items) => ({ $items: fields, max });
const cta = { label: 'line', url: 'link' };
const iconItems = list({ icon: 'icon', title: 'line', text: 'text' });

const SPEC = {
  brand: { name: 'line', tagline: 'line' },
  hero: {
    heading: 'line', subheading: 'text', imageUrl: 'url', videoUrl: 'url',
    primaryCta: cta, secondaryCta: cta,
  },
  about: { show: 'bool', heading: 'line', body: 'body', imageUrl: 'url' },
  whatWeDo: { show: 'bool', heading: 'line', intro: 'text', items: iconItems },
  whatYouGet: { show: 'bool', heading: 'line', intro: 'text', items: iconItems },
  prices: { show: 'bool', heading: 'line', intro: 'text', items: list({ price: 'price', label: 'line', note: 'text' }) },
  categories: { show: 'bool', heading: 'line', items: list({ name: 'line', text: 'text', imageUrl: 'url' }) },
  offers: {
    show: 'bool', heading: 'line',
    items: list({ title: 'line', text: 'text', imageUrl: 'url', active: 'boolTrue', startsOn: 'date', endsOn: 'date' }),
  },
  gallery: { show: 'bool', heading: 'line', items: list({ imageUrl: 'url', caption: 'text' }, LIMITS.galleryItems) },
  faq: { show: 'bool', heading: 'line', items: list({ q: 'text', a: 'text' }) },
  visit: {
    show: 'bool', heading: 'line', address: 'text', city: 'line', mapEmbedUrl: 'map', mapLinkUrl: 'absUrl',
    hours: 'text', phone: 'phone', whatsapp: 'whatsapp', email: 'email',
  },
  social: { facebookUrl: 'absUrl', instagramUrl: 'absUrl', tiktokUrl: 'absUrl', youtubeUrl: 'absUrl', showFacebookFeed: 'bool' },
  seo: { title: 'line', description: 'text', ogImageUrl: 'url', keywords: 'text' },
  siteUrl: 'absUrl',
};
const SECTIONS = Object.keys(SPEC);

// Friendly names for error messages ("Questions, item 2, Answer: ...").
const LABELS = {
  brand: 'Home (brand)', hero: 'Home', about: 'Who we are', whatWeDo: 'What we do', whatYouGet: 'What you get',
  prices: 'Prices', categories: 'Categories', offers: 'Offers', gallery: 'Gallery', faq: 'Questions', visit: 'Visit us',
  social: 'Social', seo: 'SEO', siteUrl: 'Website address',
  name: 'Name', tagline: 'Tagline', heading: 'Heading', subheading: 'Subheading', imageUrl: 'Picture', videoUrl: 'Video',
  primaryCta: 'Main button', secondaryCta: 'Second button', label: 'Label', url: 'Link', show: 'Show on website',
  body: 'Text', intro: 'Intro', icon: 'Icon', title: 'Title', text: 'Text', price: 'Price', note: 'Note', caption: 'Caption',
  q: 'Question', a: 'Answer', active: 'Active', startsOn: 'Start date', endsOn: 'End date', address: 'Address', city: 'City',
  mapEmbedUrl: 'Google Maps embed link', mapLinkUrl: 'Google Maps link', hours: 'Opening hours', phone: 'Phone',
  whatsapp: 'WhatsApp', email: 'Email', facebookUrl: 'Facebook page', instagramUrl: 'Instagram', tiktokUrl: 'TikTok',
  youtubeUrl: 'YouTube', showFacebookFeed: 'Facebook feed', description: 'Description', ogImageUrl: 'Share picture',
  keywords: 'Keywords',
};
const where = (path) =>
  path
    .filter((p, i) => !(p === 'items' && typeof path[i + 1] === 'number')) // "items, item 2" -> "item 2"
    .map((p) => (typeof p === 'number' ? `item ${p + 1}` : p === 'items' ? 'list' : LABELS[p] || p))
    .join(', ');
const invalid = (path, msg) => httpError(400, `${where(path)}: ${msg}`, 'INVALID_CONTENT');

// ------------------------------------------------------------- leaf checks
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function toText(v, path, max, oneLine) {
  if (v === null) v = '';
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') throw invalid(path, 'must be text');
  let s = v.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  s = oneLine ? s.replace(/\s+/g, ' ').trim() : s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) throw invalid(path, `too long (${s.length} characters, max ${max})`);
  return s;
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}
// "/images/x.png" on the website itself (not "//host", no backslashes or spaces).
const isSitePath = (s) => /^\/(?![/\\])[^\s\\]*$/.test(s);

function toUrl(v, path, kind) {
  if (kind === 'map' && typeof v === 'string') {
    // People often paste the whole <iframe ...> code: take its src.
    const m = /src\s*=\s*["']([^"']+)["']/i.exec(v);
    if (m) v = m[1].replace(/&amp;/g, '&');
  }
  const s = toText(v, path, LIMITS.url, true);
  if (!s) return '';
  if (/\s/.test(s)) throw invalid(path, 'a web address cannot contain spaces');
  if (kind === 'map') {
    let u = null;
    try { u = new URL(s); } catch { /* checked below */ }
    if (!u || u.protocol !== 'https:' || u.hostname !== 'www.google.com' || u.pathname !== '/maps/embed' || !u.search) {
      throw invalid(path, 'paste the link from Google Maps → Share → Embed a map (it starts with https://www.google.com/maps/embed?)');
    }
    return u.toString();
  }
  if (isHttpUrl(s)) return s;
  if (kind === 'absUrl') throw invalid(path, 'use a full web address starting with https://');
  if (isSitePath(s)) return s;
  if (kind === 'link') {
    if (/^#[A-Za-z][\w-]{0,60}$/.test(s)) return s;
    if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(s)) return s;
    if (/^tel:\+?[0-9()-]{3,20}$/i.test(s)) return s;
    throw invalid(path, 'use a web address starting with https://, a page path like /about, or a section like #visit');
  }
  throw invalid(path, 'use a web address starting with https:// (or a website path starting with /)');
}

function leaf(kind, v, path) {
  switch (kind) {
    case 'line': return toText(v, path, LIMITS.line, true);
    case 'text': return toText(v, path, LIMITS.text, false);
    case 'body': return toText(v, path, LIMITS.body, false);
    case 'bool':
    case 'boolTrue':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw invalid(path, 'must be on or off');
    case 'url':
    case 'link':
    case 'absUrl':
    case 'map':
      return toUrl(v, path, kind);
    case 'icon': {
      const s = toText(v, path, 40, true);
      if (!s) return 'star';
      if (!WEBSITE_ICONS.includes(s)) throw invalid(path, `unknown icon "${s}"`);
      return s;
    }
    case 'price': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10000000) throw invalid(path, 'must be a number of 0 or more');
      return Math.round(n * 100) / 100;
    }
    case 'date': {
      const s = toText(v, path, 10, true);
      if (!s) return '';
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const t = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
      if (!t || t.getUTCMonth() !== +d[2] - 1 || t.getUTCDate() !== +d[3]) throw invalid(path, 'use a date like 2026-12-31');
      return s;
    }
    case 'phone': {
      const s = toText(v, path, 60, true);
      if (s && !/^[0-9+()\-\s,/]+$/.test(s)) throw invalid(path, 'use digits, spaces, + - ( ) only');
      return s;
    }
    case 'whatsapp': {
      let s = toText(v, path, 30, true).replace(/[\s+()-]/g, '');
      if (!s) return '';
      if (/^03\d{9}$/.test(s)) s = `92${s.slice(1)}`; // 0300 1234567 -> 923001234567
      if (!/^\d{8,15}$/.test(s)) throw invalid(path, 'use the number with country code, like 923001234567');
      return s;
    }
    case 'email': {
      const s = toText(v, path, 200, true);
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw invalid(path, 'not a valid email address');
      return s;
    }
    default:
      throw new Error(`websiteService: unknown kind ${kind}`);
  }
}

const emptyOf = (kind) => {
  if (kind === 'bool') return false;
  if (kind === 'boolTrue') return true;
  if (kind === 'price') return 0;
  if (kind === 'icon') return 'star';
  if (isObj(kind)) return Object.fromEntries(Object.entries(kind).map(([k, sub]) => [k, emptyOf(sub)]));
  return '';
};

// ---------------------------------------------------------------- clean
/** Validate `input` against `spec`; fields missing from input keep `current`. Throws 400. */
function clean(spec, input, current, path) {
  if (typeof spec === 'string') return input === undefined ? current : leaf(spec, input, path);
  if (spec.$items) {
    if (input === undefined) return current;
    if (!Array.isArray(input)) throw invalid(path, 'must be a list');
    if (input.length > spec.max) throw invalid(path, `too many items (${input.length}, max ${spec.max})`);
    return input.map((item, i) => {
      if (!isObj(item)) throw invalid([...path, i], 'must be an item');
      return clean(spec.$items, item, emptyOf(spec.$items), [...path, i]);
    });
  }
  if (input === undefined) return current;
  if (!isObj(input)) throw invalid(path, 'must be a group of fields');
  const out = {};
  for (const [k, sub] of Object.entries(spec)) {
    out[k] = clean(sub, input[k], current?.[k], [...path, k]);
  }
  return out;
}

/** Fill a stored (already valid) value over the defaults, keeping only known fields. */
function shape(spec, stored, def) {
  if (typeof spec === 'string') {
    if (stored === undefined || stored === null) return def === undefined ? emptyOf(spec) : def;
    return stored;
  }
  if (spec.$items) {
    const arr = Array.isArray(stored) ? stored : Array.isArray(def) ? def : [];
    return arr.filter(isObj).map((item) => shape(spec.$items, item, emptyOf(spec.$items)));
  }
  const s = isObj(stored) ? stored : {};
  const d = isObj(def) ? def : {};
  return Object.fromEntries(Object.entries(spec).map(([k, sub]) => [k, shape(sub, s[k], d[k])]));
}

function checkCrossFields(content) {
  (content.offers?.items || []).forEach((o, i) => {
    if (o.startsOn && o.endsOn && o.endsOn < o.startsOn) throw invalid(['offers', i, 'endsOn'], 'is before the start date');
  });
}

// ---------------------------------------------------------------- output
function toContent(doc, { includeUser = true } = {}) {
  const content = shape(SPEC, doc?.content, WEBSITE_DEFAULTS);
  content.updatedAt = doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null;
  if (includeUser) content.updatedByName = doc?.updatedByName || '';
  return content;
}

const loadDoc = () => SiteContent.findOne({ key: KEY }).lean();

/** Public website content (no internal ids / user names). Defaults when nothing saved yet. */
async function getPublic() {
  return toContent(await loadDoc(), { includeUser: false });
}

/** Admin: content + icons, defaults and limits for the editor. */
async function getAdmin() {
  return {
    data: toContent(await loadDoc()),
    meta: { icons: [...WEBSITE_ICONS], defaults: clone(WEBSITE_DEFAULTS), limits: { ...LIMITS } },
  };
}

async function nameOf(userId) {
  if (!userId) return '';
  const u = await User.findById(userId).select('firstName lastName email').lean().catch(() => null);
  if (!u) return '';
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '';
}

async function persist(content, userId) {
  const doc = await SiteContent.findOneAndUpdate(
    { key: KEY },
    { $set: { content, updatedBy: userId || null, updatedByName: await nameOf(userId) } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return doc;
}

/**
 * Tell the website to rebuild its page now (docs §2). Never throws.
 * @returns {Promise<'done'|'failed'|'skipped'>}
 */
async function refreshWebsite() {
  const base = String(process.env.MARKETING_SITE_URL || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.MARKETING_REVALIDATE_SECRET || '').trim();
  if (!base || !secret) return 'skipped';
  try {
    const res = await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/' }),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    if (!res.ok) console.warn('[website] refresh hook answered', res.status);
    return res.ok ? 'done' : 'failed';
  } catch (err) {
    console.warn('[website] refresh hook failed:', err.message);
    return 'failed';
  }
}

/** Save content (sections left out stay as they are). */
async function save(body, { userId } = {}) {
  if (!isObj(body)) throw httpError(400, 'Send the website content', 'INVALID_CONTENT');
  const current = toContent(await loadDoc());
  const next = clean(SPEC, body, current, []);
  checkCrossFields(next);
  delete next.updatedAt;
  delete next.updatedByName;
  const doc = await persist(next, userId);
  const refresh = await refreshWebsite();
  return { data: toContent(doc), meta: { refresh } };
}

/** Put one section back to its default content. */
async function resetSection(section, { userId } = {}) {
  if (!SECTIONS.includes(section)) throw httpError(400, 'Choose a section to reset', 'INVALID_SECTION');
  const current = toContent(await loadDoc());
  delete current.updatedAt;
  delete current.updatedByName;
  current[section] = clone(WEBSITE_DEFAULTS[section]);
  const doc = await persist(current, userId);
  const refresh = await refreshWebsite();
  return { data: toContent(doc), meta: { refresh } };
}

module.exports = { getPublic, getAdmin, save, resetSection, refreshWebsite, SECTIONS, LIMITS };
