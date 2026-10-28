# Offline sales (POS works with no internet, uploads by itself later)

Owner's ask (2026-10-28): the counter must keep selling when the internet drops,
and the sales must reach the server by themselves when it comes back. Also: the
desktop app needs its own permissions on the Roles page (attendance, POS ...).

```
 Counter PC                                             POS server (Vercel)
 ┌──────────────────────────────────────┐
 │ POS screen /admin/pos (installed PWA, │  GET  /api/pos/offline/catalog   (online: every few min)
 │ opened by the desktop app's "Sales")  │ ◄────────────────────────────────
 │  IndexedDB: catalog + outbox          │  POST /api/pos/offline/orders    (when back online)
 │  offline sale -> outbox, slip OFF-..  │ ────────────────────────────────►  same sale never saved twice
 └──────────────────────────────────────┘                                    (unique clientId)
```

The server stays the single source of truth. The PC only keeps a read copy of
the catalogue and a queue (outbox) of sales it could not send.

## 1. Permissions (Roles page → new section "Desktop app")

Section `{ key: 'desktop', label: 'Desktop app', iconKey: 'desktop' }`, groups:

| key | label | actions | meaning |
|---|---|---|---|
| `attendance_kiosk` (moved here from HR, key unchanged) | Attendance (fingerprint) | view, create | sign in the counter app / punch |
| `desktop_pos` (new) | Sales on the counter PC (works offline) | view, create | view = "Sales" button in the desktop app + download the offline catalogue; create = sell while offline and upload those sales |

Default roles: Manager `desktop_pos: VC` (keeps `attendance_kiosk: VC`); Cashier `desktop_pos: VC`.
Admin gets everything automatically (buildAllPermissions).
Existing roles in the DB are not changed automatically — the owner ticks the
boxes on the Roles page (Admin already has all).

Offline selling in the POS screen is switched on only for users with
`desktop_pos` view (catalogue download) AND `pos` create. Users without it see
the old behaviour (online only, a clear "No internet" message).

## 2. GET /api/pos/offline/catalog  (auth, `desktop_pos` view)

Query: none (always a full snapshot; the shop is small). Response `data`
(final shape, built by `services/sales/offlineSaleService.js catalog`):

```jsonc
{
  "version": "2026-10-28T10:15:00.000Z",   // server time of the snapshot
  "serverTime": "...", "branchId": "<shop branch id>",
  "products": [ {                           // status published OR out_of_stock (offline may sell what shows 0)
      "_id", "name", "slug", "sku", "shortCode",
      "barcode",                             // first barcode, else the short code
      "barcodes": ["8001", "MUGBOX6", ...],  // every scannable code (all units, batches, box/pack codes)
      "codes": [ { "code", "variantId": null | "TEE-R", "qty": 1, "kind": "sku|shortCode|barcode|batch", "batchNo?" } ],
                                             // what each code means = helper/productCodes resolveScan
                                             // (codes are trimmed + UPPERCASE: match the scan the same way)
      "boxCodes": [ { "code", "pieces": 6, "variantId" } ],   // codes with qty > 1: one scan sells N pieces
      "productType": "single" | "variant",
      "price": 280,          // what the server charges per piece (discountedPrice when set and lower, else price)
      "regularPrice": 300,   // list price (info only)
      "category", "categoryName", "thumbnailUrl", "status",
      "stock": 12,           // shop stock at snapshot time (info only)
      "variants": [ { "variantId", "sku", "barcode", "size", "color", "label", "price", "regularPrice", "stock" } ],
      "priceTier": { "_id", "name", "price" } | null      // info only: the product price already IS the tier price
  } ],
  "discountRules": [ { "_id", "name", "kind": "overall|threshold", "valueType": "percentage|fixed", "value",
                       "minSubtotal", "maxDiscount": null | n, "stackable", "priority", "startsAt", "endsAt" } ],
        // switched-on rules that have not ended, sorted priority desc then oldest first.
        // At sale time use only rules with (startsAt null or <= now) and (endsAt null or >= now).
  "taxes": [ { "taxId", "name", "rate", "isDefault" } ],   // the cashier picks taxIds, like online
  "customers": [ { "_id", "name", "phone" } ],              // customers with a phone, newest first, max 2000
  "limits": {
      "maxManualDiscountPct": 10,        // config pos.maxManualDiscountPct
      "unlimitedManualDiscount": false,  // discounts edit
      "canGift": false,                  // pos_gifts create (a gift needs a reason)
      "canEditPrice": false,             // pos edit (typed price)
      "canPriceBelowList": false,        // discounts edit (typed price below the list price)
      "canSellOffline": true,            // desktop_pos create AND pos create
      "maxLines": 300
  },
  "shop": { "name", "currency": "PKR", "logoUrl", "address", "phone", "timezone" },
  "till": { "required": true | false }
}
```

No cost prices are ever in the catalogue.

The frontend's offline pricing (`offlinePricing.ts`) MUST produce the same bill
as `services/sales/pricingService.js computeBill` for the same inputs. The
backend keeps this response shape stable; the frontend ports the maths:

`round2(n) = Math.round(n * 100) / 100` everywhere.
1. Line price = unit `price` (gift lines = 0). A typed price only with `priceOverride: true` and `canEditPrice` (below the list price also needs `canPriceBelowList`).
2. `subtotal = round2(sum(price * qty))` of the NON-gift lines.
3. Rule amount: 0 when subtotal <= 0, or threshold and subtotal < minSubtotal. Percentage = subtotal * min(100, value) / 100, fixed = value; capped by maxDiscount when > 0; then `round2(max(0, min(amount, subtotal)))`.
   Chosen = the best non-stackable rule (largest amount, then higher priority) + every stackable rule with amount > 0; applied in order priority desc, then amount desc, each `round2(min(amount, left))` with `left` (starts at subtotal) going down.
4. Manual discount: base = max(0, round2(subtotal - ruleDiscount)); percentage = base * value / 100, fixed = value; amount = `round2(min(base, that))`. Limit = `round2(subtotal * maxManualDiscountPct / 100)` unless `unlimitedManualDiscount`.
5. `discount = round2(rule + manual)`; `taxable = max(0, round2(subtotal - discount))`; each picked tax `round2(taxable * rate / 100)`; `tax = round2(sum)`; `total = round2(max(0, taxable + tax))`.

## 3. POST /api/pos/offline/orders  (auth, `desktop_pos` create AND `pos` create)

Body:
```jsonc
{
  "deviceId": "uuid of this PC/browser",  "deviceName": "Counter PC",
  "orders": [ {
    "clientId": "uuid v4 made on the PC",          // idempotency key: 8-64 chars of A-Z a-z 0-9 _ -
    "offlineNumber": "OFF-7K2-0012",               // printed on the slip
    "soldAt": "2026-10-28T10:20:31.000Z",          // real time of the sale
    "cashier": "<userId who was signed in>",
    // the same fields POST /api/pos/orders takes:
    "items": [ { "product", "variantId?", "quantity", "scannedCode?", "isGift?", "giftReason?", "priceOverride?", "price?" } ],
    "manualDiscount?": { "type", "value", "reason" }, "taxIds?": [],
    "paymentMethod": "cash|card|split|bank_transfer", "cashAmount?", "isPartialPayment?", "paidAmount?",
    "customer?": "<id>", "customerInfo?": { "name", "phone" }, "notes?",
    // what the PC charged (customer already paid this):
    "bill": { "subtotal", "discount", "tax", "total",
              "lines": [ { "product", "variantId?", "quantity", "unitPrice", "lineTotal", "isGift?" } ] }
                       // lines in the SAME order as items (matched by position)
  } ]
}
```
Max 50 orders per call (more → 400 `TOO_MANY_ORDERS`; none → 400 `NO_ORDERS`); the PC
sends the oldest first, in batches. Batches of about 20 keep each call short on Vercel.

Response `data.results[]` (one per order, same order), HTTP 200:
```jsonc
{ "clientId", "status": "created" | "duplicate" | "failed",
  "orderId", "orderNumber",              // for created and duplicate
  "warnings": [ { "code": "STOCK_SHORT", "product", "variantId?", "name", "short": 3 },
                { "code": "PRICE_DIFF", "serverTotal", "offlineTotal" },
                { "code": "NO_TILL" },
                { "code": "NOT_ALLOWED", "message" } ],   // the user's gift / price / discount rights changed; sale kept
  "error": { "code", "message", "retry": true | false } }   // failed only
```
* `retry: false` = broken data (`BAD_ORDER`, `BAD_CLIENT_ID`, `EMPTY_CART`, `BAD_PAYMENT_METHOD`,
  `BAD_SOLD_AT`, `PRODUCT_NOT_FOUND`, `VARIANT_REQUIRED`, `INVALID_QUANTITY`, `GIFT_REASON_REQUIRED`, ...):
  show it under "Needs attention", do not retry.
* `retry: true` (`SERVER_ERROR`) = server/DB trouble with that one sale: keep it in the outbox and send it
  again later. The other sales of the batch are still handled.
* A whole-call failure is HTTP 5xx (retry later); 401/403 = sign in again.

Server rules:
* **Idempotent**: `POSOrder.clientId` (top level) unique (sparse) index, set on online AND offline sales; offline sales also keep `offline.clientId` (the badge keys off that). Same clientId again → `duplicate` with the existing order (also when two uploads arrive together). Never a second sale.
* **Online sale with the same clientId**: `POST /api/pos/orders` takes an optional `clientId` (same 8-64 char rule, ignored when invalid). If an order with that clientId exists (online or offline), it returns **200** `{ success, duplicate: true, data: <the saved order> }` with no new sale and no stock change (201 = new sale). So: online sale whose reply was lost, then uploaded offline → `duplicate`; offline upload first, then a late online retry → 200 duplicate.
* **The customer already paid**: when the totals differ by > Rs 0.01, the order is saved with the PC's `bill` amounts (total, discount, tax, line prices), a `PRICE_DIFF` warning is added and both totals are stored. When they match, the server's breakdown (rules, taxes) is stored. The server prices with the rules active at `soldAt`. Never reject for price. If the user's rights changed meanwhile (gift / typed price / discount limit) → `NOT_ALLOWED` warning, sale kept.
* **Stock**: deducted like a normal sale, but never rejected for missing stock (offline sale = goods already left the shop). What the shop has is taken; stock stops at 0 (this system never stores stock below 0). Each short line → `STOCK_SHORT` warning (pieces missing), stored on the order. The stock ledger records only the pieces really taken. Cost of sales = the current cost price of every piece sold, shortages included.
* **Time**: `createdAt` / `completedAt` / payment `paidAt` = `soldAt` (more than 5 min in the future → upload time). Server order number is the normal sequence; `offline.number` keeps the OFF- number so a slip can be found (order search matches it).
* **Till**: attach to the cashier's till session that was open at `soldAt`; else their currently open one; else none + `NO_TILL` warning. Never reject for till.
* **Cashier**: `cashier` from the order if it is an active staff login, else the uploading user. `offline.uploadedBy` = uploading user.
* WhatsApp slip queued as for a normal sale.

POSOrder gets: `offline: { clientId, number, deviceId, deviceName, soldAt, uploadedAt, uploadedBy, offlineTotal, serverTotal, warnings[] }` (absent on normal sales; an offline sale = `order.offline?.clientId` is set). The order list/invoice show an "Offline sale" badge.

`GET /api/desktop/session` also returns `features: { attendance, sales }` (= attendance_kiosk view / desktop_pos view),
and `POST /api/desktop/session/renew` accepts either permission.

## 4. Frontend (pos_frontend)

* PWA: `public/manifest.webmanifest` + `public/sw.js` (hand-written, no new deps). Caches the app shell for `/admin/pos` (network-first for the page, cache-first for `/_next/static/*`, fonts, logo, product images best-effort). Registered only on POS pages.
* IndexedDB (`dollarco-pos` db): `catalog` (last snapshot), `outbox` (unsent sales), `meta` (deviceId, counter for OFF numbers, last sync).
* Online: POS works exactly as today; the catalogue refreshes in the background every 5 min and on page load.
* Offline (navigator.onLine false OR the API fails with a network error): products/search/barcode from the catalogue; bill priced by `offlinePricing.ts`; "Complete sale" writes to the outbox and prints the slip with the OFF- number. Disabled offline: refunds, bank transfer screenshot, add new customer (typed name/phone still allowed as customerInfo), held orders on server, sales history/dashboard.
* Sync: on `online` event, on load, and every 30 s while items wait: POST batches to `/api/pos/offline/orders`; remove `created`/`duplicate`; keep `failed retry:false` under "Needs attention". Web Locks / a single-tab lock so two tabs never upload together.
* Header badge: green "Online" / amber "Offline – 3 sales waiting" / red "2 need attention".
* Signed-in session must survive offline: the POS must not redirect to login just because a profile/permission fetch failed with a network error (use the cached user/permissions).

## 5. Desktop app (pos_desktop)

* New **Sales** button on the main screen (shown when the signed-in counter account has `desktop_pos` view). Opens `posUrl` from the config (default `https://pos-one-dollar-store-frontend.vercel.app/admin/pos`) in Microsoft Edge app mode (`msedge --app=<url> --user-data-dir=%LOCALAPPDATA%\DollarCo\PosBrowser`) so it is its own window with its own saved login; falls back to Chrome, then the default browser.
* Config gets `posUrl`; Settings shows it. Local build config points at localhost:3000.
