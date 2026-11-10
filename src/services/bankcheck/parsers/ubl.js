// UBL (United Bank Limited) account statement.
// Columns: DATE | PARTICULARS | INST. NO. | DEBIT | CREDIT | BALANCE.
// A row starts with a date "DD-Mon-YYYY" in the DATE column. The amount is taken
// from the running BALANCE (debit = previous balance - balance), which is safer
// than the DEBIT / CREDIT text.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
const NUM_RE = /^-?[\d,]+(\.\d+)?$/;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (s) => Number(String(s).replace(/,/g, ''));

function isoDate(s) {
  const m = DATE_RE.exec(String(s || '').trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

const BANK_WORDS = 'MEBL|EASYPAISA|HBL|BIPL|BAFL|JAZZCASH|UBL|MCB|ABL|NBP|ALFALAH|MEEZAN|SADAPAY|NAYAPAY|SCB|BAHL|JSBL|FAYSAL|ACCT:|ACCT|BANK:|\\(A\\/C';
const TO_RE = new RegExp(`(?:FT TO|TRANSFER TO|IBFT TO|TRF TO)\\s+(.+?)\\s+(?:${BANK_WORDS})`, 'i');
const TO_END_RE = /(?:FT TO|TRANSFER TO|IBFT TO|TRF TO)\s+(.+)$/i;
const FROM_RE = new RegExp(`(?:FT FROM|FUNDS TRANSFER, FR:?|TRANSFER FROM|IBFT FROM|TRF FROM)\\s+(.+?)\\s+(?:${BANK_WORDS})`, 'i');
const FROM_END_RE = /(?:FT FROM|FUNDS TRANSFER, FR:?|TRANSFER FROM|IBFT FROM|TRF FROM)\s+(.+)$/i;
const CHARGE_RE = /\b(CHARGES?|FED|EXCISE|WITHHOLDING|W\.?H\.?T|SMS ALERT|ANNUAL FEE|SERVICE FEE|ZAKAT)\b/i;

const cleanName = (s) =>
  String(s || '')
    .replace(/[\d*]+/g, ' ')
    .replace(/\s-\s?/g, ' ')
    .replace(/[-:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// What a row is, from its words.
function classify(text, direction) {
  const t = text.toUpperCase();
  if (direction === 'in') {
    if (t.includes('DOLLARANDCO') || t.includes('105827100029340')) return { kind: 'card', payee: 'Card machine' };
    if (/^CASH\b|CASH DEPOSIT/.test(t)) return { kind: 'cash', payee: 'Cash deposit' };
    const m = FROM_RE.exec(text) || FROM_END_RE.exec(text);
    if (m) return { kind: 'transfer_in', payee: cleanName(m[1]) };
    return { kind: 'other_in', payee: cleanName(text).slice(0, 40) };
  }
  const m = TO_RE.exec(text) || TO_END_RE.exec(text);
  if (m) return { kind: 'transfer_out', payee: cleanName(m[1]) };
  if (CHARGE_RE.test(t)) return { kind: 'charge', payee: 'Bank charges' };
  if (/CHEQUE|CHQ|CLEARING/.test(t)) return { kind: 'cheque', payee: cleanName(text).slice(0, 40) };
  if (/^CASH\b|CASH WITHDRAW|ATM/.test(t)) return { kind: 'cash_out', payee: 'Cash withdrawal' };
  return { kind: 'other_out', payee: cleanName(text).slice(0, 40) };
}

const HEADERS = ['DATE', 'PARTICULARS', 'INST. NO.', 'DEBIT', 'CREDIT', 'BALANCE'];

function findHeader(page) {
  const found = {};
  for (const it of page.items) {
    const s = it.str.toUpperCase();
    if (HEADERS.includes(s) && !found[s]) found[s] = it;
  }
  if (HEADERS.every((h) => found[h])) {
    return {
      y: found.DATE.y,
      date: found.DATE.x,
      part: found.PARTICULARS.x,
      inst: found['INST. NO.'].x,
      debit: found.DEBIT.x,
      credit: found.CREDIT.x,
      balance: found.BALANCE.x,
    };
  }
  return null;
}

function detect(pages) {
  if (!pages.length) return false;
  const text = pages[0].items.map((i) => i.str).join(' ');
  return /ubl|united bank/i.test(text) && !!pages.slice(0, 2).map(findHeader).find(Boolean);
}

function parse(pages) {
  const first = pages[0].items.map((i) => i.str).join(' ');
  const acc = /Account Number:?\s*([\d-]{6,})/i.exec(first);
  const per = /(\d{1,2}-[A-Za-z]{3}-\d{4})\s*-\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(first);

  const raw = [];
  let cols = null;
  for (const page of pages) {
    const head = findHeader(page);
    if (head) cols = head;
    if (!cols) continue;
    const top = head ? head.y - 2 : page.height; // rows sit below the header
    // Footer ("For latest schedule of charges ...") and anything under it is not a row.
    const foot = page.items.filter((i) => /^For latest schedule/i.test(i.str)).map((i) => i.y);
    const bottom = foot.length ? Math.max(...foot) + 6 : 0;
    const items = page.items.filter((i) => i.y < top && i.y > bottom);
    const dates = items
      .filter((i) => i.x < cols.part - 2 && isoDate(i.str))
      .sort((a, b) => b.y - a.y);
    dates.forEach((d, k) => {
      const next = dates[k + 1];
      const lo = next ? next.y + 2 : bottom;
      const inRow = items.filter((i) => i.y <= d.y + 1 && i.y > lo);
      const byLine = (a, b) => b.y - a.y || a.x - b.x;
      const inCol = (a, b) => inRow.filter((i) => i.x >= a - 3 && i.x < b - 3).sort(byLine);
      const parts = inCol(cols.part, cols.inst).concat(inCol(cols.inst, cols.debit).filter((i) => !NUM_RE.test(i.str)));
      const nums = (a, b) => inCol(a, b).filter((i) => NUM_RE.test(i.str));
      const bal = nums(cols.balance, Infinity)[0];
      const minY = Math.min(...inRow.map((i) => i.y));
      const maxH = Math.max(...inRow.map((i) => i.h || 8));
      raw.push({
        page: page.index,
        date: isoDate(d.str),
        particulars: parts
          .map((i) => i.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
        debitText: nums(cols.debit, cols.credit)[0],
        creditText: nums(cols.credit, cols.balance)[0],
        balance: bal ? num(bal.str) : null,
        // Box around the row in PDF points (bottom-left origin).
        rect: { x0: cols.date - 3, x1: page.width - 30, y0: minY - 4, y1: d.y + maxH + 2 },
        labelX: cols.inst - 2,
        labelW: Math.max(40, cols.debit - cols.inst - 2),
      });
    });
  }
  if (!cols) return null;

  const rows = [];
  let prev = null;
  raw.forEach((r, i) => {
    if (r.balance === null || Number.isNaN(r.balance)) return;
    if (/opening balance/i.test(r.particulars)) {
      prev = r.balance;
      return;
    }
    const debit = r.debitText ? num(r.debitText.str) : 0;
    const credit = r.creditText ? num(r.creditText.str) : 0;
    let diff;
    if (prev === null) diff = credit - debit; // no opening row: trust the columns once
    else diff = round2(r.balance - prev);
    prev = r.balance;
    if (Math.abs(diff) < 0.005) return;
    const direction = diff < 0 ? 'out' : 'in';
    const amount = round2(Math.abs(diff));
    const { kind, payee } = classify(r.particulars, direction);
    rows.push({
      seq: i,
      page: r.page,
      date: r.date,
      particulars: r.particulars,
      payee,
      kind,
      direction,
      amount,
      balance: round2(r.balance),
      rect: r.rect,
      labelX: r.labelX,
      labelW: r.labelW,
    });
  });

  return {
    bankCode: 'UBL',
    accountNumber: acc ? acc[1] : '',
    periodFrom: per ? isoDate(per[1]) : rows[0] && rows[0].date,
    periodTo: per ? isoDate(per[2]) : rows.length ? rows[rows.length - 1].date : null,
    rows,
  };
}

module.exports = { code: 'UBL', detect, parse, isoDate };
