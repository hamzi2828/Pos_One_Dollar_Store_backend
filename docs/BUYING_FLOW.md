# Buying flow (simple) — Oct 2026

How the shop really buys, in the owner's words: **go to the market → buy from
several vendors → pay part now → boxes reach the warehouse → check all boxes
came → open boxes and enter the goods (each with its cost price) → a price tag
is printed as goods are entered → put on a shelf now or later.**

The app follows exactly these steps. Old words → new words in the UI:

| Step | Who / where | Screen | Record |
|---|---|---|---|
| 1. **Buy** | Buyer, at the market (phone) | Purchase trip | `PurchaseOrder` status `open` |
| 2. **Send to warehouse** | Buyer | Purchase trip → "Send to warehouse" | PO `closed`, `GoodsReceipt` `pending` |
| 3. **Check boxes** | Warehouse person (not the buyer, setting) | Receive goods → step 1 | GRN `pending` → `in_progress` |
| 4. **Unpack & enter goods** (+ tags, + shelf optional) | Warehouse person | Receive goods → step 2 | GRN `entries`, stock posted per entry |
| 5. **Finish** | Warehouse person | Receive goods → step 3 | GRN `completed`, PO `received` |
| 6. Shelf later | Anyone with putaway | Warehouse → Shop (exists) | unchanged |

Stock goes into the WAREHOUSE the moment an entry is saved (so tags can be
printed and the goods can go to a shelf at once). Nothing waits for "Finish".

---

## 1. Buy — vendor bill (PurchaseOrder.bills[])

New bill fields (all optional except as noted):

| Field | Meaning |
|---|---|
| `billAmount` | Total written on the vendor's paper bill (Rs). **Required (> 0) when the bill has no items.** |
| `cartons` (exists) | Boxes bought from this vendor. **Required > 0 to send to warehouse** (sum over bills ≥ 1). UI word: "Boxes". |
| `paidNow` | Amount paid to the vendor at the market (0 = nothing). ≤ bill total. |
| `paidMethod` | `cash` (default) \| `bank_transfer` \| `cheque` \| other methods paymentService accepts |
| `paidBank` | bank id when method needs it (paymentService rules) |
| `payment` | VendorPayment id, set when the trip is sent (posted with the bill) |

`items[]` stay **optional** ("If you already know the items, add them; otherwise
enter them while unpacking"). Bill total rule (`billTotal`, what we owe):

```
billTotal = billAmount > 0 ? billAmount : (subtotal − discount)   // items total
```
`subtotal` keeps meaning "sum of typed items" so the UI can show
"Items typed Rs X of bill Rs Y".

Vendor balance on the bill card / picker stays as today.

## 2. Send to warehouse — `POST /api/purchase-orders/:id/close` (same route)

Rules change:
- ≥ 1 bill; every bill has `billTotal > 0` (from `billAmount` or items) — an
  empty bill is no longer an error when `billAmount > 0`.
- Boxes: body `cartons` optional; default = sum of bill `cartons`; must be > 0.
- **Builty is optional**: `builtyNo`, `transporter`, photo, `freight` all
  optional. Freight > 0 still becomes the `builty_freight` charge.
- On send (inside `finalizeClose`, idempotent): post each bill to the vendor
  ledger (credit `billTotal`, as today) **and** record `paidNow > 0` with
  `paymentService.recordPayment` (reference "PO-… bill …", one per bill, never
  twice — store `bill.payment`; on retry skip when set). Reopen / cancel of a
  closed trip voids those payments too (paymentService.voidPayment or the
  ledger void used there), then clears `bill.payment`.
- The GRN is created with:
  - `boxes: [{ bill, vendor, vendorName, billNo, expected (bill cartons), received: 0 }]`
  - `expectedCartons` = trip boxes (as today)
  - `lines` = typed items as today (now called **expected items**, a checklist; may be empty)
  - `chargeRate` = `chargesTotal / goodsTotal` (goodsTotal = Σ billTotal), frozen here
    (4 decimals). Landed cost of every entry = `costPrice × (1 + chargeRate)`, rounded 2.
- Response unchanged: `{ po, grn: { _id, grnNumber, status }, warnings }`.
- Trip charges can no longer change once receiving started (already true: PO not open).

## 3. Check boxes — GRN step 1

`POST /api/receiving/:id/boxes` body `{ boxes: [{ bill, received }], note? }`
- Allowed while `pending` (it also does what `start` did: receiver = user,
  status → `in_progress`, PO → `receiving`, startedAt) or `in_progress` with no
  entries yet (to correct the count).
- Sets each `boxes[i].received`, `cartonsReceived` = Σ received, `boxesCheckedAt`, `boxesNote`.
- Different-receiver rule (`purchasing.requireDifferentReceiver`) applies, as today.
- `POST /receiving/:id/start` keeps working (same as today) for old screens/tests.

## 4. Unpack & enter goods — GRN entries

New sub-document `entries[]` on GoodsReceipt:

```
{ _id, entryNo, bill, vendor, vendorName, billNo,
  product, variantId, productName, code (shortCode), salePrice,
  qty (pieces, int ≥ 1), damagedQty (int ≥ 0, ≤ qty; damaged pieces do NOT go to stock),
  costPrice (vendor price per piece, > 0), landedUnitCost,
  value = qty × costPrice,            // what the vendor charged for these pieces
  stockQty = qty − damagedQty,        // pieces put into the warehouse
  line (GRN expected line id, when it matched a typed item), movement (StockMovement id),
  shelved (pieces put on a shelf right away), createdBy, createdByName, createdAt,
  undone (bool), undoneAt, undoneBy }
```

Endpoints (permission `goods_receiving` edit; receiver rule applies):

| Route | Does |
|---|---|
| `GET /api/receiving/:id/lookup?code=` | Find a product by barcode / short code / SKU / name search (reuse purchasing `productLookup` / `resolveScan`). Returns units `[ { productId, variantId, name, code, salePrice, lastCost, piecesPerBox, expected: { lineId, qtyLeft, unitPrice } \| null } ]`. |
| `POST /api/receiving/:id/entries` | Body `{ bill, productId, variantId?, qty, costPrice, damagedQty?, shelfId?, shelfQty? }`. **Posts stock now**: `stockService.receiveStock` (`purchase_receipt`, cost `{ unitCost: landedUnitCost, purchasePrice: costPrice, vendorId, vendorName }`, movement note tags the entry so a retry never doubles). If `shelfId` + `shelfQty` (≤ stockQty): `locationService.putaway` right after. If it matches a typed expected line of the same bill + product, that line's `receivedQty`/`damagedQty` go up (capped; the rest is just extra). Returns `{ entry, grn, tags: { productId, variantId, copies: stockQty } }`. |
| `POST /api/receiving/:id/new-product` | Quick new product while unpacking: `{ name, category?, salePrice, costPrice?, piecesPerBox?, barcode? }` → creates a published single product (reuse PO `addNewProduct` / productLookup creation code, shortCode auto) and returns the unit (same shape as lookup). Permission: `goods_receiving` edit (product create is done by the service on the user's behalf, like the PO route). |
| `DELETE /api/receiving/:id/entries/:entryId` | Undo an entry while the GRN is `in_progress`: only if all its `stockQty` pieces are still in the warehouse (not shelved / sold); takes them back out with a reversing stock movement (use stockService's removal with movement context; type `adjustment` or a new `purchase_receipt_reversal` — your call, document it), marks `undone`, rolls back the expected line counts. 409 with a plain message otherwise ("3 of these pieces were already put on a shelf — move them back to the warehouse first."). |

`GET /api/receiving/:id` adds:
```
boxes[], boxesCheckedAt, boxesNote, chargeRate,
entries[] (newest first, undone hidden unless ?all=1),
progress: { byBill: [ { bill, vendorName, billNo, billTotal, entered (Σ value), left (billTotal − entered), boxesExpected, boxesReceived } ],
            entered, billTotal, left, pieces, damaged }
```

## 5. Finish — `POST /api/receiving/:id/complete` (same route, new meaning)

Body `{ claims: [{ bill, claim: true|false }], notes? }`.
- Requires `in_progress`. Stock is already in, so this only closes:
  - per bill: `entered = Σ (stockQty × costPrice)` over its live entries (damaged
    pieces are NOT counted, so their money is claimable), `difference = billTotal − entered`.
    If `claim` (default true when difference > 0) → vendor ledger `debit_note` for the
    difference (unique per GRN + bill, as today's claims), description
    "Not received / damaged: Rs X". difference < 0 (more entered than billed) → no ledger
    row, just a warning in the summary.
    `progress.byBill[].entered` uses the same formula.
  - Typed expected lines that were never entered stay as "short" in the summary (info).
  - GRN `completed`, `totals` filled (expected boxes/received boxes, pieces, damaged, stockValue at landed cost, claimed), PO `received`, history rows, notification as today.
- **Old GRNs** (lines counted the old way, no entries): if the GRN has no entries and
  any line has `receivedQty > 0`, keep today's completion path (post lines at the end) so
  nothing in flight breaks.

## 6. Tags

After each entry the UI offers **Print tags (N)**, N = stockQty, using the
existing sticker endpoint `POST /api/products/labels/print` (size remembered in
localStorage). No backend change.

## 7. Notes

- Money is PKR, round to 2 decimals; pieces are integers.
- Every stock change goes through `stockService` (never touch product stock directly).
- Keep old fields/routes working: existing tests for PO with typed items must
  still pass after updating expectations where the rules intentionally changed
  (empty bill with billAmount allowed, builty optional).

## 8. As built (backend, Oct 2026) — exact responses and small clarifications

All responses are `{ success, data, ...extra }`.

| Route | Response |
|---|---|
| `POST /purchase-orders/:id/close` | unchanged: `data` = PO, top-level `grn: { _id, grnNumber, status }`, `warnings[]` |
| `POST /receiving/:id/boxes` | `data` = GRN (same as GET), top-level `warnings[]` (e.g. "Karachi Wholesale: 1 box(es) missing (1 of 2).") |
| `GET /receiving/:id/lookup?code=&bill=` | `data` = units[] (expected items first). `bill` optional: prefer that bill's expected line |
| `POST /receiving/:id/new-product` | 201, `data` = one unit (lookup shape; `lastCost` = the costPrice sent) |
| `POST /receiving/:id/entries` | 201, `data: { entry, grn, tags: { productId, variantId, copies, productName, code, salePrice }, warnings[] }`; a resent `requestId` → 200 with `repeated: true` and the first entry |
| `DELETE /receiving/:id/entries/:entryId` | `data: { entry, grn }` (`alreadyUndone: true` when repeated). 409 `NOT_IN_WAREHOUSE` with the plain message |
| `POST /receiving/:id/complete` | `data` = GRN, top-level `alreadyCompleted`, `warnings[]` |

Unit (lookup / new-product): `{ productId, variantId, name (incl. variant label), code, salePrice, lastCost, piecesPerBox,
expected: { lineId, bill, vendorName, billNo, expectedQty, qtyLeft, unitPrice } | null, productName, variantLabel, sku,
category, thumbnailUrl, costPrice, lastLandedCost, lastVendorName, stockTotal }`.

Clarifications:
- `paidMethod`: `cash | bank_transfer | cheque | easypaisa | jazzcash | other`. `bank_transfer` is stored as
  `bank` (VendorPayment's word). paymentService does not require a bank for it; `paidBank` is checked if sent.
  Payment reference = `"PO-2026-00001 bill A-1"` (`"bill #2"` when the bill has no number).
- Entries need the GRN `in_progress` (check boxes, or old `start`), else 409 `NOT_STARTED`.
- Entry body extras: `requestId?` (send a fresh one per tap; a retry with the same id never doubles);
  `bill` may be left out when the trip has one bill; `shelfId` without `shelfQty` puts all good pieces on the shelf.
  If the shelf step fails the entry is still saved (pieces in warehouse) and a warning is returned.
- `GET /receiving/:id` also returns `mode` (`entries` | `lines` = counted on the old screen), `closing` (finish
  preview: `byBill[{ bill, vendorName, billNo, billTotal, entered, difference, claim, claimAmount, damaged,
  damagedValue, shortQty, warning }]`, `shortLines[]`, `warnings[]`, `totals`) and keeps `summary` (old view).
  `progress` also has `entries, stocked, boxesExpected, boxesReceived` and per bill `entries, pieces, damaged`.
  `pieces` = pieces entered including damaged; `stocked` = good pieces put in the warehouse.
- Undo: reversal movement type `adjustment_out` (note "GRN entry N undone · …"). The product's weighted-average
  cost is not rolled back (it stays as it was after the receipt).
- Quick new product: category defaults to "General"; created with 0 stock as `out_of_stock` and becomes
  `published` automatically when its first entry puts stock in. A barcode used by another product → 409.
- Old vs new: once a GRN has entries, `PUT lines` / `scan` answer 409 `ENTRIES_MODE`; a GRN already counted line by
  line refuses entries (409 `COUNTED_BY_LINES`) and finishes the old way. `complete` uses the old path when there are
  no entries and lines were counted (or the body has `lines` / `claimFromVendor` / `cartonsReceived`).
- Finish with nothing entered claims the whole bill by default (send `claim: false` to keep owing it).
- `GET /receiving` rows add `entryCount`, `enteredPieces`, `boxesCheckedAt`; `vendors` also come from boxes.
- GRNs created before this change get `boxes` and `chargeRate` derived on read; `chargeRate` is stored on the first entry.

## Box by box (Oct 2026)

Unpacking goes vendor → box → items. Each entry can carry `boxNo` (1..boxes
that came for that bill; 0 / missing = not said). `POST /api/receiving/:id/boxes/done`
`{ bill, boxNo, done = true }` marks a box fully unpacked (`done: false` opens it
again); the receipt returns `boxesDone: [{ bill, boxNo, at, byName }]`. It is only
a note for the screen — stock is never touched by it.
On the screen "New product" opens the full product form (Products → Create) in a
popup with no stock fields; once saved the product is picked for the open box.
