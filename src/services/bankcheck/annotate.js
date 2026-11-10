// Draw the check result on the original statement PDF (pdf-lib):
// a see-through coloured box per row, a short label in the INST. NO. column,
// and a summary page at the end.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const FILL = { ok: rgb(0.75, 0.95, 0.75), fix: rgb(1, 0.85, 0.55), missing: rgb(1, 0.6, 0.6), in: rgb(0.72, 0.84, 1) };
const INK = { ok: rgb(0, 0.4, 0), fix: rgb(0.6, 0.3, 0), missing: rgb(0.8, 0, 0), in: rgb(0.05, 0.25, 0.6) };
const NAME = { ok: 'OK - in the system', fix: 'Check / fix in the system', missing: 'Not in the system', in: 'Money in' };

// Standard PDF fonts only know Latin-1: replace anything else.
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const money = (n) => `Rs ${Number(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US')}`;

function wrap(text, font, size, width, maxLines) {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1].replace(/.{0,3}$/, '')}...`;
    return cut;
  }
  return lines;
}

/**
 * src: original PDF bytes. rows: [{ page, rect, labelX, labelW, status, label }]
 * summary: { title, lines: [...strings], sections: [{ heading, items: [string] }], counts, totals }
 */
async function markPdf(src, rows, summary) {
  const pdf = await PDFDocument.load(src, { ignoreEncryption: true, updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const r of rows) {
    const page = pages[r.page];
    if (!page || !FILL[r.status]) continue;
    const { x0, x1, y0, y1 } = r.rect;
    page.drawRectangle({
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      color: FILL[r.status],
      opacity: r.status === 'in' ? 0.2 : 0.3,
      borderColor: INK[r.status],
      borderOpacity: 0.6,
      borderWidth: r.status === 'ok' || r.status === 'in' ? 0.5 : 1.1,
    });
    if (r.label) {
      const size = 5.6;
      const lead = size + 1.2;
      const maxLines = Math.max(1, Math.floor((y1 - y0 - 4) / lead));
      wrap(r.label, font, size, r.labelW, maxLines).forEach((t, k) => {
        page.drawText(t, { x: r.labelX, y: y1 - 4 - size - k * lead + 1, size, font, color: INK[r.status] });
      });
    }
  }

  // Summary pages (A4).
  const W = 595.28;
  const H = 841.89;
  let page = pdf.addPage([W, H]);
  let y = H - 50;
  const newPageIfNeeded = (need = 14) => {
    if (y - need < 40) {
      page = pdf.addPage([W, H]);
      y = H - 50;
    }
  };
  const text = (t, { size = 9, f = font, color = rgb(0.1, 0.1, 0.1), x = 40, maxW = W - 80 } = {}) => {
    for (const line of wrap(t, f, size, maxW, 50)) {
      newPageIfNeeded(size + 4);
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + 4;
    }
  };

  text(summary.title, { size: 16, f: bold });
  y -= 4;
  for (const l of summary.lines || []) text(l, { size: 9 });
  y -= 8;
  for (const st of ['ok', 'fix', 'missing', 'in']) {
    newPageIfNeeded(16);
    page.drawRectangle({ x: 40, y: y - 2, width: 18, height: 10, color: FILL[st], opacity: 0.6, borderColor: INK[st], borderWidth: 0.8 });
    const c = summary.counts[st] || 0;
    const amt = summary.totals[st] || 0;
    page.drawText(safe(`${NAME[st]}: ${c} line${c === 1 ? '' : 's'}, ${money(amt)}`), { x: 66, y, size: 10, font: bold, color: INK[st] });
    y -= 18;
  }
  y -= 6;
  for (const s of summary.sections || []) {
    if (!s.items.length) continue;
    y -= 6;
    text(s.heading, { size: 11, f: bold, color: s.color ? INK[s.color] : rgb(0.1, 0.1, 0.1) });
    for (const it of s.items) text(`- ${it}`, { size: 8, x: 48, maxW: W - 96 });
  }
  y -= 10;
  text('Made by DOLLAR & Co POS Bank Check. Colours: green = OK, orange = check, red = not in the system, blue = money in.', {
    size: 7,
    color: rgb(0.4, 0.4, 0.4),
  });

  return Buffer.from(await pdf.save());
}

module.exports = { markPdf, safe };
