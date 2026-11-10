// Statement layouts we can read. Add another bank: a module with
// { code, detect(pages), parse(pages) } and list it here.
const PARSERS = [require('./ubl')];

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function parseStatement(pages) {
  const p = PARSERS.find((x) => x.detect(pages));
  const out = p && p.parse(pages);
  if (!out) throw bad('This statement layout is not supported yet (UBL only)');
  if (!out.rows.length) throw bad('No transactions found in this statement');
  return out;
}

module.exports = { parseStatement, PARSERS };
