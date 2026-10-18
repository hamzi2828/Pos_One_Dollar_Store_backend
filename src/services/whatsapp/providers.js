// src/services/whatsapp/providers.js
// Send one text message to a WhatsApp chat/group through a gateway.
//
//   const { sendText } = require('./providers');
//   const r = await sendText(settings, { to: '1203630xxxx@g.us', body: 'Hi' });
//   // -> { ok: true, id: 'provider message id' } | { ok: false, error: 'why' }
//
// Providers (pick in /admin/whatsapp):
//   ultramsg  POST {apiUrl|https://api.ultramsg.com}/{instanceId}/messages/chat
//             form: token, to, body                      -> { sent: "true", id }
//   greenapi  POST {apiUrl|https://api.green-api.com}/waInstance{instanceId}/sendMessage/{token}
//             JSON: { chatId, message }                  -> { idMessage }
//   webhook   POST {apiUrl} JSON { channel, to, body, meta } (Bearer token if set) -> any 2xx
//
// Note: the official WhatsApp Cloud API (Meta) cannot post into groups, so a
// gateway that drives a linked WhatsApp number (UltraMsg / Green API) or your
// own webhook is needed for group slips.
//
// Never throws; never puts the token into an error message.

const DEFAULT_TIMEOUT_MS = 5000;

async function postWithTimeout(url, { headers = {}, body, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

const short = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.slice(0, 300);
};

async function sendUltraMsg(s, { to, body }, timeoutMs) {
  const base = s.apiUrl || 'https://api.ultramsg.com';
  const url = `${base}/${encodeURIComponent(s.instanceId)}/messages/chat`;
  const form = new URLSearchParams({ token: s.token, to, body, priority: '10' });
  const r = await postWithTimeout(url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    timeoutMs,
  });
  const d = r.data || {};
  if (r.ok && (d.sent === 'true' || d.sent === true)) return { ok: true, id: d.id ? String(d.id) : '' };
  return { ok: false, error: short(d.error || d.message || r.text) || `HTTP ${r.status}` };
}

async function sendGreenApi(s, { to, body }, timeoutMs) {
  const base = s.apiUrl || 'https://api.green-api.com';
  const url = `${base}/waInstance${encodeURIComponent(s.instanceId)}/sendMessage/${encodeURIComponent(s.token)}`;
  const r = await postWithTimeout(url, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: to, message: body }),
    timeoutMs,
  });
  const d = r.data || {};
  if (r.ok && d.idMessage) return { ok: true, id: String(d.idMessage) };
  return { ok: false, error: short(d.message || d.error || r.text) || `HTTP ${r.status}` };
}

async function sendWebhook(s, { to, body, meta }, timeoutMs) {
  const headers = { 'Content-Type': 'application/json' };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const r = await postWithTimeout(s.apiUrl, {
    headers,
    body: JSON.stringify({ channel: 'whatsapp', to, body, meta: meta || {} }),
    timeoutMs,
  });
  if (r.ok) {
    const d = r.data || {};
    return { ok: true, id: d.id || d.messageId ? String(d.id || d.messageId) : '' };
  }
  const d = r.data || {};
  return { ok: false, error: short(d.message || d.error || r.text) || `HTTP ${r.status}` };
}

const SENDERS = { ultramsg: sendUltraMsg, greenapi: sendGreenApi, webhook: sendWebhook };

async function sendText(settings, message) {
  const send = SENDERS[settings.provider];
  if (!send) return { ok: false, error: `Unknown provider "${settings.provider}"` };
  if (settings.provider === 'webhook' ? !settings.apiUrl : !settings.instanceId || !settings.token) {
    return { ok: false, error: 'WhatsApp provider is not fully set up' };
  }
  const timeoutMs = Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS;
  try {
    return await send(settings, message, timeoutMs);
  } catch (err) {
    const why =
      err && err.name === 'AbortError'
        ? `No answer within ${Math.round(timeoutMs / 1000)} s`
        : (err && err.cause && err.cause.code) || (err && err.message) || 'Send failed';
    const clean = settings.token ? String(why).split(settings.token).join('***') : String(why);
    return { ok: false, error: clean.slice(0, 300) };
  }
}

module.exports = { sendText };
