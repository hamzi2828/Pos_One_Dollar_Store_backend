// src/services/analytics/csv.js
// CSV downloads for the reports (opens cleanly in Excel: UTF-8 BOM + CRLF).
//
//   sendCsv(res, 'demand-2026-10-18', [{ label: 'Product', value: (r) => r.name }, ...], rows);

const cell = (v) => {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  // Spreadsheet formula injection: text starting with = + - @ is shown as text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** columns: [{ label, value: (row) => any }] */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function sendCsv(res, filename, columns, rows) {
  const safe = String(filename).replace(/[^\w.-]+/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
  res.status(200).send(toCsv(columns, rows));
}

/** 'YYYY-MM-DD' in PKT for a Date (or '' when empty) — for CSV date columns. */
const csvDay = (d) => (d ? require('./time').dayKey(d) : '');

module.exports = { toCsv, sendCsv, csvDay };
