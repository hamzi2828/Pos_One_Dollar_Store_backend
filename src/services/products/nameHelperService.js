// "Improve name" on the product form: OpenAI cleans up a typed product name
// (spelling, capitals, order: brand · item · size/colour). The key stays on the
// server: env OPENAI_API_KEY (optional OPENAI_MODEL, default gpt-4o-mini).
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const SYSTEM = [
  'You fix product names for a Pakistani dollar-store POS (shop DOLLAR & Co).',
  'Return ONLY the corrected product name: no quotes, no explanation.',
  'Rules: fix spelling; use Title Case; keep brand names, model numbers, sizes, counts and colours;',
  'order as Brand + Item + Variant (size / colour / pack); remove filler words, emojis and repeated words;',
  'expand obvious short forms (e.g. "pcs" -> "Pcs", "ml" -> "ml", "ltr" -> "Ltr");',
  'Roman Urdu or Urdu item words may be translated to the common English shop name (e.g. "chappal" -> "Slippers") only when sure;',
  'keep it short (max 80 characters); never invent a brand or size that is not in the input.',
].join(' ');

/** POST /products/improve-name { name, category? } -> { name, original } */
async function improveName(body = {}) {
  const original = String(body.name || '').trim().slice(0, 200);
  if (!original) throw httpError(400, 'Type a product name first');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw httpError(503, 'The name helper is not set up yet (OPENAI_API_KEY is missing on the server).', 'NAME_HELPER_OFF');
  const category = String(body.category || '').trim().slice(0, 80);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL(),
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: category ? `Category: ${category}\nName: ${original}` : `Name: ${original}` },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw httpError(502, err.name === 'AbortError' ? 'The name helper took too long. Try again.' : 'Could not reach the name helper. Try again.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.error('[improve-name] OpenAI', res.status, (await res.text().catch(() => '')).slice(0, 300));
    throw httpError(502, res.status === 401 ? 'The name helper key is not valid. Check OPENAI_API_KEY.' : 'The name helper could not answer. Try again.');
  }
  const data = await res.json();
  let name = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  name = name.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').slice(0, 120).trim();
  if (!name) throw httpError(502, 'The name helper gave no name. Try again.');
  return { name, original };
}

module.exports = { improveName };
