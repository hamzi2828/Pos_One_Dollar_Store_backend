// src/controller/labelController.js
//
// Barcode sticker printing. The backend renders a self-contained HTML page
// (inline CSS + inline SVG barcodes, no external requests) that the frontend
// fetches with its Bearer token and opens through a blob URL. The browser
// print dialog then sends it to a thermal label printer (one label per page)
// or to an A4 sheet printer.
//
// Handlers:
//   getLabelData  GET  /products/:id/label-data   JSON for a label picker UI
//   printLabels   GET  /products/:id/labels       text/html, one product
//   printBulk     POST /products/labels/print     text/html, many products
//
// Label types (`type`):
//   unit      barcode = shortCode (fallback sku); copies = stock
//   box       barcode = shortCode (one scan = 1 piece) + "Box of N"; copies = ceil(stock / piecesPerBox)
//   full-box  barcode = "<shortCode>-BOX" (one scan = N pieces) + "Full box · N pcs"; copies = ceil(stock / piecesPerBox)
//   batch     barcode = batch.barcode, shows batch no + expiry; copies = batch quantity (in boxes for box products)
//   barcode   barcode = `code` param (must be one of the unit's own codes); copies = ceil(stock / code qty)
//
// Default copies use the shop's stock (req.access.branchId = the shop);
// `batch` labels list the shop's batches.
//
// Sizes: 38x25 (default), 40x30, 50x25, 50x30, 60x40 (thermal, one label per page),
//        a4 (A4 sheet, 3 columns x 8 rows = 24 labels of 70 x 37 mm, no page margins).

const mongoose = require('mongoose');
const Product = require('../models/product');
const Settings = require('../models/settings');
const code128 = require('../helper/code128');
const labelPrintLog = require('../services/labelPrintLog');
const {
  listUnits,
  variantLabel,
  normalizeCode,
  PRODUCT_UNIT,
  unitBranchStock,
  batchBranchId,
  sameBranch,
  getMainBranchId,
} = require('../helper/productCodes');

const MAX_LABELS = 1000;
const MAX_BULK_ITEMS = 500;

const SIZES = {
  // 1 x 0.5 inch roll: name + barcode + code only (no shop name, no extra line).
  '25x13': { key: '25x13', label: '25 x 15 mm (tiny roll, thermal)', widthMm: 25.4, heightMm: 15, gapMm: 2.5, kind: 'thermal', tiny: true },
  '38x25': { key: '38x25', label: '38 x 25 mm (thermal)', widthMm: 38, heightMm: 25, kind: 'thermal' },
  '40x30': { key: '40x30', label: '40 x 30 mm (thermal)', widthMm: 40, heightMm: 30, kind: 'thermal' },
  '50x25': { key: '50x25', label: '50 x 25 mm (thermal)', widthMm: 50, heightMm: 25, kind: 'thermal' },
  '50x30': { key: '50x30', label: '50 x 30 mm (thermal)', widthMm: 50, heightMm: 30, kind: 'thermal' },
  '60x40': { key: '60x40', label: '60 x 40 mm (thermal)', widthMm: 60, heightMm: 40, kind: 'thermal' },
  a4: {
    key: 'a4',
    label: 'A4 sheet, 24 labels (3 x 8, 70 x 37 mm)',
    widthMm: 70,
    heightMm: 37,
    kind: 'sheet',
    cols: 3,
    rows: 8,
    pageWidthMm: 210,
    pageHeightMm: 297,
  },
};
const DEFAULT_SIZE = '38x25';
const TYPES = ['unit', 'box', 'full-box', 'batch', 'barcode'];
const CURRENCY_SYMBOLS = { PKR: 'Rs', USD: '$', GBP: '£', EUR: '€' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- small helpers ----------

const badRequest = (message, extra = {}) => {
  const err = new Error(message);
  err.status = 400;
  Object.assign(err, extra);
  return err;
};

const notFound = (message, extra = {}) => {
  const err = new Error(message);
  err.status = 404;
  Object.assign(err, extra);
  return err;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const truncate = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

// "1", "true", "yes", "on" -> true; "0", "false", "no", "off" -> false; else fallback.
const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
};

const parseCopies = (value, where = 'copies') => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LABELS) {
    throw badRequest(`${where} must be a whole number from 1 to ${MAX_LABELS}`);
  }
  return n;
};

const parseSize = (value) => {
  const key = value === undefined || value === null || value === '' ? DEFAULT_SIZE : String(value).trim().toLowerCase();
  if (!SIZES[key]) throw badRequest(`Unknown label size "${value}". Use one of: ${Object.keys(SIZES).join(', ')}`);
  return SIZES[key];
};

const parseType = (value, where = 'type') => {
  const t = value === undefined || value === null || value === '' ? 'unit' : String(value).trim().toLowerCase();
  if (!TYPES.includes(t)) throw badRequest(`Unknown ${where} "${value}". Use one of: ${TYPES.join(', ')}`);
  return t;
};

const asString = (value) => (value === undefined || value === null || value === '' ? undefined : String(value).trim());

const formatMoney = (amount, symbol) => {
  const n = Number(amount) || 0;
  const text = n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol} ${text}` : text;
};

// Unambiguous: "31 Mar 2027"
const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d)) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const sellPrice = (unit) => {
  const discounted = Number(unit.discountedPrice);
  if (Number.isFinite(discounted) && discounted > 0) return discounted;
  return Number(unit.price) || 0;
};

const ceilDiv = (a, b) => Math.ceil((Number(a) || 0) / Math.max(1, Number(b) || 1));
const atLeastOne = (n) => Math.max(1, Math.floor(Number(n) || 0));

const getShopSettings = async (overrides = {}) => {
  let shopName = '';
  try {
    const s = await Settings.findOne({ isActive: true }).lean();
    if (s && s.siteName) shopName = String(s.siteName).trim();
  } catch (e) {
    // labels still print without a shop name
  }
  // The POS screens always price in PKR, so labels default to "Rs" regardless
  // of the shop currency in Settings. `currency` can override (code or symbol).
  let currency = 'Rs';
  const cur = asString(overrides.currency);
  if (cur) currency = CURRENCY_SYMBOLS[cur.toUpperCase()] || truncate(cur, 4);
  return { shopName, currency };
};

const isFullBoxCode = (unit, code) => code === `${normalizeCode(unit.shortCode)}-BOX`;

// The unit's barcode entry for "<shortCode>-BOX", if it exists.
const fullBoxEntry = (unit) => {
  if (!unit.shortCode) return null;
  return (unit.barcodes || []).find((b) => b && isFullBoxCode(unit, normalizeCode(b.code))) || null;
};

const unitMainCode = (unit) => normalizeCode(unit.shortCode) || normalizeCode(unit.sku);

// Branch whose stock sets the default copies: the shop.
const labelBranch = async (req) => {
  const branchId = req && req.access && req.access.branchId ? String(req.access.branchId) : null;
  return { branchId, mainBranchId: branchId ? await getMainBranchId() : null };
};

// Batches of a unit for labels (plain objects). With a branch: that branch's
// batches. Without: one entry per batchNo (a lot split over branches by a
// transfer has the same code everywhere), quantity summed.
const unitBatchesFor = (unit, branchId, mainBranchId) => {
  const out = [];
  const byNo = new Map();
  for (const b of unit.batches || []) {
    if (!b) continue;
    if (branchId && !sameBranch(batchBranchId(b, mainBranchId), branchId)) continue;
    const batchNo = normalizeCode(b.batchNo);
    const quantity = Number(b.quantity) || 0;
    const prev = byNo.get(batchNo);
    if (prev) {
      prev.quantity += quantity;
      continue;
    }
    const row = { batchNo: b.batchNo, barcode: b.barcode || null, quantity, expiryDate: b.expiryDate || null };
    byNo.set(batchNo, row);
    out.push(row);
  }
  return out;
};

// Units of a product, optionally only one variant.
const pickUnits = (product, variantId) => {
  const units = listUnits(product);
  if (!variantId) return { units, specific: product.productType !== 'variant' };
  if (product.productType !== 'variant') throw badRequest('variantId was given but this product has no variants');
  const hit = units.find(({ key, variant }) => String(key) === variantId || String(variant && variant._id) === variantId);
  if (!hit) throw notFound(`Variant "${variantId}" not found on this product`);
  return { units: [hit], specific: true };
};

// ---------- building label entries ----------

/**
 * Label entries for one product.
 * opts: { variantId, type, batchNo, code, copies, branchId?, mainBranchId? }
 *   branchId: default copies from that branch's stock / batches (null = all branches)
 * Returns { entries: [{ ...labelContent, copies }], skipped: [string] }.
 * Throws 400 when a specific unit was asked for and it cannot produce the label.
 */
const buildEntries = (product, opts) => {
  const type = opts.type || 'unit';
  const ppb = Math.max(1, Math.floor(Number(product.piecesPerBox) || 1)); // sales in one box/pack
  // Pieces in one sale (e.g. 2 plates for one price); variants are sold one by one.
  const pps = Math.max(1, Math.floor(Number(product.piecesPerSale) || 1));
  const { units, specific } = pickUnits(product, opts.variantId);
  const entries = [];
  const skipped = [];

  for (const { key, variant, unit } of units) {
    const vLabel = variant ? variantLabel(variant) || variant.sku || 'Variant' : '';
    const who = variant ? `${product.name} (${vLabel})` : product.name;
    const base = {
      productId: String(product._id),
      variantId: key === PRODUCT_UNIT ? null : key,
      name: product.name,
      variant: vLabel,
      price: sellPrice(unit),
      extra: !variant && pps > 1 ? [`${pps} pcs · scan once`] : [],
      pps: variant ? 1 : pps,
    };
    const stock = unitBranchStock(unit, opts.branchId || null, opts.mainBranchId);
    const mainCode = unitMainCode(unit);
    const fail = (reason) => {
      if (specific) throw badRequest(`${who}: ${reason}`);
      skipped.push(`${who}: ${reason}`);
    };

    if (type === 'unit' || type === 'box') {
      if (!mainCode) {
        fail('no short code or SKU to print. Save the product again to generate a short code');
        continue;
      }
      if (type === 'box') {
        if (ppb <= 1) {
          fail('box labels need "pieces per box" greater than 1');
          continue;
        }
        entries.push({ ...base, kind: 'box', code: mainCode, extra: [`Box/pack of ${variant ? ppb : ppb * pps}`], defaultCopies: atLeastOne(ceilDiv(stock, ppb)) });
      } else {
        // Sold in sets: a tag on every piece (stock is in sets).
        entries.push({ ...base, kind: 'unit', code: mainCode, defaultCopies: atLeastOne(stock * (variant ? 1 : pps)) });
      }
      continue;
    }

    if (type === 'full-box') {
      const fb = ppb > 1 ? fullBoxEntry(unit) : null;
      if (!fb) {
        fail(
          ppb > 1
            ? `no full-box barcode (${unit.shortCode ? `${normalizeCode(unit.shortCode)}-BOX` : 'short code missing'}). Enable the full-box barcode on the product first`
            : 'full-box labels need "pieces per box" greater than 1'
        );
        continue;
      }
      entries.push({
        ...base,
        kind: 'full-box',
        code: normalizeCode(fb.code),
        extra: [`Full box/pack · ${variant ? ppb : ppb * pps} pcs`],
        // price of the whole box, since one scan sells ppb pieces
        price: base.price * ppb,
        defaultCopies: atLeastOne(ceilDiv(stock, ppb)),
      });
      continue;
    }

    if (type === 'batch') {
      const all = unitBatchesFor(unit, opts.branchId, opts.mainBranchId).filter((b) => b.barcode);
      let list;
      if (opts.batchNo) {
        const want = normalizeCode(opts.batchNo);
        const hit = (b) => normalizeCode(b.batchNo) === want || normalizeCode(b.barcode) === want;
        list = all.filter(hit);
        // Lot not in this branch: still printable (copies default to 1).
        if (!list.length && opts.branchId) {
          list = unitBatchesFor(unit, null)
            .filter((b) => b.barcode && hit(b))
            .map((b) => ({ ...b, quantity: 0 }));
        }
        if (!list.length) {
          fail(`batch "${opts.batchNo}" not found`);
          continue;
        }
      } else {
        list = all.filter((b) => (Number(b.quantity) || 0) > 0);
        if (!list.length) {
          fail(all.length ? 'no batch has stock left' : 'no batches');
          continue;
        }
      }
      for (const b of list) {
        const qty = Number(b.quantity) || 0;
        const extra = [`Batch ${normalizeCode(b.batchNo)}`];
        const exp = formatDate(b.expiryDate);
        if (exp) extra.push(`Exp ${exp}`);
        entries.push({
          ...base,
          kind: 'batch',
          code: normalizeCode(b.barcode),
          batchNo: normalizeCode(b.batchNo),
          extra,
          defaultCopies: atLeastOne(ppb > 1 ? ceilDiv(qty, ppb) : qty),
        });
      }
      continue;
    }

    if (type === 'barcode') {
      const want = normalizeCode(opts.code);
      if (!want) throw badRequest('type=barcode needs a `code`');
      let qty = null;
      let extra = [];
      if (want === normalizeCode(unit.shortCode) || want === normalizeCode(unit.sku)) qty = 1;
      const bc = (unit.barcodes || []).find((b) => b && normalizeCode(b.code) === want);
      if (bc) {
        qty = Math.max(1, Number(bc.qty) || 1);
        if (isFullBoxCode(unit, want)) extra = [`Full box/pack · ${qty} pcs`];
        else if (qty > 1) extra = [`Pack of ${qty}`];
      }
      const batch = (unit.batches || []).find((b) => b && normalizeCode(b.barcode) === want);
      if (!qty && batch) {
        qty = 1;
        extra = [`Batch ${normalizeCode(batch.batchNo)}`];
        const exp = formatDate(batch.expiryDate);
        if (exp) extra.push(`Exp ${exp}`);
      }
      if (!qty) {
        fail(`code "${want}" does not belong to this item`);
        continue;
      }
      entries.push({
        ...base,
        kind: 'barcode',
        code: want,
        extra,
        price: base.price * qty,
        defaultCopies: atLeastOne(ceilDiv(stock, qty)),
      });
      continue;
    }
  }

  // Codes must be printable in Code 128 (ASCII 32..126).
  for (const e of entries) {
    try {
      code128.validate(e.code);
    } catch (err) {
      throw badRequest(`${e.name}: ${err.message}`);
    }
  }

  return { entries, skipped };
};

// Expand entries to individual labels, honouring `copies` and the 1000 cap.
const applyCopies = (entries, copiesOverride, state) => {
  const labels = [];
  for (const e of entries) {
    const want = copiesOverride !== undefined ? copiesOverride : e.defaultCopies;
    const room = MAX_LABELS - state.count;
    const n = Math.min(want, room);
    if (n < want) state.capped = true;
    if (n > 0) {
      labels.push({ ...e, copies: n });
      state.count += n;
    }
    if (state.count >= MAX_LABELS) {
      if (entries.indexOf(e) < entries.length - 1) state.capped = true;
      break;
    }
  }
  return labels;
};

// ---------- HTML rendering ----------

const svgCache = new Map();
const barcodeSvg = (code) => {
  let svg = svgCache.get(code);
  if (!svg) {
    svg = code128.toSVG(code, { height: 40, quietZone: 10 });
    if (svgCache.size > 2000) svgCache.clear();
    svgCache.set(code, svg);
  }
  return svg;
};

const codeFontPct = (code) => (code.length <= 6 ? 100 : code.length <= 9 ? 82 : code.length <= 13 ? 66 : 52);

const renderLabel = (item, ctx) => {
  const showRow = item.variant || ctx.showPrice;
  const parts = ['<div class="label">'];
  if (ctx.showShop && ctx.shopName) parts.push(`<div class="shop">${escapeHtml(truncate(ctx.shopName, 40))}</div>`);
  parts.push(`<div class="name">${escapeHtml(truncate(item.name, 90))}</div>`);
  if (showRow) {
    parts.push('<div class="row">');
    parts.push(`<span class="variant">${escapeHtml(truncate(item.variant, 40))}</span>`);
    if (ctx.showPrice) parts.push(`<span class="price">${escapeHtml(formatMoney(item.price, ctx.currency))}</span>`);
    parts.push('</div>');
  }
  if (item.extra && item.extra.length) {
    parts.push(`<div class="extra">${item.extra.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</div>`);
  }
  parts.push(`<div class="bc">${barcodeSvg(item.code)}</div>`);
  parts.push(`<div class="code" style="font-size:${codeFontPct(item.code)}%">${escapeHtml(item.code)}</div>`);
  parts.push('</div>');
  return parts.join('');
};

const buildCss = (size) => {
  const w = size.widthMm;
  const h = size.heightMm;
  // Text scale: 1 for 25 mm tall labels, bigger for taller labels.
  const s = Math.min(1.6, Math.max(1, h / 25)).toFixed(3);
  const common = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#000}
body{font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.label{--s:${s};width:${w}mm;height:${h}mm;overflow:hidden;padding:calc(0.9mm * var(--s)) 1.5mm;display:flex;flex-direction:column;background:#fff;line-height:1.12}
.shop{font-size:calc(1.85mm * var(--s));font-weight:600;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;flex:none}
.name{font-size:calc(2.45mm * var(--s));font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;flex:none;max-height:2.25em}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;flex:none}
.variant{font-size:calc(2.15mm * var(--s));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.price{font-size:calc(2.75mm * var(--s));font-weight:800;white-space:nowrap;flex:none}
.extra{display:flex;justify-content:space-between;gap:1mm;font-size:calc(1.95mm * var(--s));font-weight:600;white-space:nowrap;overflow:hidden;flex:none}
.extra span{overflow:hidden;text-overflow:ellipsis}
.bc{position:relative;flex:1 1 auto;min-height:4.5mm;margin-top:calc(0.5mm * var(--s))}
.bc svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono","Courier New",monospace;font-size:calc(3.6mm * var(--s));font-weight:800;letter-spacing:.08em;text-align:center;line-height:1.05;white-space:nowrap;overflow:hidden;flex:none}
.toolbar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#111827;color:#fff;font-size:14px}
.toolbar button{font:inherit;font-weight:600;padding:6px 16px;border:0;border-radius:6px;background:#dc2626;color:#fff;cursor:pointer}
.toolbar .tip{opacity:.75;font-size:12px}
.toolbar .warn{flex-basis:100%;color:#fde68a;font-size:12px}
.toolbar .warn li{margin-left:18px}
.toolbar .count{display:inline-flex;align-items:center;gap:6px;font-weight:600}
.toolbar .mode{background:#374151!important;padding:6px 12px!important}
.toolbar .mode.on{background:#facc15!important;color:#111827!important}
.toolbar .count input{width:72px;padding:4px 6px;border:0;border-radius:6px;font:inherit;font-weight:700;color:#111827;text-align:center}
@media print{.toolbar{display:none!important}}
`;
  const tinyCss = size.tiny
    ? `
.label{padding:0.4mm 0.8mm;line-height:1.05}
.label .shop,.label .extra,.label .row{display:none}
.label .name{font-size:1.75mm;-webkit-line-clamp:1;max-height:1.2em;white-space:nowrap;text-overflow:ellipsis;display:block;text-align:center}
.label .bc{min-height:5mm;margin-top:0.2mm}
.label .code{font-size:2.1mm;letter-spacing:.04em}
`
    : '';
  if (size.kind === 'sheet') {
    return `${common}${tinyCss}
@page{size:A4;margin:0}
.sheet{width:${size.pageWidthMm}mm;height:${size.pageHeightMm}mm;padding-top:0.5mm;display:grid;grid-template-columns:repeat(${size.cols},${w}mm);grid-auto-rows:${h}mm;align-content:start;overflow:hidden;break-after:page;page-break-after:always;background:#fff}
.sheet:last-child{break-after:auto;page-break-after:auto}
.sheet .label{padding:2.5mm 4mm}
@media screen{html,body{background:#e5e7eb;min-height:100%}.sheet{margin:16px auto;box-shadow:0 1px 6px rgba(0,0,0,.25)}.sheet .label{outline:1px dashed #cbd5e1;outline-offset:-1px}}
`;
  }
  return `${common}${tinyCss}
@page{size:${w}mm ${h}mm;margin:0}
@media print{html,body{width:${w}mm}.label{break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}}
@media screen{html,body{background:#e5e7eb;min-height:100%}.labels{display:flex;flex-wrap:wrap;gap:8px;padding:16px}.label{box-shadow:0 1px 4px rgba(0,0,0,.3)}}
`;
};

// ---------------------------------------------------------------- TSPL (direct label printing)
// Owner, 2026-10-31: stickers go straight to the thermal printer (Xprinter XP-246B, 203 dpi)
// through the DollarCoPos desktop app (127.0.0.1:47321), no Chrome print dialog.
// Built-in TSPL fonts at 203 dpi: "1" 8x12, "2" 12x20, "3" 16x24 dots. 8 dots = 1 mm.
const DOTS_PER_MM = 8;
const TSPL_FONTS = { 1: [8, 12], 2: [12, 20], 3: [16, 24] };
const tsplText = (v) =>
  String(v == null ? '' : v)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const wrapLine = (text, max, lines) => {
  const words = text.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) cur = next;
    else {
      if (cur) out.push(cur);
      cur = w.length > max ? w.slice(0, max) : w;
    }
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = `${out[lines - 1].slice(0, max - 1)}.`;
  return out.slice(0, lines);
};
/** Approximate Code 128 width in modules (TSPL picks subset C for digit runs). */
const code128Modules = (code) => {
  const digitsOnly = /^\d+$/.test(code) && code.length >= 4;
  const symbols = digitsOnly ? Math.ceil(code.length / 2) + (code.length % 2) : code.length;
  return 11 * (symbols + 2) + 13 + 20; // + quiet zones
};

/** 1 x 0.5 inch label (203 x 101 dots): one name line, barcode, code. */
const tsplTinyBody = (item, size) => {
  const W = Math.round(size.widthMm * DOTS_PER_MM);
  const H = Math.round(size.heightMm * DOTS_PER_MM);
  const cmds = [];
  const text = (x, yy, font, t) => cmds.push(`TEXT ${Math.max(0, Math.round(x))},${Math.round(yy)},"${font}",0,1,1,"${t}"`);
  const centre = (yy, font, t) => text((W - t.length * TSPL_FONTS[font][0]) / 2, yy, font, t);
  let y = 3;
  const name = (tsplText(item.name) || '-').slice(0, Math.floor((W - 8) / TSPL_FONTS[1][0]));
  centre(y, 1, name);
  y += TSPL_FONTS[1][1] + 2;
  const code = tsplText(item.code);
  const codeFont = code.length * TSPL_FONTS[2][0] <= W - 8 ? 2 : 1;
  const codeH = TSPL_FONTS[codeFont][1];
  const modules = code128Modules(code);
  const narrow = [2, 1].find((n) => (modules - 20) * n <= W - 8) || 1;
  const barH = Math.max(24, H - y - codeH - 6);
  const bx = Math.max(0, Math.round((W - (modules - 20) * narrow) / 2));
  cmds.push(`BARCODE ${bx},${y},"128",${barH},0,0,${narrow},${narrow},"${code}"`);
  centre(y + barH + 2, codeFont, code);
  return cmds.join('\r\n');
};

/** TSPL commands for ONE label body (between CLS and PRINT). */
const tsplLabelBody = (item, ctx, size) => {
  if (size.tiny) return tsplTinyBody(item, size);
  const W = size.widthMm * DOTS_PER_MM;
  const H = size.heightMm * DOTS_PER_MM;
  const big = size.heightMm >= 30;
  const side = 12;
  const cmds = [];
  let y = 8;
  const text = (x, yy, font, t) => cmds.push(`TEXT ${Math.max(0, Math.round(x))},${Math.round(yy)},"${font}",0,1,1,"${t}"`);
  const centre = (yy, font, t) => text((W - t.length * TSPL_FONTS[font][0]) / 2, yy, font, t);

  if (ctx.showShop && ctx.shopName) {
    const shop = tsplText(ctx.shopName).toUpperCase().slice(0, Math.floor((W - 2 * side) / 8));
    centre(y, 1, shop);
    y += 14;
  }
  const nameFont = big ? 3 : 2;
  const [nw, nh] = TSPL_FONTS[nameFont];
  const lines = wrapLine(tsplText(item.name) || '-', Math.floor((W - 2 * side) / nw), big ? 2 : 2);
  for (const l of lines) {
    centre(y, nameFont, l);
    y += nh + 2;
  }
  const variant = tsplText(item.variant || (item.extra || []).join(' '));
  const price = ctx.showPrice ? tsplText(formatMoney(item.price, ctx.currency)) : '';
  if (variant || price) {
    if (variant) text(side, y + 4, 1, variant.slice(0, Math.floor((W - 2 * side - price.length * 16 - 8) / 8)));
    if (price) text(W - side - price.length * 16, y, 3, price);
    y += 26;
  }
  const code = tsplText(item.code);
  const codeFont = code.length <= 10 ? 3 : 2;
  const codeH = TSPL_FONTS[codeFont][1];
  const modules = code128Modules(code);
  const narrow = [3, 2, 1].find((n) => modules * n <= W - 16) || 1;
  const barH = Math.max(32, H - y - codeH - 10);
  const bx = Math.max(0, Math.round((W - (modules - 20) * narrow) / 2));
  cmds.push(`BARCODE ${bx},${y + 2},"128",${barH},0,0,${narrow},${narrow},"${code}"`);
  centre(y + 4 + barH, codeFont, code);
  return cmds.join('\r\n');
};

/** TSPL job header for this sticker size (gap rolls). */
const tsplHeader = (size) =>
  [`SIZE ${size.widthMm} mm,${size.heightMm} mm`, `GAP ${size.gapMm || 2} mm,0 mm`, 'DIRECTION 1,0', 'REFERENCE 0,0', 'OFFSET 0 mm', 'SET TEAR ON', 'DENSITY 10', 'SPEED 4', 'CODEPAGE 1252'].join('\r\n');

/** Where the sticker page sends "printed N" (this API, as the browser reaches it). */
const logUrlOf = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/public/label-prints`;
};

const renderPage = ({ labels, size, ctx, title, skipped = [], capped = false, log = null }) => {
  const flat = [];
  for (const item of labels) {
    const html = renderLabel(item, ctx);
    for (let i = 0; i < item.copies; i++) flat.push(html);
  }
  const total = flat.length;

  let body;
  if (size.kind === 'sheet') {
    const per = size.cols * size.rows;
    const sheets = [];
    for (let i = 0; i < flat.length; i += per) sheets.push(`<div class="sheet">${flat.slice(i, i + per).join('')}</div>`);
    body = sheets.join('\n');
  } else {
    body = `<div class="labels">${flat.join('\n')}</div>`;
  }

  const pages = size.kind === 'sheet' ? Math.ceil(total / (size.cols * size.rows)) : total;
  const warnings = [];
  if (capped) warnings.push(`Only the first ${MAX_LABELS} labels are shown (limit per print).`);
  for (const s of skipped) warnings.push(`Skipped ${s}`);

  const tip =
    size.kind === 'sheet'
      ? 'In the print dialog choose paper A4, margins None, scale 100%.'
      : `In the print dialog choose your label printer, paper ${size.widthMm} x ${size.heightMm} mm, margins None, scale 100%.`;

  // One product sold in sets (e.g. 10 pcs · scan once): print one per piece or one per sale.
  const setPps = labels.length === 1 && labels[0].kind !== 'box' ? Math.max(1, Math.floor(Number(labels[0].pps) || 1)) : 1;
  const perSale = setPps > 1 ? Math.max(1, Math.ceil(total / setPps)) : total;
  const start = perSale;
  const modes =
    setPps > 1
      ? `<span class="modes"><button type="button" class="mode${start === total ? ' on' : ''}" data-n="${total}">All pieces (${total})</button> <button type="button" class="mode${start === perSale ? ' on' : ''}" data-n="${perSale}">By sale (${perSale}) · 1 per ${setPps} pcs</button></span>`
      : '';

  // Owner, 2026-10-31: choose how many of the stickers to print (the first N), total always shown.
  const toolbar = `<div class="toolbar">${modes}<label class="count">Print <input id="tag-count" type="number" min="1" max="${total}" value="${start}" inputmode="numeric" aria-label="How many to print"> of ${total}</label><button type="button" id="tag-print">Print</button><button type="button" id="tag-direct" hidden style="background:#16a34a">Print on label printer</button><span id="tag-direct-msg" class="tip"></span><strong id="tag-total">Total: ${total} label${total === 1 ? '' : 's'}</strong><span>${escapeHtml(size.label)}${size.kind === 'sheet' ? ` · ${pages} sheet${pages === 1 ? '' : 's'}` : ''}</span><span class="tip">${escapeHtml(tip)}</span>${
    warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''
  }</div>`;

  // Only the first N labels are shown / printed; the last one shown ends the run (no blank page).
  const logJs = log && log.ticket && log.url
    ? `window.__logPrint=function(n,via){try{var mode=${setPps > 1 ? `n===${perSale}?'sale':n===${total}?'piece':'custom'` : `n===${total}?'piece':'custom'`};fetch(${JSON.stringify(log.url).replace(/</g, '\\u003c')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:${JSON.stringify(log.ticket)},count:n,mode:mode,via:via}),keepalive:true}).catch(function(){});}catch(e){}};`
    : 'window.__logPrint=function(){};';
  const countScript = `<script>${logJs}(function(){var T=${total};var box=document.getElementById('tag-count');var tot=document.getElementById('tag-total');
function apply(){var n=parseInt(box.value,10);if(!(n>=1))n=T;if(n>T)n=T;var ls=document.querySelectorAll('.label');
for(var i=0;i<ls.length;i++){ls[i].style.display=i<n?'':'none';ls[i].style.breakAfter='';ls[i].style.pageBreakAfter='';}
if(ls[n-1]){ls[n-1].style.breakAfter='auto';ls[n-1].style.pageBreakAfter='auto';}
var sh=document.querySelectorAll('.sheet'),last=null;for(var j=0;j<sh.length;j++){var on=false,k=sh[j].querySelectorAll('.label');for(var x=0;x<k.length;x++)if(k[x].style.display!=='none'){on=true;break;}
sh[j].style.display=on?'':'none';sh[j].style.breakAfter='';sh[j].style.pageBreakAfter='';if(on)last=sh[j];}
if(last){last.style.breakAfter='auto';last.style.pageBreakAfter='auto';}
tot.textContent=n===T?'Total: '+T+' label'+(T===1?'':'s'):'Printing '+n+' of '+T+' labels';return n;}
var ms=document.querySelectorAll('.mode');function mark(){for(var m=0;m<ms.length;m++)ms[m].className='mode'+(String(ms[m].getAttribute('data-n'))===String(box.value)?' on':'');}
for(var m=0;m<ms.length;m++)ms[m].addEventListener('click',function(){box.value=this.getAttribute('data-n');apply();mark();});
box.addEventListener('input',function(){mark();});
box.addEventListener('input',apply);box.addEventListener('keydown',function(e){if(e.key==='Enter'){var n=apply();window.__logPrint(n,'browser');window.print();}});
document.getElementById('tag-print').addEventListener('click',function(){var n=apply();window.__logPrint(n,'browser');window.print();});
window.addEventListener('load',function(){apply();if(${ctx.autoPrint ? 'true' : 'false'}&&T===1){window.__logPrint(1,'browser');setTimeout(function(){window.print()},300);}else{box.focus();box.select();}});})();</script>`;
  // Direct printing through the DollarCoPos desktop app (thermal sizes only).
  const direct =
    size.kind === 'sheet'
      ? ''
      : (() => {
          const job = { size: `${size.widthMm} x ${size.heightMm} mm`, key: size.key, w: size.widthMm, h: size.heightMm, g: size.gapMm || 2, header: tsplHeader(size), labels: labels.map((it) => ({ body: tsplLabelBody(it, ctx, size), copies: it.copies })) };
          const json = JSON.stringify(job).replace(/</g, '\\u003c');
          return `<script>(function(){var JOB=${json};var AGENT='http://127.0.0.1:47321';var btn=document.getElementById('tag-direct');var msg=document.getElementById('tag-direct-msg');var box=document.getElementById('tag-count');var printer=null;
function count(){var n=parseInt(box.value,10);var T=0;for(var i=0;i<JOB.labels.length;i++)T+=JOB.labels[i].copies;if(!(n>=1))n=T;return Math.min(n,T);}
var KEY='dollarco.tspl.'+JOB.key;var D={w:JOB.w,h:JOB.h,g:JOB.g,x:0,y:0};var S={w:D.w,h:D.h,g:D.g,x:D.x,y:D.y};
try{var o=JSON.parse(window.localStorage.getItem(KEY)||'null');if(o)for(var k in S)if(typeof o[k]==='number'&&isFinite(o[k]))S[k]=o[k];}catch(e){}
function changed(){for(var k in D)if(S[k]!==D[k])return true;return false;}
function hdr(){if(!changed())return JOB.header;return ['SIZE '+S.w+' mm,'+S.h+' mm','GAP '+S.g+' mm,0 mm','DIRECTION 1,0','REFERENCE '+Math.max(0,Math.round(S.x*8))+',0','SHIFT '+Math.round(S.y*8),'OFFSET 0 mm','SET TEAR ON','DENSITY 10','SPEED 4','CODEPAGE 1252'].join('\\r\\n');}
function setupPanel(){var d=document.createElement('details');d.style.cssText='flex-basis:100%;font-size:13px';
var f=[['w','Label width'],['h','Label height'],['g','Gap between labels'],['x','Move right'],['y','Move up/down (minus = up)']];
var h='<summary style="cursor:pointer;color:#fde68a;font-weight:600">Printer setup: gap and label size (stickers cut or printing across two labels? fix it here)</summary><div style="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:end;margin-top:8px">';
for(var i=0;i<f.length;i++)h+='<label style="display:flex;flex-direction:column;gap:2px;font-size:12px">'+f[i][1]+' (mm)<input data-k="'+f[i][0]+'" type="number" step="0.5" min="-60" max="120" value="'+S[f[i][0]]+'" style="width:84px;padding:4px 6px;border:0;border-radius:6px;font:inherit;font-weight:700;color:#111827"></label>';
h+='<button type="button" data-a="save" style="background:#16a34a">Save</button><button type="button" data-a="reset" style="background:#374151">Reset</button><button type="button" data-a="detect" style="background:#2563eb">Find gaps (feeds a few labels)</button>';
h+='<span data-a="note" style="flex-basis:100%;opacity:.8;font-size:12px">Measure one empty label with a ruler. Saved on this computer for this sticker size. Then print 1 sticker to check.</span></div>';
d.innerHTML=h;var note=d.querySelector('[data-a=note]');
function read(){var ins=d.querySelectorAll('input[data-k]');for(var j=0;j<ins.length;j++){var v=parseFloat(ins[j].value);if(isFinite(v)&&(v>=0||ins[j].getAttribute('data-k')==='y'))S[ins[j].getAttribute('data-k')]=v;}}
d.querySelector('[data-a=save]').addEventListener('click',function(){read();try{window.localStorage.setItem(KEY,JSON.stringify(S));note.textContent='Saved: '+S.w+' x '+S.h+' mm, gap '+S.g+' mm. Print 1 sticker to check.';}catch(e){note.textContent='Using these settings now (could not save them on this computer).';}});
d.querySelector('[data-a=reset]').addEventListener('click',function(){for(var k in D)S[k]=D[k];try{window.localStorage.removeItem(KEY);}catch(e){}var ins=d.querySelectorAll('input[data-k]');for(var j=0;j<ins.length;j++)ins[j].value=S[ins[j].getAttribute('data-k')];note.textContent='Back to the normal settings.';});
d.querySelector('[data-a=detect]').addEventListener('click',function(){read();if(!printer){note.textContent='Open the DollarCoPos desktop app first.';return;}note.textContent='Finding the gaps...';
fetch(AGENT+'/print',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'SIZE '+S.w+' mm,'+S.h+' mm\\r\\nGAP '+S.g+' mm,0 mm\\r\\nGAPDETECT\\r\\n',printer:printer})}).then(function(r){return r.json();}).then(function(r){if(r&&r.ok){try{window.localStorage.setItem(GD,'1');}catch(e){}}note.textContent=r&&r.ok?'Done. The printer fed a few labels to find the gaps. Now print 1 sticker to check.':'Could not send: '+((r&&r.error)||'unknown error');}).catch(function(){note.textContent='Could not reach the DollarCoPos desktop app.';});});
document.querySelector('.toolbar').appendChild(d);}
var GD='dollarco.gapdetect.'+JOB.key;function needGap(){try{return !window.localStorage.getItem(GD);}catch(e){return false;}}
function tspl(n){var out=[hdr()],left=n;if(needGap())out.push('GAPDETECT');for(var i=0;i<JOB.labels.length&&left>0;i++){var k=Math.min(left,JOB.labels[i].copies);out.push('CLS',JOB.labels[i].body,'PRINT 1,'+k);left-=k;}return out.join('\\r\\n')+'\\r\\n';}
var ctl=window.AbortController?new AbortController():null;var t=setTimeout(function(){if(ctl)ctl.abort();},1500);
fetch(AGENT+'/status',ctl?{signal:ctl.signal}:{}).then(function(r){return r.json();}).then(function(s){clearTimeout(t);if(s&&s.ok&&s.printer){printer=s.printer;btn.hidden=false;btn.textContent='Print on '+s.printer;msg.textContent='Label printer ready: no print window needed.';setupPanel();}else if(s&&s.ok){msg.textContent='Desktop app found, but no label printer. Install the Xprinter driver.';}}).catch(function(){var help=document.createElement('span');help.style.cssText='flex-basis:100%;color:#fde68a;font-size:12px';help.innerHTML='Sticker printing too big or blank? Open the <b>DollarCoPos</b> desktop app (get it: <a href="https://pos-one-dollar-store-frontend.vercel.app/admin/desktop-app" target="_blank" style="color:#fff">Desktop app</a>) and use the green button. '+'Or in the print window: Paper size <b>' + JOB.size + '</b> (make it once in Printer preferences), Margins <b>None</b>, untick <b>Headers and footers</b>.';document.querySelector('.toolbar').appendChild(help);});
btn.addEventListener('click',function(){var n=count();btn.disabled=true;msg.textContent='Sending '+n+' label'+(n===1?'':'s')+'...';
fetch(AGENT+'/print',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:tspl(n),printer:printer})}).then(function(r){return r.json();}).then(function(r){if(r&&r.ok){window.__logPrint(n,'printer');try{window.localStorage.setItem(GD,'1');}catch(e){}}msg.textContent=r&&r.ok?'Sent '+n+' label'+(n===1?'':'s')+' to '+r.printer+'.':'Could not print: '+((r&&r.error)||'unknown error');}).catch(function(){msg.textContent='Could not reach the DollarCoPos desktop app. Open it and try again.';}).then(function(){btn.disabled=false;});});})();</script>`;
        })();
  // Auto print only for a single label: with more, the count is chosen first.
  const autoPrint = countScript + direct;

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
${autoPrint}
</body>
</html>`;
};

const sendError = (res, err, fallbackMsg) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(fallbackMsg, err);
  const payload = { message: status === 500 ? fallbackMsg : err.message };
  if (err.missing) payload.missing = err.missing;
  if (err.index !== undefined) payload.index = err.index;
  if (status === 500) payload.error = err.message;
  return res.status(status).json(payload);
};

const loadProduct = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw badRequest('Invalid product id');
  const product = await Product.findById(id);
  if (!product) throw notFound('Product not found');
  return product;
};

// ---------- handlers ----------

const labelController = {
  // GET /products/:id/label-data — everything a frontend needs to show a label picker.
  getLabelData: async (req, res) => {
    try {
      const product = await loadProduct(req.params.id);
      const ppb = Math.max(1, Math.floor(Number(product.piecesPerBox) || 1));
      const { shopName, currency } = await getShopSettings(req.query || {});
      const where = await labelBranch(req);

      const units = listUnits(product).map(({ key, variant, unit }) => {
        // the shop's stock
        const stock = unitBranchStock(unit, where.branchId, where.mainBranchId);
        const fb = ppb > 1 ? fullBoxEntry(unit) : null;
        return {
          variantId: key === PRODUCT_UNIT ? null : key,
          label: variant ? variantLabel(variant) || variant.sku || 'Variant' : '',
          shortCode: unit.shortCode ? normalizeCode(unit.shortCode) : null,
          sku: unit.sku || null,
          printCode: unitMainCode(unit) || null,
          price: sellPrice(unit),
          regularPrice: Number(unit.price) || 0,
          stock,
          barcodes: (unit.barcodes || []).map((b) => ({ code: b.code, qty: b.qty || 1, label: b.label || '' })),
          fullBoxCode: fb ? normalizeCode(fb.code) : null,
          batches: unitBatchesFor(unit, where.branchId, where.mainBranchId).map((b) => {
            const quantity = Number(b.quantity) || 0;
            return {
              batchNo: b.batchNo,
              barcode: b.barcode || null,
              quantity,
              expiryDate: b.expiryDate || null,
              suggestedCopies: atLeastOne(ppb > 1 ? ceilDiv(quantity, ppb) : quantity),
            };
          }),
          suggested: {
            // Sold in sets: a tag on every piece (stock is counted in sets).
            unit: atLeastOne(stock * (variant ? 1 : Math.max(1, Math.floor(Number(product.piecesPerSale) || 1)))),
            box: ppb > 1 ? atLeastOne(ceilDiv(stock, ppb)) : null,
            fullBox: fb ? atLeastOne(ceilDiv(stock, ppb)) : null,
          },
        };
      });

      return res.status(200).json({
        message: 'Label data fetched successfully',
        data: {
          product: {
            id: String(product._id),
            name: product.name,
            productType: product.productType || 'single',
            piecesPerBox: ppb,
          },
          shop: { name: shopName, currency },
          stockBranch: where.branchId, // branch the stock / suggested copies are for (null = all)
          units,
          types: TYPES,
          sizes: Object.values(SIZES).map((s) => ({
            key: s.key,
            label: s.label,
            widthMm: s.widthMm,
            heightMm: s.heightMm,
            kind: s.kind,
            perPage: s.kind === 'sheet' ? s.cols * s.rows : 1,
          })),
          defaultSize: DEFAULT_SIZE,
          maxLabels: MAX_LABELS,
        },
      });
    } catch (err) {
      return sendError(res, err, 'Error fetching label data');
    }
  },

  // GET /products/:id/labels?variantId=&type=&batchNo=&code=&copies=&size=&showPrice=&showShop=&currency=&autoPrint=
  printLabels: async (req, res) => {
    try {
      const q = req.query || {};
      const size = parseSize(q.size);
      const type = parseType(q.type);
      const copies = parseCopies(q.copies);
      const product = await loadProduct(req.params.id);
      const where = await labelBranch(req);

      const { entries, skipped } = buildEntries(product, {
        variantId: asString(q.variantId),
        type,
        batchNo: asString(q.batchNo),
        code: asString(q.code),
        branchId: where.branchId,
        mainBranchId: where.mainBranchId,
      });
      if (!entries.length) throw badRequest(skipped.length ? `Nothing to print. ${skipped.join('; ')}` : 'Nothing to print');

      const state = { count: 0, capped: false };
      const labels = applyCopies(entries, copies, state);
      const settings = await getShopSettings(q);
      const html = renderPage({
        labels,
        size,
        log: { ticket: labelPrintLog.makeTicket(req, labels, size.key), url: logUrlOf(req) },
        title: `Labels - ${product.name}`,
        skipped,
        capped: state.capped,
        ctx: {
          ...settings,
          showPrice: false, // the shop never prints prices on stickers
          showShop: parseBool(q.showShop, true),
          autoPrint: parseBool(q.autoPrint, false),
        },
      });
      res.set('Cache-Control', 'no-store');
      res.set('X-Label-Count', String(state.count));
      return res.status(200).type('html').send(html);
    } catch (err) {
      return sendError(res, err, 'Error printing labels');
    }
  },

  // POST /products/labels/print
  // body: { items: [{ productId, variantId?, type?, batchNo?, code?, copies? }], size?, showPrice?, showShop?, currency?, autoPrint? }
  printBulk: async (req, res) => {
    try {
      const body = req.body || {};
      const items = body.items;
      if (!Array.isArray(items) || !items.length) throw badRequest('items must be a non-empty array');
      if (items.length > MAX_BULK_ITEMS) throw badRequest(`Too many items (max ${MAX_BULK_ITEMS})`);
      const size = parseSize(body.size);

      const parsed = items.map((it, index) => {
        if (!it || typeof it !== 'object') throw badRequest(`items[${index}] must be an object`, { index });
        const productId = asString(it.productId);
        if (!productId || !mongoose.isValidObjectId(productId)) throw badRequest(`items[${index}].productId is invalid`, { index });
        try {
          return {
            productId,
            variantId: asString(it.variantId),
            type: parseType(it.type, `items[${index}].type`),
            batchNo: asString(it.batchNo),
            code: asString(it.code),
            copies: parseCopies(it.copies, `items[${index}].copies`),
          };
        } catch (e) {
          e.index = index;
          throw e;
        }
      });

      const ids = [...new Set(parsed.map((p) => p.productId))];
      const products = await Product.find({ _id: { $in: ids } });
      const byId = new Map(products.map((p) => [String(p._id), p]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw notFound(`Product not found: ${missing.join(', ')}`, { missing });

      const where = await labelBranch(req);
      const state = { count: 0, capped: false };
      const labels = [];
      const skipped = [];
      for (let index = 0; index < parsed.length; index++) {
        const p = parsed[index];
        let built;
        try {
          built = buildEntries(byId.get(p.productId), { ...p, branchId: where.branchId, mainBranchId: where.mainBranchId });
        } catch (e) {
          // One bad line (no batches, unknown variant...) should not block the
          // whole print run: list it in the page's warnings instead.
          if (e.status !== 400 && e.status !== 404) throw e;
          const name = byId.get(p.productId).name;
          skipped.push(`item ${index + 1}: ${e.message.startsWith(name) ? e.message : `${name}: ${e.message}`}`);
          continue;
        }
        skipped.push(...built.skipped);
        if (state.count >= MAX_LABELS) {
          if (built.entries.length) state.capped = true;
          continue;
        }
        labels.push(...applyCopies(built.entries, p.copies, state));
      }
      if (!labels.length) throw badRequest(skipped.length ? `Nothing to print. ${skipped.join('; ')}` : 'Nothing to print');

      const settings = await getShopSettings(body);
      const html = renderPage({
        labels,
        size,
        log: { ticket: labelPrintLog.makeTicket(req, labels, size.key), url: logUrlOf(req) },
        title: `Labels - ${parsed.length} item${parsed.length === 1 ? '' : 's'}`,
        skipped,
        capped: state.capped,
        ctx: {
          ...settings,
          showPrice: false, // the shop never prints prices on stickers
          showShop: parseBool(body.showShop, true),
          autoPrint: parseBool(body.autoPrint, false),
        },
      });
      res.set('Cache-Control', 'no-store');
      res.set('X-Label-Count', String(state.count));
      return res.status(200).type('html').send(html);
    } catch (err) {
      return sendError(res, err, 'Error printing labels');
    }
  },
};

// Exposed for tests / reuse.
labelController._internal = { buildEntries, applyCopies, renderPage, SIZES, MAX_LABELS };

module.exports = labelController;
