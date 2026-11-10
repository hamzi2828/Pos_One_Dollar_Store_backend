// Bank Check: upload a bank statement PDF, match every bank payment to the POS,
// keep the result (lines are stored once per bank and reused), and make a
// marked copy of the PDF. See docs/BANK_CHECK.md.
const mongoose = require('mongoose');
const BankStatement = require('../../models/bankStatement');
const BankStatementLine = require('../../models/bankStatementLine');
const Bank = require('../../models/bank');
const { nextNumber } = require('../sequenceService');
const { saveBuffer, readSaved } = require('../../helper/storeUpload');
const { readPdfText } = require('./pdfText');
const { parseStatement } = require('./parsers');
const { markPdf } = require('./annotate');
const M = require('./matcher');

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const { round2, addDays } = M;
const digits = (s) => String(s || '').replace(/\D/g, '');
const userName = (u) => [u && u.firstName, u && u.lastName].filter(Boolean).join(' ') || (u && u.email) || '';
const shown = (l) => (l.manual && l.manual.status) || l.status;
const lineKey = (r) => `${r.date}|${r.direction}|${r.amount.toFixed(2)}|${r.balance.toFixed(2)}`;
const rs = (n) => `Rs ${Number(round2(n)).toLocaleString('en-US')}`;

async function readStatement(buffer) {
  if (!buffer || !buffer.length) throw bad('Upload the statement PDF');
  if (buffer.length > MAX_PDF_BYTES) throw bad('The PDF is too big (10 MB max)');
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw bad('Only PDF files are allowed');
  return parseStatement(await readPdfText(buffer));
}

function readDay(v, label) {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad(`Pick the ${label} date`);
  return s;
}

const bankOut = (b) => (b && b._id ? { _id: b._id, name: b.name || '', accountNumber: b.accountNumber || '' } : b || null);

// Our bank whose account number matches the statement's (digits only, either one may be shorter).
async function findBank(accountNumber) {
  const acc = digits(accountNumber);
  if (acc.length < 6) return null;
  const banks = await Bank.find({ isDeleted: { $ne: true } }).lean();
  return (
    banks.find((b) => digits(b.accountNumber) === acc) ||
    banks.find((b) => {
      const d = digits(b.accountNumber);
      const i = digits(b.iban);
      return (d.length >= 6 && (acc.endsWith(d) || d.endsWith(acc))) || (i.length >= 10 && i.endsWith(acc));
    }) ||
    null
  );
}

async function lastChecked(bankId) {
  if (!bankId) return null;
  const s = await BankStatement.findOne({ bank: bankId, isDeleted: { $ne: true } }).sort({ checkTo: -1, createdAt: -1 }).lean();
  return s ? { to: s.checkTo, statementNo: s.statementNo } : null;
}

/** Read the PDF and suggest the bank and dates (nothing is saved). */
async function preview(buffer) {
  const st = await readStatement(buffer);
  const bank = await findBank(st.accountNumber);
  const banks = await Bank.find({ isDeleted: { $ne: true } }).select('name accountNumber').sort({ name: 1 }).lean();
  const last = await lastChecked(bank && bank._id);
  let suggestedFrom = st.periodFrom;
  if (last) {
    const next = addDays(last.to, 1);
    if (next >= st.periodFrom && next <= st.periodTo) suggestedFrom = next;
  }
  let alreadyDone = 0;
  if (bank) alreadyDone = await BankStatementLine.countDocuments({ bank: bank._id, key: { $in: st.rows.map(lineKey) } });
  return {
    accountNumber: st.accountNumber,
    bankId: bank ? bank._id : null,
    banks: banks.map(bankOut),
    periodFrom: st.periodFrom,
    periodTo: st.periodTo,
    lineCount: st.rows.length,
    lastChecked: last,
    suggestedFrom,
    suggestedTo: st.periodTo,
    alreadyDone,
  };
}

// Records already tied to a stored line (never matched again).
async function linkedKeys(exceptLineIds = []) {
  const rows = await BankStatementLine.find({ match: { $ne: null }, _id: { $nin: exceptLineIds } }).select('match').lean();
  return new Set(rows.filter((r) => r.match && r.match.src).map((r) => M.recKey(r.match)));
}

async function bankNames() {
  const banks = await Bank.find({}).select('name').lean();
  return Object.fromEntries(banks.map((b) => [String(b._id), b.name]));
}

// Match money-out lines (plain objects with _tmp) for this bank. Returns Map(_tmp -> result).
async function runMatch(lines, bankId, from, to, exceptLineIds = []) {
  const outs = lines.filter((l) => l.direction === 'out');
  const cands = await M.collectCandidates(addDays(from, -3), addDays(to, 12));
  const linked = await linkedKeys(exceptLineIds);
  const free = cands.filter((c) => !linked.has(M.recKey(c)));
  return M.matchLines(outs, free, { bankId: String(bankId), bankNames: await bankNames() }).results;
}

// System records paid by bank in the window but not tied to any statement line.
async function notOnStatement(bankId, from, to) {
  const cands = await M.collectCandidates(from, to);
  const linked = await linkedKeys();
  return cands
    .filter((c) => !linked.has(M.recKey(c)) && M.BANKISH.has(c.kind) && (!c.bank || c.bank === String(bankId)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((c) => ({ src: c.src, id: c.id, subId: c.subId || null, ref: c.ref, label: c.label, date: c.date, amount: c.amount, method: c.method, who: c.who }));
}

// Card sales vs card-machine credits, cash counted in tills vs cash deposits.
// Card and bank transfer sales go into UBL; JazzCash goes to the JazzCash wallet,
// so it is shown on its own and never expected on this statement (owner, 2026-11-11).
async function moneyIn(lines, from, to) {
  const db = mongoose.connection.db;
  const range = { $gte: M.startOf(from), $lt: M.endOf(to) };
  const all = await db
    .collection('posorders')
    .find({ createdAt: range, isDeleted: { $ne: true }, orderStatus: { $nin: ['cancelled'] }, paymentMethod: { $in: ['card', 'split', 'bank_transfer', 'jazzcash'] } })
    .project({ paymentMethod: 1, cardAmount: 1, total: 1, paidAmount: 1, changeGiven: 1 })
    .toArray();
  const orders = all.filter((o) => o.paymentMethod === 'card' || o.paymentMethod === 'split');
  let cardSales = 0;
  for (const o of orders) cardSales += o.paymentMethod === 'card' ? (Number(o.cardAmount) > 0 ? o.cardAmount : o.total) : Number(o.cardAmount) || 0;
  // What the customer sent: the amount paid plus any cash change given back.
  const sent = (o) => (Number(o.paidAmount) || 0) + (Number(o.changeGiven) || 0);
  const bankBills = all.filter((o) => o.paymentMethod === 'bank_transfer');
  const jazzBills = all.filter((o) => o.paymentMethod === 'jazzcash');

  // Till cash: counted at close minus the float left for the next till on the same counter.
  const sessions = await db
    .collection('cashsessions')
    .find({ status: { $ne: 'deleted' }, openedAt: { $gte: M.startOf(addDays(from, -3)), $lt: M.endOf(addDays(to, 7)) } })
    .sort({ openedAt: 1 })
    .project({ counter: 1, branch: 1, status: 1, openedAt: 1, closedAt: 1, openingFloat: 1, closingCount: 1 })
    .toArray();
  let cashCounted = 0;
  let tills = 0;
  sessions.forEach((s, i) => {
    if (!['closed', 'verified', 'disputed'].includes(s.status) || !s.closedAt) return;
    const day = M.pktDay(s.closedAt);
    if (day < from || day > to) return;
    const same = (x) => String(x.counter || x.branch) === String(s.counter || s.branch);
    const next = sessions.slice(i + 1).find(same);
    const counted = (s.closingCount && s.closingCount.total) || 0;
    const nextFloat = (next && next.openingFloat && next.openingFloat.total) || 0;
    cashCounted += Math.max(0, counted - nextFloat);
    tills += 1;
  });

  const ins = lines.filter((l) => l.direction === 'in');
  const sum = (arr) => round2(arr.reduce((t, l) => t + l.amount, 0));
  return {
    cardSales: round2(cardSales),
    cardBills: orders.length,
    cardSettled: sum(ins.filter((l) => l.kind === 'card')),
    bankTransferSales: round2(bankBills.reduce((t, o) => t + sent(o), 0)),
    bankTransferBills: bankBills.length,
    transfersIn: sum(ins.filter((l) => l.kind === 'transfer_in')),
    // Not into UBL: shown for information only.
    jazzcashSales: round2(jazzBills.reduce((t, o) => t + sent(o), 0)),
    jazzcashBills: jazzBills.length,
    cashCounted: round2(cashCounted),
    tills,
    cashDeposited: sum(ins.filter((l) => l.kind === 'cash')),
    otherIn: ins.filter((l) => l.kind !== 'card' && l.kind !== 'cash').map((l) => ({ date: l.date, amount: l.amount, label: l.issue || M.inLabel(l) })),
  };
}

function tally(lines) {
  const counts = { ok: 0, fix: 0, missing: 0, credits: 0 };
  const totals = { debits: 0, credits: 0, ok: 0, fix: 0, missing: 0 };
  for (const l of lines) {
    if (l.direction === 'in') {
      counts.credits += 1;
      totals.credits += l.amount;
      continue;
    }
    totals.debits += l.amount;
    const s = shown(l);
    if (counts[s] !== undefined) {
      counts[s] += 1;
      totals[s] += l.amount;
    }
  }
  Object.keys(totals).forEach((k) => {
    totals[k] = round2(totals[k]);
  });
  return { counts, totals };
}

const windowLines = (statement) =>
  BankStatementLine.find({ statements: statement._id, date: { $gte: statement.checkFrom, $lte: statement.checkTo } })
    .sort({ date: 1, seq: 1 })
    .lean();

function rowLabel(l) {
  const s = shown(l);
  let text;
  if (s === 'in') text = l.issue || M.inLabel(l);
  else if (s === 'ok') text = l.match ? l.match.label : 'OK';
  else if (s === 'fix') {
    const ref = l.match && l.match.ref;
    text = ref && l.issue.includes(ref) ? l.issue : [l.match && l.match.label, l.issue].filter(Boolean).join(': ');
  }
  else text = l.issue || 'Not in the system';
  if (l.manual && l.manual.status) text = `Marked ${l.manual.status.toUpperCase()}${l.manual.note ? `: ${l.manual.note}` : ''}${l.match ? ` (${l.match.label})` : ''}`;
  else if (l.manual && l.manual.note) text = `${text} | Note: ${l.manual.note}`;
  return text;
}

// Build and save the marked PDF. rows = parsed rows of the original PDF.
async function makeMarked(statement, bank, original, rows, lines, extra) {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const marks = [];
  for (const r of rows) {
    const l = byKey.get(lineKey(r));
    if (!l) continue;
    marks.push({ page: r.page, rect: r.rect, labelX: r.labelX, labelW: r.labelW, status: shown(l), label: rowLabel(l) });
  }
  const t = tally(lines);
  const item = (l) => `${l.date}  ${rs(l.amount)}  ${l.payee || ''} - ${rowLabel(l)}`;
  const outs = lines.filter((l) => l.direction === 'out');
  const mi = extra.moneyIn;
  const buf = await markPdf(original, marks, {
    title: `Bank check ${statement.statementNo}`,
    lines: [
      `Bank: ${bank ? `${bank.name} ${bank.accountNumber}` : ''}   Statement: ${statement.periodFrom} to ${statement.periodTo}`,
      `Checked: ${statement.checkFrom} to ${statement.checkTo} against the DOLLAR & Co POS on ${new Date().toISOString().slice(0, 10)} by ${statement.createdByName || '-'}`,
      `Money out ${rs(t.totals.debits)} (${outs.length} lines), money in ${rs(t.totals.credits)} (${t.counts.credits} lines). Lines reused from earlier statements: ${statement.counts?.reused || 0}.`,
    ],
    counts: { ...t.counts, in: t.counts.credits },
    totals: { ...t.totals, in: t.totals.credits },
    sections: [
      { heading: 'Not in the system (paid from bank)', color: 'missing', items: outs.filter((l) => shown(l) === 'missing').map(item) },
      { heading: 'Check / fix in the system', color: 'fix', items: outs.filter((l) => shown(l) === 'fix').map(item) },
      {
        heading: 'In the system as bank, but not on this statement',
        items: extra.notOnStatement.map((n) => `${n.date}  ${rs(n.amount)}  ${n.label} (${n.method || '-'})`),
      },
      {
        heading: 'Money in check',
        color: 'in',
        items: [
          `Card sales in POS ${rs(mi.cardSales)} vs card machine credits ${rs(mi.cardSettled)}`,
          `Cash counted in closed tills ${rs(mi.cashCounted)} vs cash deposited ${rs(mi.cashDeposited)}`,
          `Bank (UBL) transfer sales in POS ${rs(mi.bankTransferSales || 0)} vs transfers in ${rs(mi.transfersIn || 0)}`,
          `JazzCash sales in POS ${rs(mi.jazzcashSales || 0)} (JazzCash wallet, not this bank)`,
          ...mi.otherIn.map((o) => `${o.date}  ${rs(o.amount)}  ${o.label}`),
        ],
      },
    ],
  });
  const base = String(statement.fileName || 'statement').replace(/\.pdf$/i, '');
  return saveBuffer(buf, { folder: 'bank-statements/marked', filename: `${base} - checked.pdf`, mimetype: 'application/pdf', maxBytes: 4 * MAX_PDF_BYTES });
}

async function full(id) {
  if (!isId(id)) throw bad('Statement not found', 404);
  const s = await BankStatement.findOne({ _id: id, isDeleted: { $ne: true } }).populate('bank', 'name accountNumber').lean();
  if (!s) throw bad('Statement not found', 404);
  const lines = await windowLines(s);
  const { notOnStatement: nos, moneyIn: mi, ...statement } = s;
  statement.bank = bankOut(s.bank);
  return { statement, lines, notOnStatement: nos || [], moneyIn: mi || {} };
}

/** Upload + check. body: { bankId, from, to } */
async function create(buffer, fileName, body, { user } = {}) {
  const st = await readStatement(buffer);
  if (!isId(body.bankId)) throw bad('Pick the bank');
  const bank = await Bank.findOne({ _id: body.bankId, isDeleted: { $ne: true } }).lean();
  if (!bank) throw bad('Bank not found');
  const from = body.from ? readDay(body.from, 'from') : st.periodFrom;
  const to = body.to ? readDay(body.to, 'to') : st.periodTo;
  if (from > to) throw bad('"Check from" must be before "Check to"');
  const rows = st.rows.filter((r) => r.date >= from && r.date <= to);
  if (!rows.length) throw bad('No transactions on this statement between these dates');

  const sid = new mongoose.Types.ObjectId();
  const existing = await BankStatementLine.find({ bank: bank._id, key: { $in: rows.map(lineKey) } }).lean();
  const have = new Map(existing.map((l) => [l.key, l]));
  const fresh = rows.filter((r) => !have.has(lineKey(r))).map((r, i) => ({ ...r, _tmp: i, key: lineKey(r) }));

  const results = await runMatch(fresh, bank._id, from, to);
  const docs = fresh.map((r) => {
    const res = r.direction === 'in' ? { status: 'in', issue: M.inLabel(r), match: null } : results.get(r._tmp);
    return {
      bank: bank._id,
      key: r.key,
      date: r.date,
      seq: r.page * 1000 + r.seq,
      particulars: r.particulars,
      payee: r.payee,
      kind: r.kind,
      direction: r.direction,
      amount: r.amount,
      balance: r.balance,
      status: res.status,
      issue: res.issue,
      match: res.match,
      manual: null,
      firstStatement: sid,
      statements: [sid],
    };
  });
  if (docs.length) {
    try {
      await BankStatementLine.insertMany(docs, { ordered: false });
    } catch (err) {
      // Another upload saved some of the same lines a moment ago: reuse theirs.
      if (!(err && (err.code === 11000 || (err.writeErrors || []).every((w) => (w.code || w.err?.code) === 11000)))) throw err;
    }
  }
  await BankStatementLine.updateMany({ bank: bank._id, key: { $in: rows.map(lineKey) } }, { $addToSet: { statements: sid } });

  const statementNo = await nextNumber('BS');
  const statement = {
    _id: sid,
    statementNo,
    bank: bank._id,
    bankCode: st.bankCode,
    fileName: String(fileName || 'statement.pdf').slice(0, 200),
    accountNumber: st.accountNumber,
    periodFrom: st.periodFrom,
    periodTo: st.periodTo,
    checkFrom: from,
    checkTo: to,
    createdBy: user ? user._id || user.id : null,
    createdByName: userName(user),
    counts: { reused: existing.length },
  };
  const lines = await windowLines(statement);
  const t = tally(lines);
  statement.counts = { ...t.counts, reused: existing.length };
  statement.totals = t.totals;
  statement.notOnStatement = await notOnStatement(bank._id, from, to);
  statement.moneyIn = await moneyIn(lines, from, to);
  statement.originalUrl = await saveBuffer(buffer, { folder: 'bank-statements', filename: statement.fileName, maxBytes: MAX_PDF_BYTES });
  statement.markedUrl = await makeMarked(statement, bank, buffer, st.rows, lines, statement);
  statement.checkedAt = new Date();
  await BankStatement.create(statement);
  return full(sid);
}

async function list() {
  const rows = await BankStatement.find({ isDeleted: { $ne: true } })
    .select('-notOnStatement -moneyIn')
    .populate('bank', 'name accountNumber')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return rows.map((r) => ({ ...r, bank: bankOut(r.bank) }));
}

async function saveTallies(statementIds) {
  for (const id of statementIds) {
    const s = await BankStatement.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
    if (!s) continue;
    const t = tally(await windowLines(s));
    await BankStatement.updateOne({ _id: id }, { $set: { counts: { ...t.counts, reused: s.counts?.reused || 0 }, totals: t.totals } });
  }
}

/** Re-match lines still 'fix' / 'missing' with no owner decision, then remake the PDF. */
async function recheck(id, { user } = {}) {
  const { statement } = await full(id);
  const s = await BankStatement.findById(id).lean();
  const all = await windowLines(s);
  const open = all.filter((l) => l.direction === 'out' && ['fix', 'missing'].includes(l.status) && !(l.manual && l.manual.status));
  if (open.length) {
    const work = open.map((l, i) => ({ ...l, _tmp: i }));
    const results = await runMatch(work, s.bank, s.checkFrom, s.checkTo, open.map((l) => l._id));
    await BankStatementLine.bulkWrite(
      work.map((l) => {
        const r = results.get(l._tmp);
        return { updateOne: { filter: { _id: l._id }, update: { $set: { status: r.status, issue: r.issue, match: r.match } } } };
      })
    );
  }
  const lines = await windowLines(s);
  const t = tally(lines);
  const update = {
    counts: { ...t.counts, reused: s.counts?.reused || 0 },
    totals: t.totals,
    notOnStatement: await notOnStatement(s.bank, s.checkFrom, s.checkTo),
    moneyIn: await moneyIn(lines, s.checkFrom, s.checkTo),
    checkedAt: new Date(),
  };
  const original = await readSaved(s.originalUrl);
  const st = await readStatement(original);
  const bank = await Bank.findById(s.bank).lean();
  update.markedUrl = await makeMarked({ ...s, ...update, createdByName: userName(user) || s.createdByName }, bank, original, st.rows, lines, update);
  await BankStatement.updateOne({ _id: s._id }, { $set: update });
  // Other statements showing the same lines get fresh numbers too.
  const others = await BankStatementLine.distinct('statements', { _id: { $in: open.map((l) => l._id) } });
  await saveTallies(others.filter((x) => String(x) !== String(statement._id)));
  return full(id);
}

/** Owner decision on one line: { status: 'ok'|'fix'|'missing' (or empty to clear), note }. */
async function setManual(lineId, body, { user } = {}) {
  if (!isId(lineId)) throw bad('Line not found', 404);
  const line = await BankStatementLine.findById(lineId);
  if (!line) throw bad('Line not found', 404);
  const status = body.status ? String(body.status) : '';
  if (status && !['ok', 'fix', 'missing'].includes(status)) throw bad('Status must be ok, fix or missing');
  if (status && line.direction === 'in') throw bad('Money-in lines can only get a note');
  const note = String(body.note || '').trim().slice(0, 500);
  line.manual = status || note ? { status: status || null, note, by: user ? user._id || user.id : null, byName: userName(user), at: new Date() } : null;
  line.markModified('manual');
  await line.save();
  await saveTallies(line.statements);
  return line.toObject();
}

/** Soft delete. Lines used only by this statement are removed (their records become free again). */
async function remove(id, { user } = {}) {
  if (!isId(id)) throw bad('Statement not found', 404);
  const s = await BankStatement.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!s) throw bad('Statement not found', 404);
  s.isDeleted = true;
  s.deletedAt = new Date();
  s.deletedBy = user ? user._id || user.id : null;
  await s.save();
  const removed = await BankStatementLine.deleteMany({ statements: { $size: 1, $all: [s._id] } });
  await BankStatementLine.updateMany({ statements: s._id }, { $pull: { statements: s._id } });
  const moved = await BankStatementLine.find({ firstStatement: s._id }).select('statements').lean();
  for (const l of moved) await BankStatementLine.updateOne({ _id: l._id }, { $set: { firstStatement: l.statements[0] || null } });
  return { _id: s._id, statementNo: s.statementNo, linesRemoved: removed.deletedCount || 0 };
}

module.exports = { preview, create, list, get: full, recheck, setManual, remove, moneyIn, MAX_PDF_BYTES, lineKey };
