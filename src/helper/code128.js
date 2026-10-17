// code128.js — Code 128 barcode encoder that outputs inline SVG (no dependencies).
//
// Supports:
//   Code Set B — printable ASCII 32..126 (letters, digits, "-", "/", ...)
//   Code Set C — pairs of digits. Used automatically for digit runs where it
//                makes the barcode shorter (e.g. a whole even-length number
//                like "102455", or a long run of digits inside a code).
//
// API:
//   encodeValues(text) -> [startSymbol, ...data symbols, checksum, STOP]
//   encode(text)       -> module widths, alternating bar/space, starting with a
//                         bar, without quiet zones (sum = 11*n + 13).
//   toSVG(text, { height, moduleWidth, quietZone, includeText, fontSize, width, svgHeight, color })
//                      -> SVG string. Scales to its container (width="100%")
//                         with preserveAspectRatio="none" so bars stretch to fill.
//
// Any character outside ASCII 32..126 throws an Error with status 400 and
// code 'BARCODE_UNSUPPORTED_CHAR'. Use sanitize(text) to strip them instead.

// Bar/space widths of the 107 symbols (values 0..105) plus STOP (106).
// Each symbol is 3 bars + 3 spaces = 11 modules; STOP has 4 bars + 3 spaces = 13 modules.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', // 0-9
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', // 10-19
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', // 20-29
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', // 30-39
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', // 40-49
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', // 50-59
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', // 60-69
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', // 70-79
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', // 80-89
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', // 90-99
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112', // 100-106
];

const START_A = 103;
const START_B = 104;
const START_C = 105;
const CODE_C = 99; // switch to set C (valid in sets A/B)
const CODE_B = 100; // switch to set B (valid in sets A/C)
const STOP = 106;

const isDigit = (ch) => ch >= '0' && ch <= '9';

const unsupportedError = (text, bad) => {
  const shown = bad
    .map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
    .join(' ');
  const err = new Error(`Barcode text "${text}" has characters Code 128 cannot print: ${shown}. Only plain ASCII letters, digits and symbols are allowed.`);
  err.status = 400;
  err.code = 'BARCODE_UNSUPPORTED_CHAR';
  return err;
};

// Remove anything outside printable ASCII (32..126).
const sanitize = (text) => String(text ?? '').replace(/[^\x20-\x7E]/g, '');

const validate = (text) => {
  if (text === undefined || text === null || String(text) === '') {
    const err = new Error('Barcode text is empty');
    err.status = 400;
    err.code = 'BARCODE_EMPTY';
    throw err;
  }
  const s = String(text);
  const bad = [...new Set([...s].filter((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126))];
  if (bad.length) throw unsupportedError(s, bad);
  if (s.length > 80) {
    const err = new Error(`Barcode text is too long (${s.length} chars, max 80)`);
    err.status = 400;
    err.code = 'BARCODE_TOO_LONG';
    throw err;
  }
  return s;
};

const digitRunAt = (s, i) => {
  let j = i;
  while (j < s.length && isDigit(s[j])) j++;
  return j - i;
};

/**
 * Symbol values for `text`: start, data (with set switches), checksum, stop.
 * Set choice (shortest common heuristic):
 *   - start in C if the text starts with >= 4 digits (or is exactly 2 digits);
 *     with an odd leading run the leftover digit is written in B after the pairs.
 *   - inside B, switch to C for a run of >= 6 digits, or >= 4 digits that reach
 *     the end of the text. Odd runs keep their first digit in B.
 */
const encodeValues = (text) => {
  const s = validate(text);
  const values = [];
  let set;
  let i = 0;

  const lead = digitRunAt(s, 0);
  if ((lead >= 4) || (lead === 2 && s.length === 2)) {
    set = 'C';
    values.push(START_C);
  } else {
    set = 'B';
    values.push(START_B);
  }

  while (i < s.length) {
    if (set === 'C') {
      if (i + 1 < s.length && isDigit(s[i]) && isDigit(s[i + 1])) {
        values.push(Number(s.substr(i, 2)));
        i += 2;
      } else {
        values.push(CODE_B);
        set = 'B';
      }
      continue;
    }
    // set B
    const run = digitRunAt(s, i);
    const reachesEnd = i + run === s.length;
    if (run >= 6 || (run >= 4 && reachesEnd)) {
      if (run % 2 === 1) {
        values.push(s.charCodeAt(i) - 32);
        i += 1;
      }
      values.push(CODE_C);
      set = 'C';
      continue;
    }
    values.push(s.charCodeAt(i) - 32);
    i += 1;
  }

  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  values.push(sum % 103);
  values.push(STOP);
  return values;
};

// Module widths (bar, space, bar, ...) without quiet zones.
const encode = (text) => {
  const widths = [];
  for (const v of encodeValues(text)) {
    for (const ch of PATTERNS[v]) widths.push(Number(ch));
  }
  return widths;
};

const escapeXml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * SVG for `text`.
 * options:
 *   height      bar height in viewBox units (default 50; 1 unit = 1 module wide)
 *   moduleWidth viewBox units per module (default 1)
 *   quietZone   modules of white space on each side (default 10, spec minimum)
 *   includeText print the text under the bars (default false)
 *   fontSize    text size in viewBox units (default 10)
 *   width       SVG width attribute (default '100%')
 *   svgHeight   SVG height attribute (default '100%')
 *   color       bar color (default '#000')
 *   background  background fill or null (default '#fff')
 */
const toSVG = (text, options = {}) => {
  const {
    height = 50,
    moduleWidth = 1,
    quietZone = 10,
    includeText = false,
    fontSize = 10,
    width = '100%',
    svgHeight = '100%',
    color = '#000',
    background = '#fff',
  } = options;

  const widths = encode(text);
  const totalModules = widths.reduce((a, b) => a + b, 0) + quietZone * 2;
  const vbW = totalModules * moduleWidth;
  const textGap = includeText ? fontSize * 1.3 : 0;
  const vbH = height + textGap;

  // One path for all bars keeps the markup small.
  let x = quietZone * moduleWidth;
  let d = '';
  for (let k = 0; k < widths.length; k++) {
    const w = widths[k] * moduleWidth;
    if (k % 2 === 0) d += `M${x} 0h${w}v${height}h-${w}z`;
    x += w;
  }

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${escapeXml(width)}" height="${escapeXml(svgHeight)}" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${escapeXml(text)}">`,
  ];
  if (background) parts.push(`<rect width="${vbW}" height="${vbH}" fill="${escapeXml(background)}"/>`);
  parts.push(`<path d="${d}" fill="${escapeXml(color)}"/>`);
  if (includeText) {
    parts.push(
      `<text x="${vbW / 2}" y="${height + fontSize * 1.1}" font-family="monospace" font-size="${fontSize}" text-anchor="middle" fill="${escapeXml(color)}">${escapeXml(text)}</text>`
    );
  }
  parts.push('</svg>');
  return parts.join('');
};

// Total width in modules including quiet zones (useful to pick a module size).
const moduleCount = (text, quietZone = 10) => encode(text).reduce((a, b) => a + b, 0) + quietZone * 2;

module.exports = {
  PATTERNS,
  START_A,
  START_B,
  START_C,
  CODE_B,
  CODE_C,
  STOP,
  sanitize,
  validate,
  encodeValues,
  encode,
  toSVG,
  moduleCount,
};
