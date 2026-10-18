// src/services/whatsapp/settings.js
// WhatsApp settings, stored in AppConfig under the key "whatsapp":
//   { enabled, provider: 'ultramsg'|'greenapi'|'webhook', instanceId, token, apiUrl,
//     groupId, sendOn: { sale, payment },
//     header, footer, timeoutMs }
// The token is a secret: publicSettings() masks it, saveSettings() keeps the
// stored token when the browser sends back the mask or an empty value.
const config = require('../configService');

const CONFIG_KEY = 'whatsapp';
const PROVIDERS = ['ultramsg', 'greenapi', 'webhook'];
const MASK = '••••';

const DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'ultramsg',
  instanceId: '',
  token: '',
  apiUrl: '',
  groupId: '',
  sendOn: { sale: true, payment: true },
  header: '',
  footer: 'Thank you for shopping with us!',
  timeoutMs: 5000,
});

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttpUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Stored settings merged over the defaults (token included — server use only). */
async function getSettings() {
  const raw = { ...((await config.get(CONFIG_KEY, {})) || {}) };
  delete raw.perBranchGroup; // old multi-branch setting
  return {
    ...DEFAULTS,
    ...raw,
    sendOn: { ...DEFAULTS.sendOn, ...(raw.sendOn || {}) },
  };
}

function maskToken(token) {
  if (!token) return '';
  return token.length > 8 ? `${MASK}${token.slice(-4)}` : MASK;
}

/** Safe for the browser: token replaced by a mask. */
function publicSettings(s) {
  const { token, ...rest } = s;
  return { ...rest, token: maskToken(token), hasToken: !!token };
}

/** Group the shop's slips are posted to. */
const groupFor = (settings) => settings.groupId || '';

/** Problems that stop sending (empty list = ready). */
function missingFields(s) {
  const out = [];
  if (s.provider === 'webhook') {
    if (!s.apiUrl) out.push('webhook URL');
  } else {
    if (!s.instanceId) out.push('instance ID');
    if (!s.token) out.push('API token');
  }
  if (!s.groupId) out.push('group ID');
  return out;
}

/** Validate + save. Unknown keys are ignored. Returns the public view. */
async function saveSettings(input = {}, userId = null) {
  const current = await getSettings();
  const next = { ...current };

  if (input.enabled !== undefined) next.enabled = input.enabled === true || input.enabled === 'true';
  if (input.provider !== undefined) {
    if (!PROVIDERS.includes(input.provider)) throw badRequest('Provider must be UltraMsg, Green API or Webhook.');
    next.provider = input.provider;
  }
  if (input.instanceId !== undefined) next.instanceId = str(input.instanceId, 100);
  if (input.apiUrl !== undefined) {
    const url = str(input.apiUrl, 300).replace(/\/+$/, '');
    if (url && !isHttpUrl(url)) throw badRequest('API URL must start with http:// or https://');
    next.apiUrl = url;
  }
  if (input.clearToken === true) next.token = '';
  else if (typeof input.token === 'string') {
    const t = input.token.trim();
    // Empty or the mask we sent out = keep the stored token.
    if (t && !t.startsWith(MASK)) next.token = t.slice(0, 300);
  }
  if (input.groupId !== undefined) next.groupId = str(input.groupId, 120);
  if (input.sendOn && typeof input.sendOn === 'object') {
    next.sendOn = {
      sale: input.sendOn.sale === undefined ? current.sendOn.sale : !!input.sendOn.sale,
      payment: input.sendOn.payment === undefined ? current.sendOn.payment : !!input.sendOn.payment,
    };
  }
  if (input.header !== undefined) next.header = str(input.header, 500);
  if (input.footer !== undefined) next.footer = str(input.footer, 500);
  if (input.timeoutMs !== undefined) {
    const ms = Number(input.timeoutMs);
    next.timeoutMs = Number.isFinite(ms) ? Math.min(15000, Math.max(1000, Math.round(ms))) : DEFAULTS.timeoutMs;
  }

  if (next.enabled) {
    const missing = missingFields(next);
    if (missing.length) throw badRequest(`To switch WhatsApp on, fill in: ${missing.join(', ')}.`);
  }

  await config.set(CONFIG_KEY, next, userId);
  return publicSettings(next);
}

module.exports = {
  CONFIG_KEY,
  PROVIDERS,
  DEFAULTS,
  getSettings,
  publicSettings,
  saveSettings,
  groupFor,
  missingFields,
  maskToken,
};
