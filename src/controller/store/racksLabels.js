// src/controller/store/racksLabels.js
// Printable shelf / rack labels: the code in big letters + a Code 128 barcode
// of the same code (scanned during put-away). Self-contained HTML page
// (inline CSS + SVG, no external requests), same approach as the product
// stickers in controller/labelController.js: the frontend fetches it with its
// token and opens it through a blob URL, then the browser prints it.
//
//   GET /api/racks/labels?rackId=|zone=  &type=shelf|rack|both &size=50x30|60x40|100x50|a4 &copies=1 &autoPrint=1
//   (no rackId / zone -> every active rack of the branch)
const code128 = require('../../helper/code128');
const racksService = require('../../services/inventory/racksService');
const { httpError, moduleBranch } = require('./racksCommon');

const MAX_LABELS = 2000;
const SIZES = {
  '50x30': { key: '50x30', label: '50 x 30 mm (thermal)', w: 50, h: 30, kind: 'thermal' },
  '60x40': { key: '60x40', label: '60 x 40 mm (thermal)', w: 60, h: 40, kind: 'thermal' },
  '100x50': { key: '100x50', label: '100 x 50 mm (thermal, big)', w: 100, h: 50, kind: 'thermal' },
  a4: { key: 'a4', label: 'A4 sheet, 24 labels (3 x 8, 70 x 37 mm)', w: 70, h: 37, kind: 'sheet', cols: 3, rows: 8 },
};
const TYPES = ['shelf', 'rack', 'both'];

const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truncate = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

// Big code font (mm): fits both the label height and its width.
const bigFont = (size, text) => Math.min(size.h * 0.36, (size.w - 5) / (Math.max(2, text.length) * 0.64)).toFixed(2);

const renderLabel = (item, size) =>
  [
    '<div class="label">',
    `<div class="top"><span class="sub">${escapeHtml(item.sub)}</span><span class="br">${escapeHtml(item.branch)}</span></div>`,
    `<div class="big" style="font-size:${bigFont(size, item.code)}mm">${escapeHtml(item.code)}</div>`,
    `<div class="bc">${code128.toSVG(item.code, { height: 40, quietZone: 10 })}</div>`,
    '</div>',
  ].join('');

const buildCss = (size) => {
  const { w, h } = size;
  const common = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#000}
body{font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.label{width:${w}mm;height:${h}mm;overflow:hidden;padding:1.5mm 2.5mm;display:flex;flex-direction:column;background:#fff;line-height:1}
.top{display:flex;justify-content:space-between;gap:2mm;font-size:${Math.max(2.2, h * 0.085).toFixed(2)}mm;font-weight:600;text-transform:uppercase;letter-spacing:.02em;flex:none}
.top .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.top .br{flex:none;opacity:.7}
.big{font-weight:900;text-align:center;letter-spacing:.02em;white-space:nowrap;flex:none;margin:.6mm 0 .4mm;line-height:1}
.bc{position:relative;flex:1 1 auto;min-height:6mm}
.bc svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.toolbar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#111827;color:#fff;font-size:14px}
.toolbar button{font:inherit;font-weight:600;padding:6px 16px;border:0;border-radius:6px;background:#dc2626;color:#fff;cursor:pointer}
.toolbar .tip{opacity:.75;font-size:12px}
.toolbar .warn{flex-basis:100%;color:#fde68a;font-size:12px}
@media print{.toolbar{display:none!important}}
`;
  if (size.kind === 'sheet') {
    return `${common}
@page{size:A4;margin:0}
.sheet{width:210mm;height:297mm;padding-top:0.5mm;display:grid;grid-template-columns:repeat(${size.cols},${w}mm);grid-auto-rows:${h}mm;align-content:start;overflow:hidden;break-after:page;page-break-after:always;background:#fff}
.sheet:last-child{break-after:auto;page-break-after:auto}
.sheet .label{padding:2.5mm 4mm}
@media screen{html,body{background:#e5e7eb;min-height:100%}.sheet{margin:16px auto;box-shadow:0 1px 6px rgba(0,0,0,.25)}.sheet .label{outline:1px dashed #cbd5e1;outline-offset:-1px}}
`;
  }
  return `${common}
@page{size:${w}mm ${h}mm;margin:0}
@media print{html,body{width:${w}mm}.label{break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}}
@media screen{html,body{background:#e5e7eb;min-height:100%}.labels{display:flex;flex-wrap:wrap;gap:8px;padding:16px}.label{box-shadow:0 1px 4px rgba(0,0,0,.3)}}
`;
};

function renderPage({ items, size, title, capped, autoPrint }) {
  const flat = items.map((it) => renderLabel(it, size));
  let body;
  if (size.kind === 'sheet') {
    const per = size.cols * size.rows;
    const sheets = [];
    for (let i = 0; i < flat.length; i += per) sheets.push(`<div class="sheet">${flat.slice(i, i + per).join('')}</div>`);
    body = sheets.join('\n');
  } else {
    body = `<div class="labels">${flat.join('\n')}</div>`;
  }
  const tip =
    size.kind === 'sheet'
      ? 'In the print dialog choose paper A4, margins None, scale 100%.'
      : `In the print dialog choose your label printer, paper ${size.w} x ${size.h} mm, margins None, scale 100%.`;
  const warn = capped ? `<div class="warn">Only the first ${MAX_LABELS} labels are shown. Print one zone at a time.</div>` : '';
  const toolbar = `<div class="toolbar"><button type="button" onclick="window.print()">Print</button><strong>${flat.length} label${
    flat.length === 1 ? '' : 's'
  }</strong><span>${escapeHtml(size.label)}</span><span class="tip">${escapeHtml(tip)}</span>${warn}</div>`;
  const auto = autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)});</script>' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${buildCss(size)}</style>
</head>
<body>
${toolbar}
${body}
${auto}
</body>
</html>`;
}

/** GET /api/racks/labels */
async function printLabels(req, res) {
  const q = req.query || {};
  const sizeKey = String(q.size || '50x30').toLowerCase();
  const size = SIZES[sizeKey];
  if (!size) throw httpError(`Unknown label size "${q.size}". Use one of: ${Object.keys(SIZES).join(', ')}`);
  const type = String(q.type || 'shelf').toLowerCase();
  if (!TYPES.includes(type)) throw httpError(`Label type must be one of: ${TYPES.join(', ')}`);
  const copies = q.copies === undefined || q.copies === '' ? 1 : Number(q.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw httpError('Copies must be a whole number from 1 to 10');

  const { branchId, branch } = await moduleBranch(req);
  const targets = await racksService.labelTargets({ branchId, rackId: q.rackId || null, zone: q.zone || null });

  const items = [];
  for (const { rack, shelves } of targets) {
    const rackSub = rack.name ? `Rack ${rack.code} · ${rack.name}` : `Rack ${rack.code}`;
    if (type !== 'shelf') {
      const sub = `${rack.name || 'Rack'} · ${shelves.length} shelves`;
      for (let c = 0; c < copies; c++) items.push({ code: rack.code, sub: truncate(sub, 40), branch: branch.code || '' });
    }
    if (type !== 'rack') {
      for (const s of shelves) {
        const sub = s.name ? `${rackSub} · ${s.name}` : rackSub;
        for (let c = 0; c < copies; c++) items.push({ code: s.code, sub: truncate(sub, 40), branch: branch.code || '' });
      }
    }
  }
  if (!items.length) throw httpError('Nothing to print: no active racks / shelves here yet.', 404, { code: 'NO_LABELS' });

  const capped = items.length > MAX_LABELS;
  const shown = items.slice(0, MAX_LABELS);
  const scope = q.rackId && targets[0] ? `Rack ${targets[0].rack.code}` : q.zone ? `Zone ${String(q.zone).toUpperCase()}` : 'All racks';
  const html = renderPage({
    items: shown,
    size,
    title: `Shelf labels - ${scope} - ${branch.name || ''}`.trim(),
    capped,
    autoPrint: ['1', 'true', 'yes'].includes(String(q.autoPrint || '').toLowerCase()),
  });
  res.set('Cache-Control', 'no-store');
  res.set('X-Label-Count', String(shown.length));
  res.status(200).type('html').send(html);
}

module.exports = { printLabels, SIZES, MAX_LABELS };
