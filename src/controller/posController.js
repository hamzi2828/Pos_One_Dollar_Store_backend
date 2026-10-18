// POS Controller — sales, customers, orders, dashboard stats.
// POS customers share the main User collection so records created here show
// up in /admin/users and vice-versa.
//
// Money is decided HERE, never by the browser: every sale is priced by
// services/sales/pricingService.computeBill() (same code as POST /quote).
const mongoose = require('mongoose');
const Product = require('../models/product');
const User = require('../models/user');
const POSOrder = require('../models/posOrder');
const Category = require('../models/category');
const { PAYMENT_NOTES, PAYMENT_STATUS } = require('../constants/paymentNotes');
const {
  findProductByCode,
  variantLabel,
  normalizeCode,
  getMainBranchId,
  withBranchStock,
  branchStockQuery,
} = require('../helper/productCodes');
const stockService = require('../services/stockService');
const tillService = require('../services/tillService');
const notificationService = require('../services/notificationService');
const locationService = require('../services/inventory/locationService');
const pricing = require('../services/sales/pricingService');
const { orderForViewer, productForViewer, attachShelfCodes } = require('../services/sales/posView');
const Branch = require('../models/branch');
const { resolveWriteBranch } = require('../middleware/access');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The shop the POS sells from (stock is taken from its branch id).
const shopBranch = async (req) => String(await resolveWriteBranch(req));

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc);

const userIdOf = (req) => req.user?._id || req.user?.id || null;

// Error with err.status (pricing / till) -> JSON like the module routes do.
const sendKnownError = (res, err) => {
  res.status(err.status).json({
    success: false,
    message: err.message,
    code: err.code || undefined,
    ...(err.maxManualDiscount !== undefined ? { maxManualDiscount: err.maxManualDiscount, maxManualDiscountPct: err.maxManualDiscountPct } : {}),
  });
};

// Ledger context of an order (StockMovement refType/refId/refNo).
const orderMovement = (order, userId, note) => ({
  refType: 'POSOrder',
  refId: order._id,
  refNo: order.orderNumber,
  userId: userId || null,
  ...(note ? { note } : {}),
});

// Same population everywhere an order is returned.
const loadOrderForResponse = (id) =>
  POSOrder.findById(id)
    .populate('customer', 'firstName lastName email phone')
    .populate('cashier', 'firstName lastName email')
    .populate('items.product', 'name thumbnailUrl bannerUrls price')
    .populate('paymentHistory.receivedBy', 'firstName lastName')
    .populate('branch', 'name code address phone');

// WhatsApp slip: queue it but never let it block or fail the sale / payment.
// The status is written compare-and-set: if the notifications module changed
// it during the call (e.g. to 'sent'), we leave its value alone. A later
// "skipped" (e.g. payment slips switched off) never hides an earlier result.
const WHATSAPP_WAIT_MS = 2500;
const queueReceipt = async (order, event, { resend = false } = {}) => {
  const before = order.whatsappStatus || 'none';
  let result = null;
  try {
    result = await Promise.race([
      notificationService.enqueueOrderReceipt(order, { event, resend }),
      new Promise((resolve) => setTimeout(() => resolve({ queued: false, reason: 'timeout' }), WHATSAPP_WAIT_MS)),
    ]);
  } catch (err) {
    console.error('[pos] whatsapp receipt failed:', err.message);
    result = { queued: false, reason: 'error' };
  }
  const queued = !!(result && result.queued);
  const reason = (result && result.reason) || '';
  const status = queued ? 'queued' : /error|fail|timeout/i.test(reason) ? 'failed' : 'skipped';
  if (before === 'none' || status !== 'skipped' || resend) {
    try {
      const unchanged = before === 'none' ? { $in: [null, 'none'] } : before;
      await POSOrder.updateOne({ _id: order._id, whatsappStatus: unchanged }, { $set: { whatsappStatus: status } });
    } catch (err) {
      console.error('[pos] whatsapp status save failed:', err.message);
    }
  }
  return { queued, reason, status };
};

// Put an order's pieces back into stock exactly once. The stockRestored flag is
// claimed atomically first, so two delete/refund clicks can't restore twice.
// Pieces go back to the ORDER's branch (old orders without one -> the shop).
// Ledger rows carry the order refs.
const restoreOrderStockOnce = async (order, { userId = null, note = '' } = {}) => {
  if (order.stockRestored) return { claimed: false, errors: [] };
  const claim = await POSOrder.updateOne(
    { _id: order._id, stockRestored: { $ne: true } },
    { $set: { stockRestored: true } }
  );
  order.stockRestored = true;
  const modified = claim ? (claim.modifiedCount !== undefined ? claim.modifiedCount : claim.nModified) : 0;
  if (!modified) return { claimed: false, errors: [] };
  const orderBranch = order.branch && order.branch._id ? order.branch._id : order.branch;
  const branchId = orderBranch ? String(orderBranch) : await getMainBranchId();
  const { errors } = await stockService.restoreOrderItems(order.items, {
    branchId,
    movement: orderMovement(order, userId, note),
  });
  return { claimed: true, errors };
};

// Partial / full payment of a NEW sale from the server total.
const paymentPlan = ({ total, paymentMethod, isPartialPayment, paidAmount, cashAmount }) => {
  let paid = total;
  let status = PAYMENT_STATUS.FULL;
  let orderStatus = 'completed';
  if (isPartialPayment && paidAmount !== undefined && paidAmount !== null && paidAmount !== '') {
    paid = Math.min(total, Math.max(0, pricing.round2(Number(paidAmount) || 0)));
    if (total - paid > 0.004) {
      status = paid > 0 ? PAYMENT_STATUS.PARTIAL : PAYMENT_STATUS.PENDING;
      orderStatus = 'pending';
    } else paid = total;
  }
  const pending = pricing.round2(Math.max(0, total - paid));
  const tendered = Number(cashAmount);
  const out = { paid, pending, status, orderStatus, cashAmount: undefined, cardAmount: undefined, changeGiven: undefined };
  if (paymentMethod === 'cash') {
    out.cashAmount = Number.isFinite(tendered) && tendered > 0 ? pricing.round2(tendered) : paid;
    out.changeGiven = pending > 0 ? 0 : pricing.round2(Math.max(0, out.cashAmount - total));
  } else if (paymentMethod === 'bank_transfer') {
    out.changeGiven = pending === 0 && Number.isFinite(tendered) && tendered > total ? pricing.round2(tendered - total) : undefined;
  } else if (paymentMethod === 'card') {
    out.cardAmount = paid;
  } else if (paymentMethod === 'split') {
    // Split = some cash, the rest by card.
    const cash = Math.min(paid, Math.max(0, pricing.round2(Number.isFinite(tendered) ? tendered : 0)));
    out.cashAmount = cash;
    out.cardAmount = pricing.round2(paid - cash);
  }
  return out;
};

const PAYMENT_METHODS = ['cash', 'card', 'split', 'bank_transfer'];

// Body -> pricing input (shared by quote and createOrder so they always agree).
// Manual discount: `manualDiscount: { type, value, reason }`; the old body
// (`discount` amount + `discountReason`) still works as a fixed discount.
const pricingInput = (body, branchId, access) => {
  const manualDiscount =
    body.manualDiscount !== undefined
      ? body.manualDiscount
      : Number(body.discount) > 0
      ? { type: 'fixed', value: Number(body.discount), reason: body.discountReason }
      : null;
  return {
    items: body.items,
    branchId,
    access,
    manualDiscount,
    taxIds: body.taxIds,
    appliedTaxes: body.appliedTaxes,
  };
};

const posController = {
  // GET /api/pos/products — published products with stock > 0 in the shop.
  getProducts: async (req, res) => {
    try {
      const { search, category, limit } = req.query;
      const branchId = await shopBranch(req);
      const mainBranchId = await getMainBranchId();

      const query = {
        status: 'published',
        $and: [branchStockQuery(branchId, mainBranchId)],
      };

      if (category) query.category = category;

      if (search) {
        const searchWords = String(search).trim().split(/\s+/).filter(Boolean);
        if (searchWords.length) {
          const wordPatterns = searchWords.map(escapeRegex);
          const allWordsPattern = wordPatterns.map((w) => `(?=.*${w})`).join('');
          const anyWordPattern = wordPatterns.join('|');
          const raw = escapeRegex(search);

          query.$or = [
            { name: { $regex: allWordsPattern, $options: 'i' } },
            { name: { $regex: anyWordPattern, $options: 'i' } },
            { slug: { $regex: raw, $options: 'i' } },
            { category: { $regex: raw, $options: 'i' } },
            { 'variants.sku': { $regex: raw, $options: 'i' } },
            { tags: { $regex: raw, $options: 'i' } },
            // exact barcode / short code / batch code
            { scanCodes: String(search).trim().toUpperCase() },
          ];
        }
      }

      let productsQuery = Product.find(query).sort({ name: 1 });
      if (limit) productsQuery = productsQuery.limit(parseInt(limit, 10));

      const found = await productsQuery.lean();
      const products = (found || [])
        .map((p) => withBranchStock(p, branchId, mainBranchId))
        .filter((p) => (Number(p.stock) || 0) > 0)
        .map((p) => productForViewer(p, req.access));
      // Where each item lives in the shop (shelf chips on the results).
      await attachShelfCodes(products, branchId);

      return res.status(200).json({
        success: true,
        data: products,
        message: 'Products fetched successfully',
      });
    } catch (error) {
      console.error('Get POS products error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching products', error: error.message });
    }
  },

  // GET /api/pos/products/barcode/:barcode — any scanned/typed code: short code,
  // barcode, box / full-box code, batch code, SKU or slug.
  // data = the product (unchanged for the frontend); match = what the code means.
  // Stock numbers are the shop's (the same stock createOrder sells from).
  getProductByBarcode: async (req, res) => {
    try {
      const { barcode } = req.params;
      const branchId = await shopBranch(req);
      const mainBranchId = await getMainBranchId();
      const found = await findProductByCode(barcode, {
        // out_of_stock included so the cashier sees "out of stock" instead of "not found"
        status: { $in: ['published', 'out_of_stock'] },
      });
      if (!found) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      const { product, match: m } = found;

      // Variant product found by a product-level code (slug) with only one variant -> use it.
      let variant = m.variant;
      let variantId = m.variantId;
      if (!variant && product.productType === 'variant' && (product.variants || []).length === 1) {
        variant = product.variants[0];
        variantId = variant.variantId;
      }
      // Plain copies: stock fields (branchStock, batch.branch) read reliably.
      const plain = toPlain(product);
      let unit = null;
      if (variant) unit = (plain.variants || []).find((v) => String(v.variantId) === String(variantId)) || toPlain(variant);
      else if (product.productType !== 'variant') unit = plain;
      // Product as the shop sees it: stock / variants[].stock / batches.
      const here = productForViewer(withBranchStock(plain, branchId, mainBranchId), req.access);
      const available = unit
        ? Math.max(0, Number(stockService.unitAvailable(unit, branchId, mainBranchId)) || 0)
        : Math.max(0, Number(here.stock) || 0);

      // Batch info (quantity = pieces in the shop).
      let batch = null;
      if (m.batchNo && unit) {
        const hereUnit = variantId
          ? (here.variants || []).find((v) => String(v.variantId) === String(variantId))
          : here;
        const b = ((hereUnit && hereUnit.batches) || []).find((x) => normalizeCode(x.batchNo) === m.batchNo);
        if (b) {
          batch = { batchNo: b.batchNo, quantity: b.quantity, expiryDate: b.expiryDate };
          if (pricing.canSeeCost(req.access)) batch.costPrice = b.costPrice;
        }
      }

      // Shelves of this unit: "A1-S2 (12), warehouse 30".
      let location = null;
      try {
        const rows = await locationService.getProductLocations(product._id, { branchId });
        const codes = (r) => r.shelves.filter((s) => s.qty > 0 || s.isHome).map((s) => s.code);
        const rowOf = (vid) => rows.find((r) => (r.variantId || null) === (vid ? String(vid) : null));
        const row = rowOf(variantId);
        if (row) {
          location = {
            shelves: [...row.shelves].sort((a, b) => Number(b.isHome) - Number(a.isHome) || b.qty - a.qty),
            shelved: row.shelved,
            warehouse: row.warehouse,
          };
        }
        here.shelfCodes = [...new Set(rows.flatMap(codes))];
        if (Array.isArray(here.variants)) {
          here.variants = here.variants.map((v) => ({ ...v, shelfCodes: rowOf(v.variantId) ? codes(rowOf(v.variantId)) : [] }));
        }
      } catch (locErr) {
        console.error('[pos] shelf lookup failed:', locErr.message);
      }

      const match = {
        variantId: variantId || null,
        batchNo: m.batchNo || null,
        qty: m.qty || 1, // pieces one scan of this code sells (full-box code = piecesPerBox)
        kind: m.kind,
        code: m.code,
        variantLabel: variantLabel(variant),
        available,
        batch,
        location,
        shelfCodes: location ? location.shelves.filter((s) => s.qty > 0 || s.isHome).map((s) => s.code) : [],
        // Sale price the server will charge for this unit.
        price: pricing.unitSalePrice(unit || plain, plain.price),
      };

      const label = match.variantLabel ? `${product.name} (${match.variantLabel})` : product.name;
      if (available <= 0) {
        return res.status(400).json({
          success: false,
          data: here,
          match,
          message: `${label} is out of stock`,
        });
      }
      if (available < match.qty) {
        return res.status(400).json({
          success: false,
          data: here,
          match,
          message: `Not enough stock for ${label}. Available: ${available}, this code sells ${match.qty}`,
        });
      }
      return res.status(200).json({ success: true, data: here, match, message: 'Product fetched successfully' });
    } catch (error) {
      console.error('Get product by barcode error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching product', error: error.message });
    }
  },

  // GET /api/pos/categories — distinct category list
  getCategories: async (req, res) => {
    try {
      let categoryNames = [];
      try {
        const categories = await Category.find().select('name').sort({ name: 1 });
        categoryNames = categories.map((c) => c.name).filter(Boolean);
      } catch (_) {
        // Fallback to distinct on Product if Category schema lookup fails
      }
      if (!categoryNames.length) {
        categoryNames = await Product.distinct('category', { status: 'published' });
        categoryNames = categoryNames.filter(Boolean).sort();
      }
      return res.status(200).json({ success: true, data: categoryNames, message: 'Categories fetched successfully' });
    } catch (error) {
      console.error('Get categories error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching categories', error: error.message });
    }
  },

  // GET /api/pos/customers — active POS customers
  getCustomers: async (req, res) => {
    try {
      const customers = await User.find({
        isActive: true,
        isDeleted: { $ne: true },
        role: { $ne: 'admin' },
      })
        .select('firstName lastName email phone customerType source role')
        .sort({ firstName: 1 });
      return res.status(200).json({ success: true, data: customers, message: 'Customers fetched successfully' });
    } catch (error) {
      console.error('Get customers error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customers', error: error.message });
    }
  },

  // GET /api/pos/customers/search?q=
  searchCustomers: async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) return posController.getCustomers(req, res);

      const raw = escapeRegex(q);
      const customers = await User.find({
        isActive: true,
        isDeleted: { $ne: true },
        role: { $ne: 'admin' },
        $or: [
          { firstName: { $regex: raw, $options: 'i' } },
          { lastName: { $regex: raw, $options: 'i' } },
          { email: { $regex: raw, $options: 'i' } },
          { phone: { $regex: raw, $options: 'i' } },
        ],
      })
        .select('firstName lastName email phone customerType source')
        .sort({ firstName: 1 })
        .limit(20);

      return res.status(200).json({ success: true, data: customers, message: 'Customers fetched successfully' });
    } catch (error) {
      console.error('Search customers error:', error);
      return res.status(400).json({ success: false, message: 'Error searching customers', error: error.message });
    }
  },

  // GET /api/pos/customers/:id
  getCustomerById: async (req, res) => {
    try {
      const customer = await User.findById(req.params.id).select('firstName lastName email phone customerType source');
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }
      return res.status(200).json({ success: true, data: customer, message: 'Customer fetched successfully' });
    } catch (error) {
      console.error('Get customer by ID error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customer', error: error.message });
    }
  },

  // POST /api/pos/customers — find by email or phone, otherwise create.
  // Email is required (matches the /admin/users profile flow).
  createOrFindCustomer: async (req, res) => {
    try {
      const { firstName, lastName, email, phone } = req.body;
      if (!firstName || !firstName.trim()) {
        return res.status(400).json({ success: false, message: 'Customer name is required' });
      }
      if (!phone || !String(phone).trim()) {
        return res.status(400).json({ success: false, message: 'Mobile number is required' });
      }
      const phoneDigits = String(phone).replace(/\D/g, '');
      if (phoneDigits.length < 7) {
        return res.status(400).json({ success: false, message: 'Enter a valid mobile number' });
      }
      // E-mail is optional at the counter. User.email is required + unique, so a
      // customer without one gets an internal placeholder built from the phone.
      const typedEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : '';
      if (typedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address' });
      }
      const normalizedEmail = typedEmail || `${phoneDigits}@customer.dollarandco.local`;

      // A shop knows its customers by mobile number: phone first, then e-mail.
      let customer = await User.findOne({ phone: String(phone).trim(), isDeleted: { $ne: true } });
      if (!customer) {
        customer = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } });
      }

      if (customer) {
        // Back-fill phone if it was missing before.
        if (!customer.phone) {
          customer.phone = phone.trim();
          await customer.save();
        }
        return res.status(200).json({ success: true, data: customer, message: 'Existing customer found', isNew: false });
      }

      customer = new User({
        firstName: firstName.trim(),
        lastName: lastName?.trim() || 'Customer',
        email: normalizedEmail,
        role: 'user',
        phone: phone.trim(),
        customerType: 'walk-in',
        isActive: true,
      });
      await customer.save();

      return res.status(201).json({ success: true, data: customer, message: 'Customer created successfully', isNew: true });
    } catch (error) {
      console.error('Create/find customer error:', error);
      return res.status(400).json({ success: false, message: 'Error creating customer', error: error.message });
    }
  },

  // POST /api/pos/quote — cart preview. Exactly the calculation createOrder
  // will use (DB prices, discount rules, manual discount limit, tax).
  // Body: { items, manualDiscount?: { type, value, reason }, taxIds?: [] }
  quote: async (req, res) => {
    try {
      const branchId = await shopBranch(req);
      const bill = await pricing.computeBill(pricingInput(req.body || {}, branchId, req.access));
      return res.status(200).json({ success: true, data: pricing.publicBill(bill, req.access) });
    } catch (error) {
      if (error.status) return sendKnownError(res, error);
      console.error('POS quote error:', error);
      return res.status(500).json({ success: false, message: 'Could not price the cart', error: error.message });
    }
  },

  // POST /api/pos/orders — create a sale.
  //   1. price it on the server (client prices / costs / totals are ignored)
  //   2. till must be open when the store requires it (409 TILL_NOT_OPEN)
  //   3. deduct stock with ledger rows pointing at this order
  //   4. save; then till bookkeeping + WhatsApp slip (never fail the sale)
  // Body: { items: [{ product, variantId?, quantity, batchNo?, scannedCode?, isGift?, giftReason?,
  //         priceOverride?, price? }], manualDiscount?, taxIds?,
  //         expectedTotal?, paymentMethod, cashAmount?, isPartialPayment?, paidAmount?,
  //         bankTransferScreenshot?, customer?, customerInfo?, notes? }
  createOrder: async (req, res) => {
    const body = req.body || {};
    try {
      const cashierId = userIdOf(req);
      if (!cashierId) {
        return res.status(401).json({ success: false, message: 'Authentication required - cashier not found' });
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ success: false, message: 'Order must have at least one item' });
      }
      const { paymentMethod } = body;
      if (!paymentMethod) {
        return res.status(400).json({ success: false, message: 'Payment method is required' });
      }
      if (!PAYMENT_METHODS.includes(paymentMethod)) {
        return res.status(400).json({ success: false, message: 'Unknown payment method' });
      }

      // The shop's branch id: stamped on the sale, stock is taken from it.
      const branchId = await shopBranch(req);

      // 1. Server-side bill.
      let bill;
      try {
        bill = await pricing.computeBill(pricingInput(body, branchId, req.access));
      } catch (err) {
        if (err.status) return sendKnownError(res, err);
        throw err;
      }
      // The cashier confirmed a total; if it changed meanwhile (price edit, rule ended) stop and show the new one.
      if (body.expectedTotal !== undefined && body.expectedTotal !== null && body.expectedTotal !== '') {
        const expected = Number(body.expectedTotal);
        if (!Number.isFinite(expected) || Math.abs(expected - bill.total) > 0.01) {
          return res.status(409).json({
            success: false,
            code: 'TOTAL_CHANGED',
            message: `The bill total is now Rs ${bill.total.toLocaleString('en-PK')}. Check the cart and confirm again.`,
            data: pricing.publicBill(bill, req.access),
          });
        }
      }

      // 2. Till session (cash drawer). 409 TILL_NOT_OPEN when one is required.
      let till;
      try {
        till = (await tillService.resolveSaleSession(req)) || {};
      } catch (err) {
        if (err.status) return sendKnownError(res, err);
        throw err;
      }
      const refOf = (x) => (x && x._id ? x._id : mongoose.isValidObjectId(x) ? x : null);
      const session = till.session || null;

      const branchDoc = await Branch.findById(branchId).select('name code').lean();
      const isPartialPayment = !!body.isPartialPayment;
      const plan = paymentPlan({
        total: bill.total,
        paymentMethod,
        isPartialPayment,
        paidAmount: body.paidAmount,
        cashAmount: body.cashAmount,
      });

      // 3. Id + number first, so every ledger row points at this order.
      const refs = { _id: new mongoose.Types.ObjectId(), orderNumber: await POSOrder.generateOrderNumber() };
      const movement = orderMovement(refs, cashierId);
      const orderItems = bill.lines.map(pricing.toOrderItem);

      // Deduct stock FIRST: this checks and reserves the pieces in one safe step,
      // so two counters can never sell the same last piece.
      let deducted;
      try {
        deducted = await stockService.deductOrderItems(orderItems, { branchId, movement });
      } catch (stockErr) {
        if (stockErr.isStockError) {
          return res.status(stockErr.status || 400).json({ success: false, message: stockErr.message, code: stockErr.code });
        }
        throw stockErr;
      }
      orderItems.forEach((item, i) => {
        if (deducted[i]) item.batchAllocations = deducted[i].allocations;
      });

      let order;
      try {
        const historyStatus = isPartialPayment ? plan.status : PAYMENT_STATUS.FULL;
        const note = isPartialPayment ? PAYMENT_NOTES.INITIAL_PARTIAL : PAYMENT_NOTES.FULL;
        const entry = (amount, method) => ({
          amount,
          paymentMethod: method,
          paidAt: new Date(),
          receivedBy: cashierId,
          note,
          paymentStatus: historyStatus,
          bankTransferScreenshot: method === 'bank_transfer' ? body.bankTransferScreenshot : undefined,
        });
        let paymentHistory = [];
        if (plan.paid > 0) {
          paymentHistory =
            paymentMethod === 'split'
              ? [plan.cashAmount > 0 && entry(plan.cashAmount, 'cash'), plan.cardAmount > 0 && entry(plan.cardAmount, 'card')].filter(Boolean)
              : [entry(plan.paid, paymentMethod)];
        }

        order = new POSOrder({
          _id: refs._id,
          orderNumber: refs.orderNumber,
          branch: branchId,
          branchCode: (branchDoc && branchDoc.code) || '',
          customer: mongoose.isValidObjectId(body.customer) ? body.customer : undefined,
          customerInfo: body.customerInfo || undefined,
          items: orderItems,
          subtotal: bill.subtotal,
          tax: bill.tax,
          appliedTaxes: bill.appliedTaxes,
          discount: bill.discount,
          discountType: bill.manual ? bill.manual.type : null,
          discountReason: bill.manual ? bill.manual.reason : '',
          appliedDiscounts: bill.appliedDiscounts.map(({ label, ...d }) => d), // eslint-disable-line no-unused-vars
          cogs: bill.cogs,
          giftCost: bill.giftCost,
          total: bill.total,
          paymentMethod,
          paymentStatus: plan.status,
          orderStatus: plan.orderStatus,
          paidAmount: plan.paid,
          pendingAmount: plan.pending,
          paymentHistory,
          cashAmount: plan.cashAmount,
          cardAmount: plan.cardAmount,
          changeGiven: plan.changeGiven,
          bankTransferScreenshot: paymentMethod === 'bank_transfer' ? body.bankTransferScreenshot : undefined,
          cashier: cashierId,
          cashSession: refOf(session),
          counter: refOf(till.counter),
          notes: body.notes || 'POS Order',
          completedAt: plan.status === PAYMENT_STATUS.FULL ? new Date() : undefined,
        });
        await order.save();
      } catch (saveErr) {
        // Order was not saved -> give the pieces back (same refs).
        await stockService.restoreOrderItems(orderItems, { branchId, movement: { ...movement, note: 'Sale not saved' } });
        throw saveErr;
      }

      // 4. Never fail the sale because of bookkeeping / messaging.
      try {
        await tillService.attachOrder(session, order);
      } catch (tillErr) {
        console.error('[pos] till attachOrder failed:', tillErr.message);
      }
      await queueReceipt(order, 'sale');

      const populatedOrder = await loadOrderForResponse(order._id);
      return res.status(201).json({
        success: true,
        data: orderForViewer(populatedOrder, req.access),
        message: 'Order created successfully',
      });
    } catch (error) {
      console.error('Create POS order error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error creating order',
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  },

  // GET /api/pos/orders
  getOrders: async (req, res) => {
    try {
      const { date, startDate, endDate, paymentMethod, orderType, search } = req.query;
      const query = { isDeleted: { $ne: true } };

      if (startDate && endDate) {
        const rangeStart = new Date(startDate);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(endDate);
        rangeEnd.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: rangeStart, $lte: rangeEnd };
      } else if (date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: startOfDay, $lte: endOfDay };
      }
      if (paymentMethod && paymentMethod !== 'all') query.paymentMethod = paymentMethod;
      if (orderType && orderType !== 'all') query.orderStatus = orderType;
      if (search && String(search).trim()) {
        const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [
          { orderNumber: { $regex: esc, $options: 'i' } },
          { 'customerInfo.name': { $regex: esc, $options: 'i' } },
          { 'customerInfo.phone': { $regex: esc, $options: 'i' } },
        ];
      }

      // Pagination — default 25 per page, matches admin convention.
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limitParam = parseInt(String(req.query.limit || '25'), 10);
      const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 25));
      const skip = (page - 1) * limit;

      // Summary totals should reflect the full filtered set, not just the page.
      const [total, orders, summaryAgg] = await Promise.all([
        POSOrder.countDocuments(query),
        POSOrder.find(query)
          .populate('customer', 'firstName lastName email phone customerType source')
          .populate('cashier', 'firstName lastName email')
          .populate('items.product', 'name thumbnailUrl bannerUrls price')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        POSOrder.aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              totalSales: { $sum: '$total' },
              totalPaid: { $sum: '$paidAmount' },
              totalPending: { $sum: '$pendingAmount' },
              totalDiscount: { $sum: '$discount' },
              totalCogs: { $sum: '$cogs' },
              totalGiftCost: { $sum: '$giftCost' },
            },
          },
        ]),
      ]);

      // Enrich customerInfo with customerType/source if missing. Costs only for dashboard viewers.
      const ordersData = orders.map((o) => orderForViewer(o, req.access));
      const phonesToLookup = ordersData
        .filter((o) => o.customerInfo?.phone && (!o.customerInfo.customerType || !o.customerInfo.source))
        .map((o) => o.customerInfo.phone);
      if (phonesToLookup.length) {
        const customers = await User.find({
          phone: { $in: phonesToLookup },
          isDeleted: { $ne: true },
        }).select('phone customerType source');
        const map = {};
        customers.forEach((c) => (map[c.phone] = { customerType: c.customerType, source: c.source }));
        ordersData.forEach((o) => {
          if (o.customerInfo?.phone && map[o.customerInfo.phone]) {
            if (!o.customerInfo.customerType) o.customerInfo.customerType = map[o.customerInfo.phone].customerType;
            if (!o.customerInfo.source) o.customerInfo.source = map[o.customerInfo.phone].source;
          }
        });
      }

      const s = summaryAgg[0] || { totalSales: 0, totalPaid: 0, totalPending: 0 };

      return res.status(200).json({
        success: true,
        data: ordersData,
        summary: {
          totalOrders: total,
          totalSales: s.totalSales || 0,
          totalPaid: s.totalPaid || 0,
          totalPending: s.totalPending || 0,
          totalDiscount: s.totalDiscount || 0,
          // Cost of sales only for dashboard viewers.
          ...(pricing.canSeeCost(req.access) ? { totalCogs: s.totalCogs || 0, totalGiftCost: s.totalGiftCost || 0 } : {}),
        },
        pagination: { total, page, pages: Math.max(1, Math.ceil(total / limit)), limit },
        message: 'Orders fetched successfully',
      });
    } catch (error) {
      console.error('Get POS orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching orders', error: error.message });
    }
  },

  // GET /api/pos/orders/:id
  getOrderById: async (req, res) => {
    try {
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName')
        .populate('branch', 'name code address phone');
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      return res.status(200).json({ success: true, data: orderForViewer(order, req.access), message: 'Order fetched successfully' });
    } catch (error) {
      console.error('Get order by ID error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching order', error: error.message });
    }
  },

  // GET /api/pos/dashboard/stats
  getDashboardStats: async (req, res) => {
    try {
      const { filter = 'today', startDate, endDate } = req.query;
      const now = new Date();
      let periodStart, periodEnd, comparisonStart, comparisonEnd, periodLabel;

      switch (filter) {
        case 'weekly': {
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 7);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 7);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Week';
          break;
        }
        case 'monthly':
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          comparisonStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Month';
          break;
        case 'custom': {
          if (!startDate || !endDate) {
            return res.status(400).json({ success: false, message: 'Start date and end date are required for custom filter' });
          }
          periodStart = new Date(startDate);
          periodStart.setHours(0, 0, 0, 0);
          periodEnd = new Date(endDate);
          periodEnd.setHours(23, 59, 59, 999);
          const duration = periodEnd.getTime() - periodStart.getTime();
          comparisonEnd = new Date(periodStart);
          comparisonStart = new Date(comparisonEnd.getTime() - duration);
          periodLabel = 'Custom Period';
          break;
        }
        case 'all':
          if (startDate && endDate) {
            periodStart = new Date(startDate);
            periodStart.setHours(0, 0, 0, 0);
            periodEnd = new Date(endDate);
            periodEnd.setHours(23, 59, 59, 999);
          } else {
            periodStart = new Date(2000, 0, 1);
            periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          }
          comparisonStart = periodStart;
          comparisonEnd = periodEnd;
          periodLabel = 'All Time';
          break;
        case 'today':
        default:
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 1);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'Today';
      }

      const periodStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            totalItems: { $sum: { $size: '$items' } },
            avgOrderValue: { $avg: '$total' },
            totalDiscount: { $sum: '$discount' },
          },
        },
      ]);

      const paymentStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, isDeleted: { $ne: true } } },
        { $unwind: { path: '$paymentHistory', preserveNullAndEmptyArrays: false } },
        { $group: { _id: '$paymentHistory.paymentMethod', total: { $sum: '$paymentHistory.amount' } } },
      ]);

      const paymentsByMethod = { cashSales: 0, cardSales: 0, bankSales: 0 };
      paymentStats.forEach((s) => {
        if (s._id === 'cash') paymentsByMethod.cashSales = s.total;
        else if (s._id === 'card') paymentsByMethod.cardSales = s.total;
        else if (s._id === 'bank_transfer') paymentsByMethod.bankSales = s.total;
      });

      const comparisonStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: comparisonStart, $lt: comparisonEnd }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        { $group: { _id: null, totalSales: { $sum: '$total' }, totalOrders: { $sum: 1 } } },
      ]);

      const topProducts = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            totalQuantity: 1,
            totalRevenue: 1,
            productName: { $ifNull: ['$product.name', 'Unknown Product'] },
            productImage: '$product.thumbnailUrl',
          },
        },
      ]);

      const recentOrders = await POSOrder.find({
        orderStatus: 'completed',
        createdAt: { $gte: periodStart, $lt: periodEnd },
        isDeleted: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('customer', 'firstName lastName')
        .populate('cashier', 'firstName lastName')
        .select('orderNumber total paymentMethod createdAt customer cashier');

      const calcChange = (current, previous) => {
        if (!previous || previous === 0) return current > 0 ? 100 : 0;
        return (((current - previous) / previous) * 100).toFixed(1);
      };
      const current = periodStats[0] || { totalSales: 0, totalOrders: 0, totalItems: 0, avgOrderValue: 0, totalDiscount: 0 };
      const previous = comparisonStats[0] || { totalSales: 0, totalOrders: 0 };

      const getComparisonLabel = () => {
        switch (filter) {
          case 'weekly':
            return 'vs last week';
          case 'monthly':
            return 'vs last month';
          case 'custom':
            return 'vs previous period';
          case 'all':
            return 'all time data';
          default:
            return 'vs yesterday';
        }
      };

      return res.status(200).json({
        success: true,
        data: {
          period: {
            totalSales: current.totalSales || 0,
            totalOrders: current.totalOrders || 0,
            totalItems: current.totalItems || 0,
            avgOrderValue: current.avgOrderValue || 0,
            totalDiscount: current.totalDiscount || 0,
            cashSales: paymentsByMethod.cashSales,
            cardSales: paymentsByMethod.cardSales,
            bankSales: paymentsByMethod.bankSales,
            salesChange: calcChange(current.totalSales, previous.totalSales),
            ordersChange: calcChange(current.totalOrders, previous.totalOrders),
          },
          periodLabel,
          comparisonLabel: getComparisonLabel(),
          filter,
          dateRange: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
          topProducts,
          recentOrders,
        },
        message: 'Dashboard stats fetched successfully',
      });
    } catch (error) {
      console.error('Get dashboard stats error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching dashboard stats', error: error.message });
    }
  },

  // GET /api/pos/dashboard/sales-chart
  getSalesChart: async (req, res) => {
    try {
      const { period = '7days' } = req.query;
      const now = new Date();
      let startDate, groupFormat, dateFormat;

      switch (period) {
        case '30days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 30);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
          break;
        case '12months':
          startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - 12);
          groupFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
          dateFormat = 'monthly';
          break;
        case '7days':
        default:
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 7);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
      }

      const salesChart = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: startDate }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        {
          $group: {
            _id: groupFormat,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            cashSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$total', 0] } },
            cardSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$total', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hourlyChart = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: todayStart }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        { $group: { _id: { $hour: '$createdAt' }, totalSales: { $sum: '$total' }, totalOrders: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);

      const paymentDistribution = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: startDate }, orderStatus: 'completed', isDeleted: { $ne: true } } },
        { $group: { _id: '$paymentMethod', totalSales: { $sum: '$total' }, count: { $sum: 1 } } },
      ]);

      return res.status(200).json({
        success: true,
        data: { salesChart, hourlyChart, paymentDistribution, period, dateFormat },
        message: 'Sales chart data fetched successfully',
      });
    } catch (error) {
      console.error('Get sales chart error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching sales chart data', error: error.message });
    }
  },

  // GET /api/pos/orders/pending
  getPendingOrders: async (req, res) => {
    try {
      const { customerId } = req.query;
      const query = {
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
      };
      if (customerId) query.customer = customerId;

      const orders = await POSOrder.find(query)
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName')
        .sort({ createdAt: -1 });

      const totalPending = orders.reduce((sum, o) => sum + (o.pendingAmount || 0), 0);
      const totalPaid = orders.reduce((sum, o) => sum + (o.paidAmount || 0), 0);

      return res.status(200).json({
        success: true,
        data: orders.map((o) => orderForViewer(o, req.access)),
        summary: { totalOrders: orders.length, totalPending, totalPaid, totalAmount: totalPending + totalPaid },
        message: 'Pending orders fetched successfully',
      });
    } catch (error) {
      console.error('Get pending orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching pending orders', error: error.message });
    }
  },

  // POST /api/pos/orders/:id/payment — add payment to existing pending order.
  // Body { amount, paymentMethod, note?, bankTransferScreenshot?, discount? }.
  // A discount here counts towards the same manual discount limit as at the till.
  addPayment: async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, paymentMethod, note, bankTransferScreenshot, discount } = req.body || {};
      const userId = userIdOf(req);

      const paymentAmount = pricing.round2(Number(amount));
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Payment amount must be greater than 0' });
      }
      if (!['cash', 'card', 'bank_transfer'].includes(paymentMethod)) {
        return res.status(400).json({ success: false, message: 'Payment method is required' });
      }
      if (!mongoose.isValidObjectId(id)) return res.status(404).json({ success: false, message: 'Order not found' });

      const order = await POSOrder.findOne({ _id: id, isDeleted: { $ne: true } });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      if (order.paymentStatus === 'refunded' || order.orderStatus === 'refunded')
        return res.status(400).json({ success: false, message: 'Cannot add payment to a refunded order' });
      if (order.orderStatus === 'cancelled')
        return res.status(400).json({ success: false, message: 'Cannot add payment to a cancelled order' });
      if (['completed', 'full'].includes(order.paymentStatus) || !(order.pendingAmount > 0))
        return res.status(400).json({ success: false, message: 'Order is already fully paid' });

      const discountAmount = discount ? pricing.round2(Number(discount)) : 0;
      if (!Number.isFinite(discountAmount) || discountAmount < 0) {
        return res.status(400).json({ success: false, message: 'Enter a valid discount' });
      }
      if (discountAmount > 0) {
        if (discountAmount > order.pendingAmount + 0.001) {
          return res.status(400).json({
            success: false,
            message: `Discount amount (${discountAmount}) exceeds pending amount (${order.pendingAmount})`,
          });
        }
        const limits = await pricing.manualLimits(req.access);
        const manualSoFar = (order.appliedDiscounts || []).length
          ? order.appliedDiscounts.filter((d) => d.kind === 'manual').reduce((s, d) => s + (Number(d.amount) || 0), 0)
          : Number(order.discount) || 0;
        const maxManual = pricing.round2(((Number(order.subtotal) || 0) * limits.maxManualDiscountPct) / 100);
        if (!limits.unlimitedManualDiscount && manualSoFar + discountAmount > maxManual + 0.001) {
          return res.status(403).json({
            success: false,
            code: 'DISCOUNT_LIMIT',
            message: `Manual discount is limited to ${limits.maxManualDiscountPct}% of the bill (Rs ${maxManual.toLocaleString('en-PK')}). Ask a manager.`,
            maxManualDiscount: maxManual,
            maxManualDiscountPct: limits.maxManualDiscountPct,
          });
        }
        order.discount = pricing.round2((order.discount || 0) + discountAmount);
        order.total = pricing.round2(order.total - discountAmount);
        order.pendingAmount = pricing.round2(order.pendingAmount - discountAmount);
        order.appliedDiscounts.push({ rule: null, name: 'Discount at payment', kind: 'manual', valueType: 'fixed', value: discountAmount, amount: discountAmount });
      }

      if (paymentAmount > order.pendingAmount + 0.001) {
        return res.status(400).json({
          success: false,
          message: `Payment amount (${paymentAmount}) exceeds pending amount (${order.pendingAmount})`,
        });
      }

      const newPendingAmount = pricing.round2(Math.max(0, order.pendingAmount - paymentAmount));
      const newPaymentStatus = newPendingAmount <= 0 ? 'completed' : 'partial';

      order.paymentHistory.push({
        amount: paymentAmount,
        paymentMethod,
        paidAt: new Date(),
        receivedBy: userId,
        note: discountAmount > 0 ? `${note || PAYMENT_NOTES.PAYMENT} (Discount: ${discountAmount})` : (note || PAYMENT_NOTES.ADDITIONAL),
        paymentStatus: newPaymentStatus,
        bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined,
      });

      order.paidAmount = pricing.round2((order.paidAmount || 0) + paymentAmount);
      order.pendingAmount = newPendingAmount;
      if (newPendingAmount <= 0) {
        order.paymentStatus = 'completed';
        order.orderStatus = 'completed';
        order.completedAt = new Date();
        order.pendingAmount = 0;
      } else {
        order.paymentStatus = 'partial';
      }

      await order.save();
      await queueReceipt(order, 'payment');

      const populatedOrder = await loadOrderForResponse(order._id);
      return res.status(200).json({
        success: true,
        data: orderForViewer(populatedOrder, req.access),
        message:
          order.paymentStatus === 'completed'
            ? 'Payment completed successfully'
            : 'Payment added successfully',
      });
    } catch (error) {
      console.error('Add payment error:', error);
      return res.status(400).json({ success: false, message: 'Error adding payment', error: error.message });
    }
  },

  // POST /api/pos/orders/:id/whatsapp — send the transaction slip to the WhatsApp group again.
  resendWhatsapp: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Order not found' });
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      const event = (order.paymentHistory || []).length > 1 ? 'payment' : 'sale';
      const r = await queueReceipt(order, event, { resend: true });
      const fresh = await POSOrder.findById(order._id).select('whatsappStatus').lean();
      const whatsappStatus = (fresh && fresh.whatsappStatus) || r.status;
      return res.status(200).json({
        success: true,
        data: { queued: r.queued, reason: r.reason || undefined, whatsappStatus },
        message: r.queued
          ? 'Slip sent to the WhatsApp queue'
          : r.reason === 'not_configured'
          ? 'WhatsApp group is not set up yet'
          : `Slip not sent${r.reason ? ` (${r.reason})` : ''}`,
      });
    } catch (error) {
      console.error('Resend WhatsApp error:', error);
      return res.status(400).json({ success: false, message: 'Could not send the slip', error: error.message });
    }
  },

  // GET /api/pos/customers/:id/pending
  getCustomerPendingOrders: async (req, res) => {
    try {
      const { id } = req.params;
      const orders = await POSOrder.find({
        customer: id,
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
      })
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .sort({ createdAt: -1 });
      const totalPending = orders.reduce((sum, o) => sum + (o.pendingAmount || 0), 0);
      return res.status(200).json({
        success: true,
        data: orders.map((o) => orderForViewer(o, req.access)),
        summary: { totalOrders: orders.length, totalPending },
        message: 'Customer pending orders fetched successfully',
      });
    } catch (error) {
      console.error('Get customer pending orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customer pending orders', error: error.message });
    }
  },

  // DELETE /api/pos/orders/:id — soft delete; puts the pieces back into stock once.
  deleteOrder: async (req, res) => {
    try {
      const userId = userIdOf(req);
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

      let stock = null;
      if (!['refunded', 'cancelled'].includes(order.orderStatus)) {
        stock = await restoreOrderStockOnce(order, { userId, note: 'Order deleted' });
      }
      order.isDeleted = true;
      order.deletedAt = new Date();
      order.deletedBy = userId;
      await order.save();
      return res.status(200).json({
        success: true,
        message: 'Order deleted successfully',
        stockRestored: !!(stock && stock.claimed),
        stockWarnings: stock && stock.errors.length ? stock.errors : undefined,
      });
    } catch (error) {
      console.error('Delete order error:', error);
      return res.status(400).json({ success: false, message: 'Error deleting order', error: error.message });
    }
  },

  // POST /api/pos/orders/:id/refund — body { reason? }. Marks the order refunded
  // and puts its pieces back into stock (only once, ledger rows 'sale_return' with the order refs).
  refundOrder: async (req, res) => {
    try {
      const { reason } = req.body || {};
      const userId = userIdOf(req);
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      if (order.orderStatus === 'refunded' || order.paymentStatus === 'refunded') {
        return res.status(400).json({ success: false, message: 'Order is already refunded' });
      }
      if (order.orderStatus === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Cannot refund a cancelled order' });
      }

      const cleanReason = reason ? String(reason).trim().slice(0, 300) : '';
      const stock = await restoreOrderStockOnce(order, { userId, note: cleanReason ? `Refund: ${cleanReason}` : 'Refund' });

      order.orderStatus = 'refunded';
      order.paymentStatus = 'refunded';
      order.refundedAt = new Date();
      // Who handed the cash back (till closing subtracts it from that person's till).
      order.refundedBy = (req.access && req.access.userId) || userId || null;
      order.pendingAmount = 0; // nothing is owed on a refunded order
      if (cleanReason) {
        order.notes = order.notes ? `${order.notes}\nRefund reason: ${cleanReason}` : `Refund reason: ${cleanReason}`;
      }
      await order.save();

      const populatedOrder = await loadOrderForResponse(order._id);
      return res.status(200).json({
        success: true,
        data: orderForViewer(populatedOrder, req.access),
        stockRestored: !!stock.claimed,
        stockWarnings: stock.errors.length ? stock.errors : undefined,
        message: 'Order refunded successfully',
      });
    } catch (error) {
      console.error('Refund order error:', error);
      return res.status(400).json({ success: false, message: 'Error refunding order', error: error.message });
    }
  },
  // POST /api/pos/upload/screenshot — bank transfer proof upload
  uploadScreenshot: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      const { toPublicPath } = require('../helper/upload');
      // Vercel Blob flow
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        try {
          const { put } = require('@vercel/blob');
          const extMatch = (req.file.originalname || '').match(/\.[a-z0-9]+$/i);
          const ext = extMatch ? extMatch[0] : '';
          const key = `pos/screenshots/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
          const blob = await put(key, req.file.buffer, {
            access: 'public',
            contentType: req.file.mimetype,
            token: process.env.BLOB_READ_WRITE_TOKEN,
          });
          return res.status(200).json({
            success: true,
            data: { url: blob.url, originalFilename: req.file.originalname, uploadedAt: new Date().toISOString() },
            message: 'Screenshot uploaded',
          });
        } catch (e) {
          console.error('Blob upload failed:', e);
        }
      }
      // Local disk flow (default)
      const url = toPublicPath(req.file.filename || req.file.originalname);
      return res.status(200).json({
        success: true,
        data: { url, originalFilename: req.file.originalname, uploadedAt: new Date().toISOString() },
        message: 'Screenshot uploaded',
      });
    } catch (error) {
      console.error('Upload screenshot error:', error);
      return res.status(400).json({ success: false, message: 'Error uploading screenshot', error: error.message });
    }
  },
};

module.exports = posController;
