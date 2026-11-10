# Bank Check

Reports > Spending > **Bank check**. Upload a bank statement PDF; every bank payment is matched to
what is in the POS, the result is saved, and a marked copy of the PDF is made
(green = OK, orange = check / fix, red = not in the system, blue = money in, plus a summary page).
No AI: plain rules. Permission group `bank_check` (Finance; view / create / edit / delete). No default
role has it; super admin has everything.

## Code

| File | What |
|---|---|
| `src/routes/modules/bankCheckRoutes.js` | endpoints, PDF upload (memory, 10 MB, PDF only) |
| `src/services/bankcheck/bankCheckService.js` | preview, create, list, get, recheck, manual decision, delete |
| `src/services/bankcheck/pdfText.js` | PDF text with positions (`pdfjs-dist` legacy build, loaded with `import()`) |
| `src/services/bankcheck/parsers/` | statement layouts. `ubl.js` is the only one now; add a bank = new module `{ code, detect, parse }` listed in `parsers/index.js` |
| `src/services/bankcheck/matcher.js` | which POS records are money out, and the matching rules |
| `src/services/bankcheck/annotate.js` | draws boxes / labels / summary page (`pdf-lib`) |
| `src/models/bankStatement.js`, `bankStatementLine.js` | stored results |
| `src/helper/storeUpload.js` | `saveBuffer` (save a generated file, Vercel Blob or /uploads) and `readSaved` |

## UBL layout

Columns DATE | PARTICULARS | INST. NO. | DEBIT | CREDIT | BALANCE (found by the header words on each page).
A row starts at a `DD-Mon-YYYY` in the DATE column; the footer ("For latest schedule of charges…") is cut off.
The amount comes from the running BALANCE (`balance - previous balance`); the "Opening Balance" row only
sets the start. Payee = text after `FT TO` / `TRANSFER TO` up to the bank word (MEBL, EASYPAISA, HBL, BIPL,
BAFL, JAZZCASH, `(A/C`, …). Money in: `DOLLARANDCO` / merchant `105827100029340` = card machine,
`CASH` / `CASH DEPOSITED` = cash deposit, `FT FROM` / `FUNDS TRANSFER, FR:` / `TRANSFER FROM` = transfer in.
Header gives the account number and period. Anything else → 400 "This statement layout is not supported yet (UBL only)".

## Lines are stored once

`BankStatementLine` key = `date|direction|amount|balance`, unique per bank. On a new upload, lines already
stored are **reused** (not matched again, counted as `reused`) and the statement is added to their
`statements`. A record (vendor payment, expense, …) linked to any stored line is never matched again.
Deleting a statement (soft) removes only lines no other statement uses.

## Matching (money out)

Candidates (records dated from 3 days before to 12 days after the window):

| `match.src` | Source |
|---|---|
| `vendor_payment` | vendorpayments, not voided |
| `expense` | expenses not deleted, not shop use / payroll / tip expenses, not paid from personal money |
| `trip_cost` | purchaseorders.charges (PO not cancelled) — no payment method in the POS |
| `trip_bill` | purchaseorders.bills paid at the market with no VendorPayment yet |
| `loan` | loans.repayments |
| `investment` | investments.payments (no method in the POS) |
| `payroll` | payrollruns.payments |
| `advance` | salaryadvances, not cancelled |
| `tip` | stafftips not deleted, not cash / salary |

`match = { src, id (record _id), subId (sub-entry _id or null), ref, label, date, amount, method }`.

A pair is possible when the record date is bank date −3 … +12 days and the amount is exact, or within
2% and Rs 1,000 with a good name match. Score = exact amount (10) or close (5) + name likeness × 5
+ 2 if the record is a bank / online / card / cheque payment + 1 if it names this bank − 0.15 per day apart.
Best scores are taken first, each line and record used once.

Status: **ok** exact amount, bank-type method, same bank (or none set). **fix** matched but cash method, other
bank, close amount ("System 89,000, bank 89,500"), or no method (trip cost: "Likely trip cost PO-… — check").
**missing** nothing found ("Paid from bank, not in the system"; bank charges say so). **in** money in.
Shown status = `manual.status || status`. Re-check re-matches only lines still fix / missing with no owner decision.

`notOnStatement`: records in the window with a bank-type method (this bank or no bank set) not linked to any line.
`moneyIn`: `cardSales` (POS card bills + card part of split bills) vs `cardSettled` (card-machine credits);
`cashCounted` (closed tills: counted − float left for the next till on that counter) vs `cashDeposited`;
`otherIn[] { date, amount, label }`; also `cardBills`, `tills`.

## API (`/api`, `{ success, data }`)

- `POST /bank-statements/preview` (create) multipart `file` → `{ accountNumber, bankId|null, banks[{_id,name,accountNumber}], periodFrom, periodTo, lineCount, lastChecked {to, statementNo}|null, suggestedFrom, suggestedTo, alreadyDone }`
- `POST /bank-statements` (create) multipart `file`, `bankId`, `from`, `to` (YYYY-MM-DD) → same as GET :id (201)
- `GET /bank-statements` (view) → list, newest first, without `notOnStatement` / `moneyIn`
- `GET /bank-statements/:id` (view) → `{ statement, lines[], notOnStatement[], moneyIn }` (lines in the check window, by date)
- `POST /bank-statements/:id/recheck` (edit) → same as GET :id; marked PDF made again
- `PUT /bank-statement-lines/:id` (edit) `{ status: 'ok'|'fix'|'missing'|'' , note }` → the line. Empty status + note = note only; both empty = clear. Money-in lines take a note only.
- `DELETE /bank-statements/:id` (delete) → `{ _id, statementNo, linesRemoved }`

`statement.bank` is always `{ _id, name, accountNumber }`. `markedUrl` / `originalUrl` are Vercel Blob URLs
(random names) or `/uploads/...` when no blob token (local / tests). Counts change right away on a manual
decision; the marked PDF is only redrawn on create / re-check.

## Notes

- Vercel limits a request body to about 4.5 MB, so bigger PDFs fail there before the 10 MB check.
- `pdfjs-dist` pulls the optional `@napi-rs/canvas`; text reading does not need it.
- Tests: harness `bankcheck.test.js` (real UBL sample, in-memory DB).
