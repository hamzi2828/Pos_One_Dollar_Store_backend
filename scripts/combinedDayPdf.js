// PDF of Cash Closing -> Combined -> day (all counters together), same figures as
// /admin/reports/cash-closing/combined/day. Read-only.
//
//   node scripts/combinedDayPdf.js --day 2026-11-11 --ids 6af3fd10d2b56d856ca03e69,6af36bac22dd5055612a5c77
//   [--out <file.pdf>]  default: ../reports/cash-closing-<day>.pdf
// Needs Google Chrome (headless print to PDF).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `Rs ${r2(n).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pk = (d, opts) => new Date(d).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', ...opts });
const time = (d) => pk(d, { hour: 'numeric', minute: '2-digit' });
const dateTime = (d) => pk(d, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const arg = (a, n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);

function diff(entered, system) {
  if (entered == null || system == null) return '<span class="muted">—</span>';
  const d = r2(entered - system);
  if (Math.abs(d) < 1) return '<span class="ok">OK</span>';
  return `<span class="${d < 0 ? 'short' : 'over'}">${d < 0 ? 'Short' : 'Over'} ${rs(Math.abs(d))}</span>`;
}

function countTable(count) {
  const den = Object.entries((count && count.denominations) || {})
    .filter(([, c]) => Number(c) > 0)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
  if (!den.length) return '';
  return `<table class="notes"><tr>${den.map(([v]) => `<th>${Number(v).toLocaleString()}</th>`).join('')}</tr><tr>${den
    .map(([, c]) => `<td>× ${c}</td>`)
    .join('')}</tr><tr>${den.map(([v, c]) => `<td>${rs(Number(v) * Number(c))}</td>`).join('')}</tr></table>`;
}

async function load(ids) {
  const mongoose = require('mongoose');
  const till = require('../src/services/tillService');
  const CashSession = require('../src/models/cashSession');
  const db = mongoose.connection.db;
  const out = [];
  for (const id of ids) {
    let s = await CashSession.findById(id).lean();
    if (!s) throw new Error(`Till ${id} not found`);
    s = await till.refreshExpenses(s);
    const live = await till.computeExpected(s, s.status === 'open' ? new Date() : s.closedAt);
    const billIds = live.bills.map((b) => b._id);
    const disc = billIds.length
      ? await db.collection('posorders').find({ _id: { $in: billIds }, discount: { $gt: 0 } }).project({ discount: 1 }).toArray()
      : [];
    out.push({ ...s, nonCash: live.nonCash, liveExpected: live.expected, expenses: live.expenses || [], discounts: disc });
  }
  return out.sort((a, b) => (a.counterName || '').localeCompare(b.counterName || '') || new Date(a.openedAt) - new Date(b.openedAt));
}

function figures(t) {
  const e = t.expected || t.liveExpected || null;
  const drawer = t.drawerCount ?? (t.dayCash ? null : t.closingCount);
  return {
    float: (t.openingFloat && t.openingFloat.total) ?? (e && e.float) ?? 0,
    drawer: drawer ? drawer.total : null,
    sysCash: e ? r2(e.cashSales + e.cashReceivedOnCredit - e.cashRefunds) : 0,
    sysCard: (t.nonCash && t.nonCash.card) ?? (e && e.card) ?? 0,
    sysBank: (t.nonCash && t.nonCash.bank_transfer) ?? (e && e.bankTransfer) ?? 0,
    sysJazz: (t.nonCash && t.nonCash.jazzcash) ?? (e && e.jazzcash) ?? 0,
    expenses: (e && e.expenses) || 0,
    cash: t.dayCash ? t.dayCash.total : null,
    card: t.cardTotal ?? null,
    bank: t.bankTransferTotal ?? null,
    jazz: t.jazzcashTotal ?? null,
    discounts: (t.discounts || []).reduce((s, d) => s + d.discount, 0),
    cashSales: (e && e.cashSales) || 0,
    credit: (e && e.cashReceivedOnCredit) || 0,
    refunds: (e && e.cashRefunds) || 0,
  };
}

function rowFigures(f) {
  const given = f.cash == null && f.card == null && f.bank == null && f.jazz == null ? null : (f.cash || 0) + (f.card || 0) + (f.bank || 0) + (f.jazz || 0);
  const should = r2(f.sysCash + f.sysCard + f.sysBank + f.sysJazz - f.expenses);
  return {
    given,
    should,
    salesDiff: given == null ? null : r2(given - should),
    changeDiff: f.drawer == null ? null : r2(f.drawer - f.float),
    totalDiff: given == null ? null : r2(given + (f.drawer ?? f.float) - (should + f.float)),
  };
}

function html(day, tills) {
  const figs = tills.map(figures);
  const add = (k) => r2(figs.reduce((t, f) => t + (f[k] || 0), 0));
  const anyGiven = (k) => figs.some((f) => f[k] != null);
  const expensesAmt = add('expenses');
  const discountAmt = add('discounts');
  const rows = [
    { label: 'Cash', entered: anyGiven('cash') ? add('cash') : null, system: add('sysCash'), target: r2(add('sysCash') - expensesAmt), hint: expensesAmt ? 'after expenses' : '' },
    { label: 'POS machine (card)', entered: anyGiven('card') ? add('card') : null, system: add('sysCard') },
    { label: 'Bank (UBL)', entered: anyGiven('bank') ? add('bank') : null, system: add('sysBank') },
    { label: 'JazzCash', entered: anyGiven('jazz') ? add('jazz') : null, system: add('sysJazz') },
  ];
  const sum = (k) => r2(rows.reduce((t, r) => t + (r[k] || 0), 0));
  const anyEntered = rows.some((r) => r.entered != null);
  const shouldGive = r2(sum('system') - expensesAmt);
  const floatAmt = add('float');
  const drawerAmt = r2(figs.reduce((t, f) => t + (f.drawer ?? f.float), 0));
  const anyDrawer = figs.some((f) => f.drawer != null);
  const tillRows = figs.map(rowFigures);
  const sumOf = (vals) => (vals.some((v) => v != null) ? r2(vals.reduce((t, v) => t + (v || 0), 0)) : null);
  const foot = {
    should: r2(tillRows.reduce((t, r) => t + r.should, 0)),
    salesDiff: sumOf(tillRows.map((r) => r.salesDiff)),
    changeDiff: sumOf(tillRows.map((r) => r.changeDiff)),
    totalDiff: sumOf(tillRows.map((r) => r.totalDiff)),
    left: r2(figs.reduce((t, f) => t + (f.drawer ?? 0), 0)),
    leftFloat: r2(figs.reduce((t, f) => t + (f.drawer != null ? f.float : 0), 0)),
  };
  const money = (v) => (v != null ? rs(v) : '—');
  const notes = { denominations: {}, total: 0 };
  for (const t of tills) {
    if (!t.dayCash) continue;
    notes.total += t.dayCash.total;
    for (const [v, c] of Object.entries(t.dayCash.denominations || {})) notes.denominations[v] = (notes.denominations[v] || 0) + Number(c);
  }
  const seen = new Set();
  const expenses = tills.flatMap((t) =>
    (t.expenses || []).filter((x) => !seen.has(String(x._id)) && seen.add(String(x._id))).map((x) => ({ ...x, tillCounter: t.counterName || '' }))
  );
  const dayTitle = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const tillTr = tills
    .map((t, i) => {
      const f = figs[i];
      const { given, should } = tillRows[i];
      return `<tr>
        <td><b>${esc(t.sessionNo)}</b> <span class="badge">${esc(t.status)}</span><div class="small">${esc(t.counterName || 'No counter')} · ${esc(t.cashierName)}</div></td>
        <td class="small">${dateTime(t.openedAt)}${t.closedAt ? ` → ${time(t.closedAt)}` : ''}</td>
        <td class="n">${money(f.cash)}</td><td class="n">${money(f.card)}</td><td class="n">${money(f.bank)}</td><td class="n">${money(f.jazz)}</td>
        <td class="n">${f.expenses ? `−${rs(f.expenses)}` : '—'}</td><td class="n">${rs(should)}</td>
        <td class="n">${diff(given, should)}</td>
        <td class="n">${f.drawer != null ? `<div class="small">${rs(f.drawer)} left · float ${rs(f.float)}</div>` : ''}${diff(f.drawer, f.float)}</td>
        <td class="n">${diff(given == null ? null : r2(given + (f.drawer ?? f.float)), r2(should + f.float))}</td></tr>`;
    })
    .join('');

  const salesTr = rows
    .map(
      (r) => `<tr><td>${r.label}</td><td class="n">${money(r.entered)}</td><td class="n muted2">${rs(r.system)}</td>
        <td class="n">${diff(r.entered, r.target !== undefined ? r.target : r.system)}${r.hint && r.entered != null ? `<div class="tiny">${r.hint}</div>` : ''}</td></tr>${
        r.label === 'Cash' && notes.total > 0
          ? `<tr><td colspan="4" class="notesbox"><div class="lbl">Cash notes · all counters · ${rs(notes.total)}</div>${countTable(notes)}${tills
              .filter((t) => t.dayCash && Object.keys(t.dayCash.denominations || {}).length)
              .map((t) => `<div class="lbl sub">${esc(t.counterName || 'No counter')} · ${esc(t.cashierName)} · ${rs(t.dayCash.total)}</div>${countTable(t.dayCash)}`)
              .join('')}</td></tr>`
          : ''
      }`
    )
    .join('');

  const expTr = expenses
    .map(
      (x) => `<tr class="${x.shopUse ? 'muted' : ''}"><td class="ind">${esc(x.title)}${x.counterName ? ` <span class="tag">${esc(x.counterName)}</span>` : ''}
        <span class="tiny">${time(x.createdAt)}${x.tillCounter ? ` · off ${esc(x.tillCounter)} till` : ''}${x.paymentMethod && x.paymentMethod !== 'Cash' ? ` · ${esc(x.paymentMethod)}` : ''}</span></td>
        <td></td><td class="n">${x.shopUse ? '—' : `−${rs(x.amount)}`}</td><td></td></tr>`
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Cash closing ${day}</title><style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: Segoe UI, Arial, sans-serif; color: #111827; font-size: 11px; }
  h1 { font-size: 18px; margin: 0; } .sub0 { color: #6b7280; margin: 2px 0 12px; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
  .keep { page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 9px; text-transform: uppercase; color: #6b7280; background: #f9fafb; padding: 5px 6px; }
  td { padding: 5px 6px; border-top: 1px solid #f3f4f6; vertical-align: top; } .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th.n { text-align: right; } tfoot td { font-weight: 700; background: #f9fafb; border-top: 2px solid #d1d5db; }
  .small { font-size: 9.5px; color: #6b7280; } .tiny { font-size: 9px; color: #9ca3af; } .muted, .muted2 { color: #6b7280; }
  .ok { color: #16a34a; font-weight: 600; } .short { color: #dc2626; font-weight: 600; } .over { color: #b45309; font-weight: 600; }
  .badge { font-size: 9px; background: #eef2ff; color: #3730a3; border-radius: 4px; padding: 1px 4px; } .tag { font-size: 9px; background: #f3f4f6; border-radius: 4px; padding: 0 4px; }
  .lbl { font-size: 9px; font-weight: 600; text-transform: uppercase; color: #6b7280; margin: 4px 0 2px; } .lbl.sub { color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 4px; }
  .notesbox { background: #f9fafb; } table.notes { width: auto; } table.notes th, table.notes td { text-align: right; padding: 1px 8px; border: 0; background: none; font-size: 9.5px; }
  .ind { padding-left: 14px; } .total td { font-weight: 700; } .rest td { font-weight: 700; background: #f9fafb; border-top: 1px solid #d1d5db; }
  .grand td { font-weight: 700; background: #fef9c3; border-top: 2px solid #d1d5db; } .sec td { font-size: 9px; font-weight: 600; text-transform: uppercase; color: #6b7280; padding-top: 10px; }
  </style></head><body>
  <h1>${dayTitle} — all counters together</h1>
  <p class="sub0">${tills.map((t) => esc(t.counterName || 'No counter')).join(' + ')} · printed ${dateTime(new Date())}</p>
  <div class="card keep"><table><thead><tr><th>Till</th><th>Opened → closed</th><th class="n">Cash gave</th><th class="n">Card</th><th class="n">Bank (UBL)</th><th class="n">JazzCash</th>
    <th class="n">Expenses</th><th class="n">Should hand over</th><th class="n">Sales over / short</th><th class="n">Change money</th><th class="n">Total over / short</th></tr></thead>
    <tbody>${tillTr}</tbody>
    <tfoot><tr><td colspan="2">All counters<div class="small">${tills.length} tills added up</div></td>
      <td class="n">${anyGiven('cash') ? rs(add('cash')) : '—'}</td><td class="n">${anyGiven('card') ? rs(add('card')) : '—'}</td>
      <td class="n">${anyGiven('bank') ? rs(add('bank')) : '—'}</td><td class="n">${anyGiven('jazz') ? rs(add('jazz')) : '—'}</td>
      <td class="n">${expensesAmt ? `−${rs(expensesAmt)}` : '—'}</td><td class="n">${money(foot.should)}</td>
      <td class="n">${diff(foot.salesDiff, foot.salesDiff == null ? null : 0)}</td>
      <td class="n">${foot.changeDiff != null ? `<div class="small">${rs(foot.left)} left · float ${rs(foot.leftFloat)}</div>` : ''}${diff(foot.changeDiff, foot.changeDiff == null ? null : 0)}</td>
      <td class="n">${diff(foot.totalDiff, foot.totalDiff == null ? null : 0)}</td></tr></tfoot></table></div>

  <div class="card"><div class="lbl">Sales of the day · all counters</div>
  <table><thead><tr><th></th><th class="n">Cashiers gave</th><th class="n">Sales were</th><th class="n"></th></tr></thead>
  <tbody>${salesTr}</tbody>
  <tbody>
    ${discountAmt > 0 ? `<tr><td class="muted">Sales at full price</td><td></td><td class="n muted">${rs(sum('system') + discountAmt)}</td><td></td></tr>
      <tr><td class="muted">− Discounts (${tills.reduce((t, x) => t + x.discounts.length, 0)})</td><td></td><td class="n short">−${rs(discountAmt)}</td><td></td></tr>` : ''}
    <tr class="total"><td>= Total sales</td><td class="n">${anyEntered ? rs(sum('entered')) : '—'}</td><td class="n">${rs(sum('system'))}</td><td></td></tr>
    ${expenses.length ? `<tr class="sec"><td colspan="4">− Expenses, payments &amp; trip costs (${expenses.filter((x) => !x.shopUse).length})</td></tr>${expTr}
      <tr class="total"><td class="ind">Total paid out</td><td></td><td class="n short">−${rs(expensesAmt)}</td><td></td></tr>` : ''}
    <tr class="rest"><td>= Rest (to hand over)</td><td class="n">${anyEntered ? rs(sum('entered')) : '—'}</td><td class="n">${rs(shouldGive)}</td><td class="n">${anyEntered ? diff(sum('entered'), shouldGive) : '—'}</td></tr>
    <tr><td>Change money (left in drawers vs opening float)<div class="tiny">kept apart from sales, like on each till page</div></td>
      <td class="n">${anyDrawer ? rs(drawerAmt) : '—'}</td><td class="n muted2">${rs(floatAmt)}</td><td class="n">${anyDrawer ? diff(drawerAmt, floatAmt) : '—'}</td></tr>
    <tr class="grand"><td>= Total over / short<div class="tiny">sales + change money (same as the Cash Closing list)</div></td>
      <td class="n">${anyEntered ? rs(r2(sum('entered') + drawerAmt)) : '—'}</td><td class="n">${rs(r2(shouldGive + floatAmt))}</td>
      <td class="n">${anyEntered ? diff(r2(sum('entered') + drawerAmt), r2(shouldGive + floatAmt)) : '—'}</td></tr>
  </tbody></table>
  <p class="small">Cash should be = cash sales ${rs(add('cashSales'))}${add('credit') > 0 ? ` + credit received ${rs(add('credit'))}` : ''}${
    add('refunds') > 0 ? ` − refunds ${rs(add('refunds'))}` : ''
  }${expensesAmt > 0 ? ` − expenses, payments &amp; trip costs ${rs(expensesAmt)}` : ''}</p></div>
  </body></html>`;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const args = process.argv.slice(2);
  const day = String(arg(args, '--day') || '');
  const ids = String(arg(args, '--ids') || '').split(',').filter((x) => /^[a-f0-9]{24}$/i.test(x));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !ids.length) throw new Error('Usage: --day YYYY-MM-DD --ids <till id>,<till id> [--out file.pdf]');
  const out = path.resolve(arg(args, '--out') || path.join(__dirname, '..', '..', 'reports', `cash-closing-${day}.pdf`));
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  let page;
  try {
    page = html(day, await load(ids));
  } finally {
    await mongoose.disconnect();
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const htmlFile = out.replace(/\.pdf$/i, '.html');
  fs.writeFileSync(htmlFile, page);
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file:///${htmlFile.replace(/\\/g, '/')}`], { stdio: 'ignore' });
  console.log(`PDF: ${out}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
