// src/services/sales/offlineSaleService.js
// Offline sales: the counter POS keeps selling when the internet drops and
// uploads those sales by itself later. Contract: docs/OFFLINE_SALES.md.
//
//   await offline.catalog(access, { branchId })        -> snapshot for GET /api/pos/offline/catalog
//   await offline.uploadOrders(body, { access, branchId }) -> { results } for POST /api/pos/offline/orders
//
// The server stays the single source of truth. An uploaded sale is built like
// posController.createOrder, with these differences (the customer already paid):
//   - saved with the PC's amounts; the server prices it too and adds PRICE_DIFF when they differ
//   - stock may run out: what is there is taken (STOCK_SHORT for the rest), never rejected
//   - createdAt / completedAt / paidAt = the real time of the sale (soldAt)
//   - till = the cashier's session open at soldAt, else their open one, else none (NO_TILL)
//   - the same clientId is never saved twice (unique index on offline.clientId)
const mongoose = require('mongoose');
const Product = require('../../models/product');
const POSOrder = require('../../models/posOrder');
const User = require('../../models/user');
const Branch = require('../../models/branch');
const PriceTier = require('../../models/priceTier');
const DiscountRule = require('../../models/discountRule');
const Settings = require('../../models/settings');
const stockService = require('../stockService');
const tillService = require('../tillService');
const pricing = require('./pricingService');
const { PAYMENT_NOTES, PAYMENT_STATUS } = require('../../constants/paymentNotes');
const { PAYMENT_METHODS, paymentPlan, pricingInput, orderMovement, queueReceipt, CLIENT_ID_RE, findByClientId, isClientIdDuplicate } = require('./saleHelpers');
const { listUnits, unitCodes, unitBranchStock, getMainBranchId, variantLabel } = require('../../helper/productCodes');

const MAX_ORDERS = 50;
const MAX_CUSTOMERS = 2000;
// A PC clock a little ahead is fine; a sale "in the future" is stored at upload time.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const PRICE_TOLERANCE = 0.01;

const { round2, httpError } = pricing;
const isOid = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

// Access that allows everything: used only to PRICE a sale the cashier already
// made offline when their limits changed meanwhile (never to allow a new sale).
const OPEN_ACCESS = { can: () => true };

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

// One sellable unit (single product or a variant) as the offline POS needs it.
function unitOut(unit, product, branchId, mainBranchId) {
  return {
    price: pricing.unitSalePrice(unit, product.price), // what the server charges
    regularPrice: Number(unit.price) || Number(product.price) || 0,
    stock: Math.max(0, Number(unitBranchStock(unit, branchId, mainBranchId)) || 0),
  };
}

/**
 * Full snapshot for the offline POS (docs/OFFLINE_SALES.md section 2).
 * Prices, rules, taxes and limits are exactly what pricingService.computeBill uses.
 */
async function catalog(access, { branchId, now = new Date() } = {}) {
  const mainBranchId = await getMainBranchId();
  const shop = String(branchId || mainBranchId);

  const [products, tiers, rules, settings, customers, limits, tillRequired] = await Promise.all([
    Product.find({ status: { $in: ['published', 'out_of_stock'] } })
      .select(
        'name slug sku shortCode barcodes price discountedPrice category thumbnailUrl productType variants stock branchStock batches priceTier status'
      )
      .sort({ name: 1 })
      .lean(),
    PriceTier.find({}).select('name price').lean(),
    // Rules running now or starting later (the PC checks startsAt / endsAt at sale time).
    DiscountRule.find({ isActive: true, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] })
      .sort({ priority: -1, createdAt: 1 })
      .lean(),
    Settings.getSettings(),
    User.find({ isActive: true, isDeleted: { $ne: true }, role: { $ne: 'admin' }, phone: { $nin: [null, ''] } })
      .select('firstName lastName phone')
      .sort({ updatedAt: -1 })
      .limit(MAX_CUSTOMERS)
      .lean(),
    pricing.manualLimits(access),
    tillService.isTillRequired(shop),
  ]);
  const tierById = new Map(tiers.map((t) => [String(t._id), { _id: String(t._id), name: t.name, price: Number(t.price) || 0 }]));

  const productsOut = products.map((p) => {
    // Every scannable code with what it means (same as helper/productCodes.resolveScan).
    const codes = [];
    for (const { key, unit } of listUnits(p)) {
      for (const c of unitCodes(unit)) {
        codes.push({
          code: c.code,
          variantId: p.productType === 'variant' ? String(key) : null,
          qty: c.qty,
          kind: c.kind,
          ...(c.batchNo ? { batchNo: c.batchNo } : {}),
        });
      }
    }
    const base = unitOut(p, p, shop, mainBranchId);
    const variants =
      p.productType === 'variant'
        ? (p.variants || []).map((v) => ({
            variantId: String(v.variantId),
            sku: v.sku || '',
            barcode: ((v.barcodes || [])[0] || {}).code || v.shortCode || '',
            size: v.size || '',
            color: v.color || '',
            label: variantLabel(v),
            ...unitOut(v, p, shop, mainBranchId),
          }))
        : [];
    return {
      _id: String(p._id),
      name: p.name,
      slug: p.slug || '',
      sku: p.sku || '',
      shortCode: p.shortCode || '',
      barcode: ((p.barcodes || [])[0] || {}).code || p.shortCode || '',
      barcodes: [...new Set(codes.map((c) => c.code))],
      codes,
      boxCodes: codes.filter((c) => c.qty > 1).map((c) => ({ code: c.code, pieces: c.qty, variantId: c.variantId })),
      productType: p.productType === 'variant' ? 'variant' : 'single',
      price: base.price,
      regularPrice: base.regularPrice,
      category: p.category || '',
      categoryName: p.category || '',
      thumbnailUrl: p.thumbnailUrl || '',
      stock: p.productType === 'variant' ? variants.reduce((s, v) => s + v.stock, 0) : base.stock,
      variants,
      priceTier: p.priceTier ? tierById.get(String(p.priceTier)) || null : null,
      status: p.status,
    };
  });

  const can = (key, action) => pricing.canDo(access, key, action);
  return {
    version: now.toISOString(),
    serverTime: now.toISOString(),
    branchId: shop,
    products: productsOut,
    discountRules: rules.map((r) => ({
      _id: String(r._id),
      name: r.name,
      kind: r.kind,
      valueType: r.valueType,
      value: Number(r.value) || 0,
      minSubtotal: Number(r.minSubtotal) || 0,
      maxDiscount: r.maxDiscount === null || r.maxDiscount === undefined ? null : Number(r.maxDiscount),
      stackable: !!r.stackable,
      priority: Number(r.priority) || 0,
      startsAt: r.startsAt || null,
      endsAt: r.endsAt || null,
    })),
    taxes: ((settings && settings.taxes) || [])
      .filter((t) => t && t.taxId && t.isActive !== false)
      .map((t) => ({ taxId: String(t.taxId), name: t.name || '', rate: Number(t.rate) || 0, isDefault: !!t.isDefault })),
    customers: customers.map((c) => ({ _id: String(c._id), name: fullName(c), phone: c.phone || '' })),
    limits: {
      maxManualDiscountPct: limits.maxManualDiscountPct,
      unlimitedManualDiscount: limits.unlimitedManualDiscount, // discounts edit
      canGift: can('pos_gifts', 'create'),
      canEditPrice: can('pos', 'edit'),
      canPriceBelowList: can('discounts', 'edit'),
      canSellOffline: can('desktop_pos', 'create') && can('pos', 'create'),
      maxLines: 300,
    },
    shop: {
      name: (settings && settings.siteName) || '',
      currency: (settings && settings.currency) || 'PKR',
      logoUrl: (settings && settings.logoUrl) || '',
      address: (settings && settings.address) || '',
      phone: (settings && settings.mobileNumber) || '',
      timezone: (settings && settings.timezone) || 'Asia/Karachi',
    },
    till: { required: !!tillRequired },
  };
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

// Broken data -> `failed` with retry:false (the PC shows it under "Needs attention").
const badData = (code, message) => Object.assign(new Error(message), { badData: true, code });

const isDuplicateKey = isClientIdDuplicate;

const duplicateResult = (clientId, existing) => ({
  clientId,
  status: 'duplicate',
  orderId: String(existing._id),
  orderNumber: existing.orderNumber,
  warnings: (existing.offline && existing.offline.warnings) || [],
});

// The cashier written on the order: the PC's signed-in user when it is a staff
// login of this shop, else the uploading user.
async function resolveCashier(raw, uploaderId) {
  if (isOid(raw) && String(raw) !== String(uploaderId)) {
    const u = await User.findOne({
      _id: raw,
      isDeleted: { $ne: true },
      isActive: { $ne: false },
      $or: [{ staffRole: { $ne: null } }, { isSuperAdmin: true }],
    })
      .select('_id')
      .lean();
    if (u) return u._id;
  }
  return uploaderId;
}

function parseSoldAt(raw, now) {
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) throw badData('BAD_SOLD_AT', 'The time of the sale (soldAt) is missing or not a date');
  return d.getTime() > now.getTime() + FUTURE_SLACK_MS ? now : d;
}

// Lines of the PC's bill: { unitPrice, ... } aligned with items when the counts match.
function pcLines(bill, count) {
  const lines = bill && Array.isArray(bill.lines) ? bill.lines : [];
  return lines.length === count ? lines : null;
}

const num = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Price the sale on the server. Permission problems never reject an offline sale. */
async function serverBill(order, { branchId, access, at, warnings }) {
  try {
    return await pricing.computeBill({ ...pricingInput(order, branchId, access), at });
  } catch (err) {
    if (err.status === 403) {
      warnings.push({ code: 'NOT_ALLOWED', message: err.message });
      return pricing.computeBill({ ...pricingInput(order, branchId, OPEN_ACCESS), at });
    }
    if (err.status) throw badData(err.code || 'BAD_ORDER', err.message);
    throw err;
  }
}

/** One uploaded sale -> result row. Throws only for server/DB errors. */
async function uploadOne(order, ctx) {
  const { access, branchId, uploaderId, deviceId, deviceName, now } = ctx;
  const clientId = str(order && order.clientId, 64);
  if (!order || typeof order !== 'object') throw badData('BAD_ORDER', 'The sale is empty');
  if (!CLIENT_ID_RE.test(clientId)) throw badData('BAD_CLIENT_ID', 'The sale has no valid clientId');

  // Same sale saved before (uploaded earlier, or the online sale whose reply was lost) -> never a second sale.
  const existing = await findByClientId(clientId, 'orderNumber offline');
  if (existing) return duplicateResult(clientId, existing);

  if (!Array.isArray(order.items) || order.items.length === 0) throw badData('EMPTY_CART', 'The sale has no items');
  const paymentMethod = order.paymentMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw badData('BAD_PAYMENT_METHOD', 'Unknown payment method');
  const soldAt = parseSoldAt(order.soldAt, now);
  const warnings = [];

  // 1. The server's price (same maths as a normal sale, rules running at soldAt).
  const bill = await serverBill(order, { branchId, access, at: soldAt, warnings });
  const pc = order.bill && typeof order.bill === 'object' ? order.bill : {};
  const offlineTotal = num(pc.total) !== null && num(pc.total) >= 0 ? round2(pc.total) : bill.total;
  const priceDiff = Math.abs(offlineTotal - bill.total) > PRICE_TOLERANCE;
  if (priceDiff) warnings.push({ code: 'PRICE_DIFF', serverTotal: bill.total, offlineTotal });

  // 2. Lines: server lines (cost, sku, category...) with the price the PC charged.
  const orderItems = bill.lines.map(pricing.toOrderItem);
  const lines = pcLines(pc, orderItems.length);
  if (lines) {
    orderItems.forEach((item, i) => {
      const price = num(lines[i] && lines[i].unitPrice);
      if (!item.isGift && price !== null && price >= 0) item.price = round2(price);
    });
  }

  // The customer already paid the PC's bill: amounts are the PC's when they differ.
  const amounts = priceDiff
    ? {
        subtotal: num(pc.subtotal) !== null ? round2(pc.subtotal) : round2(offlineTotal),
        discount: num(pc.discount) !== null ? round2(Math.max(0, pc.discount)) : 0,
        tax: num(pc.tax) !== null ? round2(Math.max(0, pc.tax)) : 0,
        total: offlineTotal,
      }
    : { subtotal: bill.subtotal, discount: bill.discount, tax: bill.tax, total: bill.total };
  const appliedDiscounts = priceDiff
    ? amounts.discount > 0
      ? [{ rule: null, name: 'Discount given on the counter PC (offline)', kind: 'offline', valueType: 'fixed', value: amounts.discount, amount: amounts.discount }]
      : []
    : bill.appliedDiscounts.map(({ label, ...d }) => d); // eslint-disable-line no-unused-vars
  const appliedTaxes = priceDiff
    ? amounts.tax > 0
      ? [{ taxId: 'offline', name: 'Tax (offline)', rate: 0, amount: amounts.tax }]
      : []
    : bill.appliedTaxes;

  // 3. Cashier and till.
  const cashierId = await resolveCashier(order.cashier, uploaderId);
  const till = await tillService.findSessionAt(cashierId, soldAt, { branchId });
  if (!till) warnings.push({ code: 'NO_TILL' });
  const session = till ? till.session : null;

  // 4. Payment (from the amount the customer paid).
  const isPartialPayment = !!order.isPartialPayment;
  const plan = paymentPlan({ total: amounts.total, paymentMethod, isPartialPayment, paidAmount: order.paidAmount, cashAmount: order.cashAmount });

  // 5. Stock: what is there is taken; the rest is recorded as short.
  const refs = { _id: new mongoose.Types.ObjectId(), orderNumber: await POSOrder.generateOrderNumber() };
  const movement = orderMovement(refs, cashierId);
  let deducted;
  try {
    deducted = await stockService.deductOrderItems(orderItems, { branchId, movement, allowShort: true });
  } catch (stockErr) {
    if (stockErr.isStockError && stockErr.status && stockErr.status < 500 && stockErr.code !== 'STOCK_CONFLICT') {
      throw badData(stockErr.code || 'STOCK_ERROR', stockErr.message);
    }
    throw stockErr;
  }
  orderItems.forEach((item, i) => {
    const d = deducted[i];
    if (!d) return;
    item.batchAllocations = d.allocations;
    if (d.short > 0) {
      const line = bill.lines[i];
      warnings.push({ code: 'STOCK_SHORT', product: item.product, variantId: item.variantId, name: line ? line.name : '', short: d.short });
    }
  });
  // Undo exactly what was taken (offline lines may have been short).
  const restoreTaken = (note) =>
    stockService.restoreOrderItems(
      orderItems
        .map((item, i) => ({ ...item, quantity: deducted[i] ? deducted[i].taken : 0 }))
        .filter((item) => item.quantity > 0),
      { branchId, movement: { ...movement, note } }
    );

  // 6. Save.
  const branchDoc = await Branch.findById(branchId).select('code').lean();
  const historyStatus = isPartialPayment ? plan.status : PAYMENT_STATUS.FULL;
  const note = isPartialPayment ? PAYMENT_NOTES.INITIAL_PARTIAL : PAYMENT_NOTES.FULL;
  const entry = (amount, method) => ({ amount, paymentMethod: method, paidAt: soldAt, receivedBy: cashierId, note, paymentStatus: historyStatus });
  let paymentHistory = [];
  if (plan.paid > 0) {
    paymentHistory =
      paymentMethod === 'split'
        ? [plan.cashAmount > 0 && entry(plan.cashAmount, 'cash'), plan.cardAmount > 0 && entry(plan.cardAmount, 'card')].filter(Boolean)
        : [entry(plan.paid, paymentMethod)];
  }
  const info = order.customerInfo && typeof order.customerInfo === 'object' ? order.customerInfo : null;
  const customerInfo = info && (str(info.name) || str(info.phone)) ? { name: str(info.name, 120), phone: str(info.phone, 30) } : undefined;

  const doc = new POSOrder({
    _id: refs._id,
    orderNumber: refs.orderNumber,
    branch: branchId,
    branchCode: (branchDoc && branchDoc.code) || '',
    customer: isOid(order.customer) ? order.customer : undefined,
    customerInfo,
    items: orderItems,
    subtotal: amounts.subtotal,
    tax: amounts.tax,
    appliedTaxes,
    discount: amounts.discount,
    discountType: bill.manual ? bill.manual.type : null,
    discountReason: bill.manual ? bill.manual.reason : '',
    appliedDiscounts,
    cogs: bill.cogs, // current cost of every piece (shortages included)
    giftCost: bill.giftCost,
    total: amounts.total,
    paymentMethod,
    paymentStatus: plan.status,
    orderStatus: plan.orderStatus,
    paidAmount: plan.paid,
    pendingAmount: plan.pending,
    paymentHistory,
    cashAmount: plan.cashAmount,
    cardAmount: plan.cardAmount,
    changeGiven: plan.changeGiven,
    cashier: cashierId,
    cashSession: session ? session._id : null,
    counter: session ? session.counter || null : null,
    notes: str(order.notes, 1000) || 'POS Order (offline)',
    completedAt: plan.status === PAYMENT_STATUS.FULL ? soldAt : undefined,
    createdAt: soldAt,
    clientId, // same unique key as online sales: a late online retry of this sale is caught too
    offline: {
      clientId,
      number: str(order.offlineNumber, 40),
      deviceId,
      deviceName,
      soldAt,
      uploadedAt: now,
      uploadedBy: uploaderId,
      offlineTotal,
      serverTotal: bill.total,
      warnings,
    },
  });
  try {
    await doc.save();
  } catch (saveErr) {
    await restoreTaken(isDuplicateKey(saveErr) ? 'Offline sale uploaded twice' : 'Sale not saved');
    if (isDuplicateKey(saveErr)) {
      // Two uploads of the same sale arrived together: the other one won.
      const winner = await findByClientId(clientId, 'orderNumber offline');
      if (winner) return duplicateResult(clientId, winner);
    }
    throw saveErr;
  }

  // 7. Never fail the sale because of bookkeeping / messaging.
  if (session) {
    try {
      await tillService.attachOrder(session, doc);
    } catch (tillErr) {
      console.error('[pos offline] till attachOrder failed:', tillErr.message);
    }
  }
  await queueReceipt(doc, 'sale');

  return { clientId, status: 'created', orderId: String(doc._id), orderNumber: doc.orderNumber, warnings };
}

/**
 * POST /api/pos/offline/orders. Sales are handled one by one, oldest first.
 * -> { results: [{ clientId, status, orderId?, orderNumber?, warnings, error? }] }
 */
async function uploadOrders(body, { access, branchId, now = new Date() } = {}) {
  const orders = body && Array.isArray(body.orders) ? body.orders : null;
  if (!orders || orders.length === 0) throw httpError(400, 'No sales to upload', 'NO_ORDERS');
  if (orders.length > MAX_ORDERS) throw httpError(400, `Upload at most ${MAX_ORDERS} sales at a time`, 'TOO_MANY_ORDERS');
  await POSOrder.init(); // the unique clientId index must exist before the first insert

  const ctx = {
    access,
    branchId: String(branchId || (await getMainBranchId())),
    uploaderId: access.userId,
    deviceId: str(body.deviceId, 100),
    deviceName: str(body.deviceName, 100),
    now,
  };
  const results = [];
  for (const order of orders) {
    const clientId = str(order && order.clientId, 64);
    try {
      results.push(await uploadOne(order, ctx));
    } catch (err) {
      if (err.badData) {
        results.push({ clientId, status: 'failed', warnings: [], error: { code: err.code, message: err.message, retry: false } });
      } else {
        // Server / database trouble: the PC keeps the sale and tries again later.
        console.error('[pos offline] upload failed for', clientId, err);
        results.push({ clientId, status: 'failed', warnings: [], error: { code: 'SERVER_ERROR', message: 'Could not save this sale right now. It will be sent again.', retry: true } });
      }
    }
  }
  return { results };
}

module.exports = { catalog, uploadOrders, MAX_ORDERS };
