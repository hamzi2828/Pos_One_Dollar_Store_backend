# Barcodes, Boxes & Batches — guide for the frontend

All routes need `Authorization: Bearer <token>`. Product routes are at the root (`/products/...`),
POS routes are at `/api/pos/...`. Some routes are still being wired by the backend team: when this
guide says **(see code)**, check the controller for the final response shape.

## 1. Concepts

| Word | Meaning |
|---|---|
| **Unit** | Something you can sell. A single product is one unit. A variant product has one unit per variant. |
| **shortCode** | 5-digit number per unit (e.g. `10245`). The cashier can type it. It is also the barcode printed on our stickers. Auto-generated if you don't send one. |
| **barcodes** | Extra codes on a unit, e.g. the maker's EAN. Each has `qty` = pieces sold per scan (normally 1). |
| **piecesPerBox** | Pieces inside one box (product level). `1` = sold loose. |
| **Full-box code** | `<shortCode>-BOX`, e.g. `10245-BOX`. One scan sells a full box (`qty = piecesPerBox`). Optional. |
| **batches** | Received lots. Each gets `batchNo` and barcode `<shortCode>-<n>` (`10245-1`, `10245-2`), optional cost price and expiry date. |
| **Stock** | Always in **pieces**. If a unit has batches, its stock = sum of batch quantities. |

Selling order for batches: the scanned batch first; otherwise earliest expiry first, then oldest received.

Every code (SKU, shortCode, barcodes, batch barcodes) is unique across the whole shop. Codes are
stored UPPERCASE.

## 2. Create / update product payload

`POST /products` and `PUT /products/:id` are **multipart/form-data**. Arrays and objects must be
sent as **JSON strings**.

| Field | Example | Notes |
|---|---|---|
| `shortCode` | `"10245"` | Optional. Leave empty → auto. Single products only. |
| `barcodes` | `'[{"code":"5012345678900","qty":1,"label":"manufacturer"}]'` | Optional. |
| `piecesPerBox` | `12` | Default 1. |
| `addFullBoxBarcode` | `true` | Adds `<shortCode>-BOX` when `piecesPerBox > 1`. |
| `boxes` + `loosePieces` | `3`, `0` | Stock = `boxes * piecesPerBox + loosePieces`. Use instead of `stock`. |
| `batches` | `'[{"quantity":24,"costPrice":80,"expiryDate":"2027-03-01"}]'` | Each: `batchNo?`, `barcode?`, `quantity`, `costPrice?`, `expiryDate?`. Stock = sum of quantities. |
| `variants` | see below | For `productType: "variant"`. |

Variant item (inside the `variants` JSON string):

```json
{
  "attributes": { "Storage": "128GB", "RAM": "8GB" },
  "color": "Black",
  "price": 120000, "stock": 5, "sku": "IP15-128-BLK",
  "shortCode": "",
  "barcodes": [{ "code": "0194253000000", "qty": 1 }],
  "batches": [],
  "boxes": 0, "loosePieces": 5
}
```

`attributes` is free: any option name → value. `color`/`size` still work. Each variant gets its own
`shortCode`, `barcodes`, `batches`.

**Duplicate code → HTTP 409**

```json
{ "message": "Code \"10245\" is already used by product \"Cable\"", "duplicateCode": "10245", "conflictProductId": "66f..." }
```
Show the message next to the field that holds `duplicateCode`.

**Create response** includes what to open next:

```json
{ "message": "Product created successfully", "data": { ... },
  "next": { "printLabels": "/products/<id>/labels", "labelData": "/products/<id>/label-data" } }
```

## 3. Endpoints

### Codes
- `GET /products/codes/check?code=X&excludeId=Y` → `{ code, available, usedBy? }`. Call on blur of
  any code field. Pass `excludeId` when editing.
- `GET /products/codes/new-short-code` → `{ shortCode }`. For a "Generate" button.
- `GET /products/codes/lookup/:code` → product + `match` (same `match` as the POS scan below) **(see code)**.

### Stock
- `POST /products/:id/stock/receive` body JSON:
  `{ variantId?, quantity?, boxes?, loosePieces?, batch? }`
  `batch` = `{ batchNo?, barcode?, costPrice?, expiryDate? }`. Quantity in pieces, or boxes + loose.
  With `batch` a new batch is created (new code `<shortCode>-<n>` → print its sticker) **(see code)**.

### Labels / stickers
- `GET /products/:id/label-data` → JSON data to build your own label preview **(see code)**.
- `GET /products/:id/labels?variantId=&type=&copies=&size=&showPrice=&autoPrint=1` → **HTML page** ready to print.
  - `type`: `unit` (shortCode, 1 piece) · `box` (box sticker, sells 1 piece per scan) · `full-box` (`-BOX`, sells whole box) · `batch` · `barcode`
  - `size`: `38x25` · `50x25` · `50x30` · `40x30` · `60x40` · `a4`
  - `showPrice`: `1`/`0`; `autoPrint=1` opens the print dialog on load.
- `POST /products/labels/print` → bulk HTML for many products/variants **(see code for body)**.

The labels page needs the token, so do **not** open the URL directly:

```js
const res = await fetch(`${API}/products/${id}/labels?type=unit&copies=12&size=50x25&autoPrint=1`,
  { headers: { Authorization: `Bearer ${token}` } });
const url = URL.createObjectURL(await res.blob());
window.open(url, '_blank');               // revoke the URL a minute later
```

### POS
- `GET /api/pos/products/barcode/:code` (code = scanned or typed, URL-encoded) →
  ```json
  { "data": { ...product },
    "match": { "variantId": "v1" , "batchNo": null, "qty": 1, "kind": "shortCode", "code": "10245", "variantLabel": "Black / 128GB" } }
  ```
  `kind`: `sku` · `shortCode` · `barcode` · `batch`. `variantId` is null for single products.
- `POST /api/pos/orders` — each item also sends `scannedCode` and `batchNo` (from `match`).
- `POST /api/pos/orders/:id/refund` and `DELETE /api/pos/orders/:id` put the stock back (only once
  per order, safe to retry).

**Cart rule:** one scan adds `match.qty` pieces of that unit. Scanning the same code again adds
`match.qty` more to the same cart line (same product + variant + batchNo). Never ask the cashier
for a quantity after a scan.

## 4. Example flows

**(a) Simple item** — USB cable, 40 pieces.
Create: `name, price, stock=40` (no shortCode) → gets `shortCode "10245"`. Print 40 `unit` stickers.
POS: scan `10245` → `qty 1` → cart 1 cable. Scan again → 2.

**(b) Box of 12, 3 boxes** — sticker only on the box.
Create: `piecesPerBox=12, boxes=3, loosePieces=0, addFullBoxBarcode=true` → stock 36, codes
`20311` and `20311-BOX`. Print 3 `box` stickers (and `full-box` if wanted).
POS: scan box sticker 3 times → 3 pieces (stock 33). Scan `20311-BOX` once → 12 pieces.

**(c) Phone with 3 variants**
Create: `productType=variant`, `variants` = 128GB/Black, 256GB/Black, 128GB/Blue with `attributes`
and maker EAN in `barcodes`. Each variant gets its own shortCode. Print `unit` stickers per
variant (`variantId=`). POS: scan EAN or shortCode → `match.variantId` picks the variant.

**(d) Batch with expiry** — engine oil.
Create with `batches=[{"quantity":24,"costPrice":800,"expiryDate":"2027-03-01"}]` → batch
`30877-1`, stock 24. Later: `POST /products/:id/stock/receive` with
`{ "quantity": 24, "batch": { "expiryDate": "2027-09-01" } }` → batch `30877-2`, stock 48.
Print `batch` stickers for the new batch. POS: scanning `30877-2` sells from batch 2; scanning
`30877` sells from batch 1 first (earliest expiry).

## 5. UI flow: Create product → Print stickers

1. Product form: shortCode field with **Generate** button (`/codes/new-short-code`) and live check
   (`/codes/check`). "Barcodes" list (code, qty, label). Packaging: piecesPerBox, boxes, loose pieces,
   "Add full-box code" checkbox. Optional batches table. Variants: attribute rows + per-variant codes.
2. Save → on 409 highlight `duplicateCode`. On 201 open the **Print stickers** dialog with `next`.
3. Dialog loads `next.labelData`: one row per unit / batch with suggested copies (= stock in pieces,
   or number of boxes for `box`). User picks type, size, copies, show price.
4. Print → fetch `next.printLabels` with those params + `autoPrint=1` → blob URL → `window.open`.
5. Add a "Print stickers" button on the product list/detail and after "Receive stock".

## 6. UI flow: POS scanning

- A USB/Bluetooth scanner types the code like a keyboard and presses **Enter**. Keep a
  focused input (auto-focus after every action); on Enter call `/api/pos/products/barcode/:code`.
- Also show a "Code" field where the cashier types a short code (e.g. `10245`) + Enter — same call.
- Found → add `match.qty` pieces to the line for (product, `variantId`, `batchNo`); show
  `variantLabel`; beep. Not found (404) → error beep + message, clear input.
- Check stock in pieces before adding; show "box" lines as pieces (e.g. "12 pcs").
- On checkout send each item with `variantId`, `quantity` (pieces), `scannedCode`, `batchNo`.

## Pieces per sale (Oct 2026)

`product.piecesPerSale` (int, default 1): physical pieces handed over in ONE sale
(e.g. 2 plates for Rs 300). Stock, price, cost and `piecesPerBox` are all counted
in SALES, so the POS, stock and reports need no change: one scan = one sale.
The product form types "pieces in one box/pack" (physical) and saves
piecesPerBox = physical / piecesPerSale; receiving counts pieces and saves
qty = pieces / piecesPerSale (must divide evenly). Variants: always 1.
