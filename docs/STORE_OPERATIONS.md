# Store Operations — architecture & module contracts

One Dollar Store POS (PKR). Prices are fixed points (e.g. Rs 150, Rs 280, Rs 499) while every
product's **cost** is different and changes per shipment, so the system must know the real
**landed cost** of every piece, where every piece is (warehouse / shelf), and how fast it sells.

Stack: Express 5 + Mongoose 8 (`pos_backend`), Next.js 15 + Tailwind (`pos_frontend`).
Money is PKR. Stock is always counted in **pieces**.

---

## 1. The flow of goods (and the documents for each step)

> The shop's day-to-day buying steps (buy → send → check boxes → unpack & enter with tags → shelf now or later)
> are described in `docs/BUYING_FLOW.md`; stock now goes into the warehouse per entry while unpacking.

```
Vendor bill(s) ──► Purchase Order (multi-vendor, cartons, bill photos, charges)
                        │ close + submit builty (transport receipt)
                        ▼
                 Goods Receipt (GRN)  ── receiver verifies each line (received / short / damaged)
                        │ post
                        ▼
   stockService.receiveStock(cost: landed unit cost, movement: purchase_receipt)
                        │  → branch stock +, weighted-average cost, vendor bill in vendor ledger
                        ▼
                    WAREHOUSE  (= branch total − pieces on shelves; nothing to store)
                        │ putaway (locationService.putaway)
                        ▼
                 SHELF  A1-S1 … D20-S4  (LocationStock rows)
                        │ sale / gift / damage / shop use / vendor return
                        ▼
              StockMovement ledger row for every step (who, when, how many, cost, price)
```

Every change of stock goes through **`services/stockService.js`** (safe for two counters at once,
optimistic locking). Every call can carry a `movement` context; the ledger row and shelf
bookkeeping happen automatically (`services/inventory/ledgerHooks.js`). **Never** change
`product.stock` / `branchStock` / `batches` any other way.

---

## 2. Core building blocks (already implemented — use them, do not re-implement)

### Models
| Model | File | What |
|---|---|---|
| Rack | `models/rack.js` | Rack `A1` in a branch: `zone` A, `number` 1, `code` A1, `shelfCount`, soft delete |
| Shelf | `models/shelf.js` | Shelf `A1-S2`: `rack`, `rackCode`, `level`, `code` (unique per branch), `capacity` |
| LocationStock | `models/locationStock.js` | Pieces of a unit on a shelf: `branch, product, variantId, shelf, shelfCode, qty, isHome, firstPlacedAt` |
| StockMovement | `models/stockMovement.js` | Immutable ledger. `type` (see list), `direction`, `quantity`, `qtyChange`, `balanceAfter`, `from/to`, `shelves`, `unitCost`, `unitPrice`, `vendor`, `refType/refId/refNo`, `user`, `occurredAt` |
| VendorLedgerEntry | `models/vendorLedgerEntry.js` | Vendor account rows. `credit` = we owe more, `debit` = we owe less. Void, never delete |
| AppConfig | `models/appConfig.js` | Key/value module settings (`services/configService.js`) |
| PriceChange | `models/priceChange.js` | Sale price / cost change history (`services/priceHistoryService.js`) |
| Sequence | `services/sequenceService.js` | Atomic document numbers `PO-2026-00001` |

Movement types: `opening, purchase_receipt, receive, consignment_in, consignment_return, putaway,
location_move, sale, gift, sale_return, damage, internal_use, vendor_return, adjustment_in,
adjustment_out` (`transfer_out` / `transfer_in` only exist on old multi-branch data).

New fields on existing models:
- **Product** (and each variant): `costPrice` = weighted-average **landed** cost per piece;
  `lastPurchasePrice, lastLandedCost, lastVendor, lastVendorName, lastReceivedAt, lastReceivedQty,
  firstPurchasePrice, firstReceivedAt` (stamped by costed receipts). Product only: `parLevel`,
  `reorderPct`, `priceTier` (ref PriceTier), `isConsignment`, `consignmentVendor`, `consignmentRate`.
- **POSOrder**: items get `isGift`, `giftReason`, `category`; order gets `appliedDiscounts[]`,
  `cogs`, `giftCost`, `cashSession`, `counter`, `whatsappStatus`.
- **Expense**: `source` (`manual | shop_use | till_payout | other`), `sourceType`, `sourceRef`.

### Services
```js
const stockService = require('../services/stockService');
// OUT (any reason). Default type 'adjustment_out'.
await stockService.deductStock({ productId, variantId, quantity, branchId,
  movement: { type: 'damage', refType: 'DamageRecord', refId, refNo, userId, note,
              fromShelfId /* optional */, strategy /* 'shelf_first'|'warehouse_first' */ } });
// IN. Default type 'receive'. `cost` → weighted average + last* fields in the SAME write.
await stockService.receiveStock({ productId, variantId, quantity, branchId,
  cost: { unitCost: 165.52, purchasePrice: 150, vendorId, vendorName },
  movement: { type: 'purchase_receipt', refType: 'GoodsReceipt', refId, refNo, userId, vendorId,
              toShelfId /* optional: straight onto a shelf */ } });
// Orders (POS): rows written only after every line succeeded; isGift lines → 'gift'.
await stockService.deductOrderItems(items, { branchId, movement: { refType: 'POSOrder', refId, refNo, userId } });
await stockService.restoreOrderItems(items, { branchId, movement: { refType: 'POSOrder', refId, refNo, userId } });

const loc = require('../services/inventory/locationService');
await loc.putaway({ branchId, productId, variantId, shelfId, qty, userId, note });   // warehouse → shelf
await loc.moveStock({ branchId, productId, variantId, fromShelfId, toShelfId|null, qty, userId }); // null = to warehouse
await loc.setHomeShelf({ branchId, productId, variantId, shelfId, isHome });
await loc.unitSplit({ branchId, productId, variantId });      // { total, shelved, warehouse }
await loc.getProductLocations(productId, { branchId });      // per branch/unit: total, shelved, warehouse, shelves[]
await loc.getShelfContents(shelfId);                          // products on a shelf

const movements = require('../services/inventory/movementService');
await movements.record({...});  await movements.listForUnit(productId, { variantId, branchId, limit, types });

const { allocateLandedCost, weightedAverage, margin } = require('../services/inventory/costingService');
allocateLandedCost(lines /* [{key, qty, unitPrice, cartons}] */, totalCharges, 'value'|'quantity'|'carton');

const vendorLedger = require('../services/vendorLedgerService');
await vendorLedger.post({ vendorId, type: 'bill', credit: 42000, refType: 'PurchaseOrder', refId, refNo, userId, unique: true });
await vendorLedger.post({ vendorId, type: 'payment', debit: 10000, method: 'cash', reference, userId });
await vendorLedger.getBalance(vendorId);  await vendorLedger.getBalances([ids]);
await vendorLedger.voidEntry(id, { userId, reason });  await vendorLedger.voidByRef(refType, refId, {...});

const config = require('../services/configService');      // get(key, fallback), getMany({k: fallback}), set(key, value, userId)
const { nextNumber } = require('../services/sequenceService'); // await nextNumber('PO')
const priceHistory = require('../services/priceHistoryService'); // log({...}), logProductDiff(before, after, {...}), list(productId)
const { saveUploads } = require('../helper/storeUpload');   // after uploadArray/uploadFields → [urls]
const tillService = require('../services/tillService');            // resolveSaleSession(req), attachOrder(session, order)
const notificationService = require('../services/notificationService'); // enqueueOrderReceipt(order,{event}), notify({...})
```

Pure warehouse rule: **warehouse qty = branch total − sum(shelf rows)**. New receipts and old
stock are in the warehouse until put away. Sales/gifts/damage take off shelves first;
vendor returns and shop use take from the warehouse first. Shelf rows never exceed the total.

---

## 3. Conventions (all modules)

**Routes.** Each module owns ONE file in `src/routes/modules/` (mounted at `/api`). Use
`const { staff, can, superAdmin, handle } = require('./_access')`:
```js
router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list));
router.post('/racks/generate', ...staff, can('racks', 'create'), handle(ctrl.generate));
```
HTTP → action: GET `view`, POST `create`, PUT/PATCH `edit`, DELETE `delete`, exports `export`.
Permission checks BEFORE upload middleware. Permission keys live in
`src/constants/rolePermissions.js` (already added for every module — see §5).

**Controllers** in `src/controller/store/<name>Controller.js`; logic in `src/services/<module>/`.
Throw errors with `err.status` (and optional `err.code`); `handle()` turns them into JSON.

**Responses:** `{ success: true, data, meta? }`; lists are paginated:
`?page=1&limit=25&search=&sort=` → `meta: { page, limit, total, pages }`. Errors:
`{ success: false, message, code? }` with 400 / 403 / 404 / 409.

**One shop.** DOLLAR & Co has ONE shop: `Branch.getMain()` (models/branch.js). Every user
works on it: `req.access.branchId` = the shop's id, `branchFilter(req)` returns `{}` (lists
cover every record), `await resolveWriteBranch(req)` returns the shop's id (stamped on new
records and passed to the stock engine). There are no branch screens, transfers or
`x-branch-id` header.

**Money:** round to 2 decimals (`round2`), unit costs to 4 (`round4`). Never trust totals sent
by the browser — recompute on the server.

**Documents** get numbers from `nextNumber(prefix)`. Status changes are explicit endpoints
(`POST /purchase-orders/:id/close`), not free PUTs. Keep `createdBy`, timestamps and a small
`history: [{ at, by, action, note }]` on workflow documents.

**Soft delete:** new models may use `helper/softDeletePlugin` (auto-filters `isDeleted`).
Ledgers (StockMovement, VendorLedgerEntry) are never deleted.

**Indexes:** add compound indexes that match your list filters + sort.

**Photos:** `uploadArray('photos', 5)` / `uploadFields([...])` from `helper/upload.js`, then
`await saveUploads(req, 'folder')`. Optional everywhere unless stated.

**Notifications:** `notificationService.notify({ type, title, message, level, link, branchId, audience })`
— `audience` is a permission key (e.g. `'goods_receiving'`). It is a stub until the Cash &
Notifications module fills it in — call it anyway.

**Frontend.** Pages under `src/app/(routes)/admin/...` ('use client'). API calls through
`import { storeApi, apiErrorMessage, formatRs, formatDate } from '@/lib/storeApi'`
(global axios). Reuse `@/components/admin/FormBits`
(`Modal, Field, Toggle, ErrorBox, HelpBox, LoadingCard, NoAccessCard, inputClass, primaryBtn,
secondaryBtn`), `react-hot-toast`, `lucide-react` icons, `useAccess()` from
`@/context/AccessContext` (`can(key, action)`, `isSuperAdmin`). Look of
existing pages: white cards, `honey-500` primary colour, `text-sm`, mobile friendly. Hide
buttons the user may not use. Lock buttons while a request runs (no double submit). The
sidebar already links every module page (see §5) — build pages at exactly those paths.

---

## 4. Module ownership (who edits which files)

A module edits ONLY its own files. Shared files listed under "Foundation" are done; if you
need a change there, describe it in your final report instead of editing.

| Module | Backend (pos_backend/src) | Frontend (pos_frontend/src) |
|---|---|---|
| **A. Racks & Warehouse** | `routes/modules/racksRoutes.js`, `controller/store/racks*.js`, `controller/store/locations*.js`, `services/inventory/racksService.js`; may ADD functions to `services/inventory/locationService.js` (never change existing signatures/behaviour); may add fields to `models/rack.js`, `models/shelf.js` | `app/(routes)/admin/inventory/racks/**`, `app/(routes)/admin/inventory/putaway/**`, `components/store/ShelfPicker.tsx` |
| **B. Purchasing** | `routes/modules/purchasingRoutes.js`, `controller/store/purchaseOrder*.js`, `controller/store/receiving*.js`, `models/purchaseOrder.js`, `models/goodsReceipt.js`, `services/purchasing/**` | `app/(routes)/admin/purchasing/**` |
| **C. Vendors** | `routes/modules/vendorsRoutes.js`, `controller/store/vendor*.js`, `controller/store/consignment*.js`, `models/vendor.js` (extend), `models/vendorPayment.js`, `models/vendorReturn.js`, `models/consignment*.js`, `services/vendors/**`; may ADD functions to `services/vendorLedgerService.js` | `app/(routes)/admin/vendors/**`, `components/store/VendorPicker.tsx` |
| **D. POS & Pricing** | `controller/posController.js`, `routes/posRoutes.js`, `routes/modules/salesRoutes.js`, `controller/store/discountRule*.js`, `controller/store/priceTier*.js`, `models/discountRule.js`, `models/priceTier.js`, `services/sales/**`, `controller/heldOrderController.js` | `app/(routes)/admin/pos/**`, `app/(routes)/admin/pos-orders/**`, `app/(routes)/admin/products/discounts/**`, `app/(routes)/admin/products/price-tiers/**`, `app/(routes)/admin/products/components/ProductsNav.tsx`, `app/(routes)/admin/products/components/ProductForm.tsx` (price tier field only) |
| **E. Cash, Counters & Notifications** | `routes/modules/cashRoutes.js`, `controller/store/counter*.js`, `controller/store/till*.js`, `controller/store/notification*.js`, `controller/store/whatsapp*.js`, `models/saleCounter.js`, `models/cashSession.js`, `models/notification.js`, `models/messageOutbox.js`, `services/tillService.js`, `services/notificationService.js`, `services/whatsapp/**`, `vercel.json` (crons only) | `app/(routes)/admin/till/**`, `app/(routes)/admin/counters/**`, `app/(routes)/admin/notifications/**`, `app/(routes)/admin/whatsapp/**`, `app/(routes)/admin/reports/cash-closing/**`, `components/store/TillStatusBar.tsx`, `components/admin/AdminHeader.tsx` (bell) |
| **F. Reports & Category Staff** | `routes/modules/analyticsRoutes.js`, `controller/store/analytics*.js`, `controller/store/categoryAssignment*.js`, `models/categoryAssignment.js`, `models/footfallEntry.js`, `services/analytics/**` | `app/(routes)/admin/reports/{demand,trends,slow-moving,footfall,category-performance,expenses}/**`, `app/(routes)/admin/reports/components/ReportsNav.tsx`, `app/(routes)/admin/hr/category-staff/**` |
| **G. Stock Ops & Product Insights** | `routes/modules/stockOpsRoutes.js`, `controller/store/damage*.js`, `controller/store/shopUse*.js`, `controller/store/stockAdjustment*.js`, `controller/store/stockMovement*.js`, `controller/store/productInsight*.js`, `models/damageRecord.js`, `models/shopUse.js`, `models/stockAdjustment.js`, `services/stockops/**`, `services/products/updateProductService.js` (price-history hook only) | `app/(routes)/admin/inventory/{movements,damages,shop-use,adjustments}/**`, `app/(routes)/admin/reports/stock-timeline/**`, `components/store/ProductInsightPanel.tsx`, `app/(routes)/admin/products/components/all_products/ProductCard.tsx` + `AllProducts.tsx` (insight button only) |
| **H. HR & Assets** | `routes/modules/hrRoutes.js`, `controller/store/employee*.js`, `controller/store/asset*.js`, `controller/store/contract*.js`, `models/employee.js` (extend), `models/asset.js` (extend), `models/assetCategory.js`, `models/contractTemplate.js`, `services/hr/**` | `app/(routes)/admin/hr/employees/**`, `app/(routes)/admin/assets/**` |

**Foundation (done, shared — do not edit):** `constants/rolePermissions.js`, `routes/allRoutes.js`,
`routes/modules/index.js`, `routes/modules/_access.js`, `services/stockService.js`,
`services/inventory/{ledgerHooks,movementService,costingService}.js`, `services/configService.js`,
`services/sequenceService.js`, `services/priceHistoryService.js`, `helper/storeUpload.js`,
models `stockMovement, locationStock, vendorLedgerEntry, appConfig, priceChange, product, posOrder, expense`;
frontend `components/admin/AdminSidebar.tsx`, `lib/storeApi.ts`, roles pages.

---

## 5. Permission keys and page paths

| Key | Page |
|---|---|
| `racks` | `/admin/inventory/racks` |
| `stock_putaway` | `/admin/inventory/putaway` |
| `stock_movements` | `/admin/inventory/movements` |
| `damages` (edit = approve) | `/admin/inventory/damages` |
| `shop_use` | `/admin/inventory/shop-use` |
| `stock_adjustments` | `/admin/inventory/adjustments` |
| `purchase_orders` | `/admin/purchasing/orders` |
| `goods_receiving` | `/admin/purchasing/receiving` |
| `vendors` | `/admin/vendors` (+ `/admin/vendors/[id]` ledger) |
| `vendor_payments` | `/admin/vendors/payments` |
| `consignment` | `/admin/vendors/consignment` |
| `vendor_returns` | `/admin/vendors/returns` |
| `pos`, `pos_orders`, `pos_gifts` | `/admin/pos`, `/admin/pos-orders` |
| `discounts` | `/admin/products/discounts` |
| `price_tiers` | `/admin/products/price-tiers` |
| `till`, `till_verify` | `/admin/till` |
| `sale_counters` | `/admin/counters` |
| `notifications` | `/admin/notifications` |
| `whatsapp` | `/admin/whatsapp` |
| `report_demand` | `/admin/reports/demand` |
| `report_trends` | `/admin/reports/trends` |
| `report_slow_moving` | `/admin/reports/slow-moving` |
| `report_footfall` | `/admin/reports/footfall` |
| `report_category_performance` | `/admin/reports/category-performance` |
| `report_cash_closing` | `/admin/reports/cash-closing` |
| `report_stock_movement` | `/admin/reports/stock-timeline` |
| `report_expenses` | `/admin/reports/expenses` |
| `category_assignments` | `/admin/hr/category-staff` |
| `employees` | `/admin/hr/employees` |
| `assets` | `/admin/assets` |

---

## 6. Cross-module API contracts (build to these exactly)

- **C → everyone:** `GET /api/vendors?search=&isActive=true&page=&limit=` →
  `data: [{ _id, name, phone, contactPerson, city, isConsignment, isActive, balance }]`;
  `GET /api/vendors/:id` → vendor + `balance`. (Until C is done, test with `Vendor.create()`.)
- **A → everyone:** `GET /api/racks` (racks with `shelves[]`), `GET /api/locations/shelves?search=`
  → `data: [{ _id, code, rackCode, level, rackId, name, rackName, capacity, isActive, pieces, products }]`
  for shelf pickers; `GET /api/locations/scan/:code` → `{ kind: 'shelf' | 'product' | 'rack', ... }`
  (a shelf comes with `shelf` and `items`). Frontend: `components/store/ShelfPicker.tsx`
  (`{ value, onChange, placeholder?, autoFocus?, excludeIds?, onPicked?, inputRef? }`,
  shelves cached 60 s — call `invalidateShelfOptions()` after changing shelf stock).
  Shelf picker / scan are readable with racks, stock_putaway, goods_receiving, purchase_orders,
  damages, stock_adjustments, shop_use, stock_movements, vendor_returns or consignment view.
- **G → D:** `components/store/ProductInsightPanel.tsx` (props in the file) backed by
  `GET /api/product-insights/:productId?variantId=`.
- **E → D:** `components/store/TillStatusBar.tsx` (props in the file), `tillService.resolveSaleSession(req)`.
- **E ← D:** `notificationService.enqueueOrderReceipt(order, { event: 'sale' | 'payment' })`.
- **F ← slow moving → C:** link to `/admin/vendors/returns?new=1&productId=...&vendorId=...&qty=...`.
- **F ← demand → B:** link to `/admin/purchasing/orders?new=1&productIds=a,b,c`.
- Sales numbers come from **POSOrder** (completed/pending, not refunded/cancelled, not deleted).
  Stock timing (when received, time in warehouse, when shelved) comes from **StockMovement**.

---

## 7. Testing (never use the real database)

`pos_backend/.env` points at the real Atlas database (`pos_mirpur_dollar_shop`). Do NOT run the
server against it, do NOT run seeders / migrations / scripts. Test with the in-memory harness (real Express app + throwaway
MongoDB): `C:/Users/hamza/AppData/Local/Temp/claude/E--ZeroOne-Inovations-Pos-One-Dollar-Store/e5787762-7645-43aa-aed8-8ed24c1afa9c/scratchpad/harness/harness.js`
(see `core.test.js` next to it). Put your own test in that folder as `<module>.test.js`
and run `node <module>.test.js`. Frontend: `npx tsc --noEmit --incremental false -p .` in
`pos_frontend` (do not run `next build` / `next dev`). No git commits.

---

## 8. Endpoints by module (as built)

All under `/api`, permission-gated per §5.

| Module | Endpoints |
|---|---|
| A. Racks | `racks` (list, get, create, update, delete), `racks/generate`, `racks/labels`, `racks/:id/shelves`, `racks/shelves/:id`; `locations/shelves`, `locations/shelves/:id`, `locations/scan/:code`, `locations/products`, `locations/products/:id`, `locations/warehouse`, `locations/activity`, `locations/putaway` (+ `/bulk`), `locations/move`, `locations/home-shelf` |
| B. Purchasing | `purchase-orders` (+ `meta`, `product-search`, `:id/costing`, `:id/bills`, `:id/bills/:billId/items`, `:id/bills/:billId/new-product`, `:id/charges`, `:id/close`, `:id/reopen`, `:id/cancel`); `receiving` (+ `:id/boxes` (check boxes), `:id/lookup`, `:id/new-product`, `:id/entries` (+ `:entryId` DELETE = undo), `:id/complete` (finish + claims); old counting: `:id/start`, `:id/lines`, `:id/scan`, `:id/photos`) — simple buying flow: see `docs/BUYING_FLOW.md` |
| C. Vendors | `vendors` (+ `:id/status`, `:id/ledger`, `:id/ledger/export`, `:id/ledger/:entryId/void`, `:id/adjustments`, `:id/products`), `vendor-products/search`; `vendor-payments` (+ `banks`, `:id/void`); `vendor-returns` (+ `:id/complete`, `:id/cancel`); `consignments` (+ `summary`, `vendors/:id/stock`, `returns`, `:id/post`, `settlements`, `settlements/:id/void`) |
| D. POS & Pricing | `pos/quote`, `pos/orders` (+ `:id/payment`, `:id/refund`, `:id/whatsapp`), `pos/held-orders`; `discount-rules` (+ `preview`, `:id/active`); `price-tiers` (+ `candidates`, `product/:id`, `:id/assign`, `unassign`) |
| E. Cash & Notifications | `counters` (+ `staff-options`, `check-cutoffs` cron); `till-sessions` (+ `my`, `my/history`, `open`, `:id/close`, `:id/verify`, `:id/dispute`, `report`, `report/export`); `notifications` (+ `unread-count`, `:id/read`, `read-all`); `whatsapp/settings`, `whatsapp/test`, `whatsapp/outbox` (+ retry), `whatsapp/orders/:id/resend` |
| F. Reports | `analytics/demand` (+ `settings`, `export`), `analytics/trends` (+ `product`), `analytics/slow-moving` (+ `settings`), `analytics/expenses`, `analytics/footfall` (+ `entries`), `analytics/category-performance`, `analytics/filters`; `category-assignments` (+ `employees`, `categories`) — every report has `/export` (CSV) |
| G. Stock ops | `stock-ops/lookup/:code`, `stock-ops/products`; `damages` (+ `daily`, `daily/export`, `settings`, `:id/approve`, `:id/reject`); `shop-use` (+ `:id/void`); `stock-adjustments` (+ `:id/apply`, `:id/cancel`); `stock-movements` (+ `export`, `timeline/:productId`); `product-insights/:productId` |
| H. HR & Assets | `employees` (+ `:id/status`, `:id/photo`, `:id/documents` (images or PDF), `:id/contract`, `:id/contract/issue`, `:id/login` (create / unlink the staff login), linkable users); `contract-templates`; `assets` (+ summary, export, maintenance, dispose, photos); `asset-categories` |
| HR time & pay | `shifts`, `holidays` (+ `pakistan`), `roster` (+ `cells`, `copy-week`), `hr-policies` (+ `employees`, `:id/assign`, `:id/default`, `:id/duplicate`), `hr/employees/:id/time-settings` (fingers on file in `fingerprint.list`); `attendance` (board, month sheet, records, `corrections`, overtime approve/reject, fix-before-payroll); `payroll/runs` (+ `:id/regenerate`, `:id/lines/:lineId`, `:id/approve`, `:id/reopen`, `:id/pay`, `:id/export`, `:id/lines/:lineId/payslip`), `payroll/employees`, `salary-advances` (+ `:id/cancel`), `payroll-deductions` (+ `:id/approve`, `:id/waive`) |
| Desktop attendance app | `desktop/session` (+ `renew`), `desktop/employees`, `desktop/fingerprints` (`?updatedSince=`; `POST :employeeId` enrol, `DELETE :employeeId/:finger` remove — also from the employee profile), `desktop/punch` (fingerprint only, offline `at` ≤ 48 h, `clientId` idempotent), `desktop/board` |
| Finance | `investment-partners` (list with each partner's total + share, create, edit, delete only without bills); `investments` (+ `:id`, `export`; partner required; `?partner=<id>|none`; list returns the total and `partners`; bills = images / PDF) |

## 9. Settings (AppConfig keys, `services/configService.js`)

| Key | Default | Used by |
|---|---|---|
| `store.timezone` | `Asia/Karachi` | till cut-offs, daily lists, reports |
| `till.requireOpenSession` | not set = required when the shop has an active counter | POS sale |
| `till.denominations` | 5000 … 1 | till float / closing count |
| `pos.maxManualDiscountPct` | 10 | cashier manual discount limit (unless `discounts` edit) |
| `pricing.lowMarginPct` | 20 | price tiers: low-margin flag |
| `purchasing.minMarginPct` | 15 | PO landed-cost preview warning |
| `purchasing.requireDifferentReceiver` | false | buyer cannot verify own PO |
| `demand.thresholdPct` / `demand.coverDays` | 25 / 30 | demand list |
| `slowMoving.days` / `slowMoving.soldPct` | 30 / 10 | slow-moving report |
| `damages.autoApprove` | false | damage reports |
| `hr.probationMonths` | 3 | contract letter |
| `whatsapp` | disabled | receipt slips (provider, token, group id) |

Deployment notes: set `CRON_SECRET` in Vercel (cron `/api/counters/check-cutoffs`); Vercel Hobby
allows daily crons only. `MONGO_URI` → `pos_mirpur_dollar_shop`.

---

## 10. HR time & pay (shifts, roster, attendance, payroll) — Oct 2026

**Attendance is marked ONLY by fingerprint on the DOLLAR & Co Attendance desktop app** (`pos_desktop`,
`/api/desktop/*`, punch `source: 'device'`); no PIN, no web kiosk, no manual punch. A manager fixes a
forgotten punch with a logged **correction** (reason required) in HR → Attendance. The counter PC is
signed in once by an account with `attendance_kiosk` ("Attendance desktop app").
Owner's rules (default policy):
grace 10 min · 3 lates = 1 day cut · absent = 1 day (salary ÷ 30) · overtime at the normal hourly
rate after manager approval · till shortage cut from the cashier after manager approval.
All rules are **HR Policies** the shop creates (HR → Policies) and assigns per employee.

**Foundation (done, shared — do not change signatures):**
- Models: `shift` (start/end HH:mm, night shifts end next day, breakMinutes), `holiday` (date
  'YYYY-MM-DD'), `rosterEntry` (employee + date → shift | off | leave paid/unpaid/sick),
  `attendanceRecord` (one per employee per shop day: punches, checkIn/out, computed status,
  late/early/worked/overtime minutes, overtimeApproved, corrections, locked), `hrPolicy`,
  `payrollDeduction` (till_shortage | damage | other; pending → approved | waived → applied).
- Employee: `defaultShift`, `hrPolicy`, `payType` monthly|daily, `dailyRate`; existing `weeklyOff`.
  Fingerprints: `models/employeeFingerprint.js` (desktop app; `employee`, `finger`, `template`, `deletedAt`).
- `services/hr/policyService.js`: `getDefault()`, `getPolicy(id)`, `policyFor(employee)`,
  `policiesFor(list)`, `clearCache()` (call after saving a policy).
- `services/hr/scheduleService.js`: `planFor(employees, fromKey, toKey)` → Map id → plans;
  `planForDay(employee, key)`. Order: not employed → roster cell → holiday → weekly off →
  defaultShift → legacy shift times → none.
- `services/hr/attendanceCore.js`: `evaluate(plan, record, policy, now)` (pure rules),
  `punch({ employeeId, at, source, photo, userId, note })`, `recomputeDay`, `recomputeRange`
  (call after roster / policy / holiday / correction changes), `dayView({ dateKey })`,
  `monthSummary(month, { employeeIds, includeDays, now })` → per employee: scheduled days,
  present, lates, half days, absents, missing-outs, offs, holidays, leave (paid/sick within
  quota, unpaidTotal), overtime approved/pending, `daysWorked`, and `cuts` in DAYS
  (`lateCutDays`, `lateCutMinutes`, `absentCutDays`, `halfDayCutDays`, `unpaidLeaveCutDays`).
- Permissions: `shifts`, `hr_policies`, `attendance` (edit = corrections / overtime approval),
  `attendance_kiosk` ("Attendance desktop app" sign-in), `payroll` (edit = approve / pay).
- Payroll approval locks every day of the month (days without a record get a locked placeholder,
  note "Payroll lock"); reopen (super admin, nothing paid) removes them.
- Pages (sidebar already links them): `/admin/hr/roster`, `/admin/hr/policies`,
  `/admin/hr/attendance`, `/admin/hr/payroll`, `/admin/hr/advances`; desktop app in `pos_desktop`.

| Module | Backend | Frontend |
|---|---|---|
| **R. Shifts, roster & policies** | `routes/modules/shiftsRoutes.js`, `controller/store/{shift,holiday,roster,hrPolicy,timeSettings}*.js`, `services/hr/rosterService.js` | `admin/hr/roster/**`, `admin/hr/policies/**`, "Time & pay" card (fingerprint status + Remove) on `admin/hr/employees/**` |
| **A. Attendance** | `routes/modules/attendanceRoutes.js`, `controller/store/attendance*.js`, `services/hr/attendanceService.js` | `admin/hr/attendance/**` |
| **D. Desktop app** | `routes/modules/desktopRoutes.js`, `controller/store/desktop*.js`, `services/hr/desktopService.js`, `models/employeeFingerprint.js` | `pos_desktop/` (C# WinForms) |
| **P. Payroll** | `routes/modules/payrollRoutes.js`, `controller/store/payroll*.js`, `controller/store/salaryAdvance*.js`, `models/payrollRun.js`, `models/salaryAdvance.js`, `services/hr/payrollService.js`, minimal hook in `services/tillService.js` (verify → till-shortage deduction) | `admin/hr/payroll/**`, `admin/hr/advances/**` |
