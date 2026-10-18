// Inventory Controller — admin stock receiving and barcode / short-code tools.
// Stock is always counted in pieces (see helper/productCodes.js).
const mongoose = require('mongoose');
const Product = require('../models/product');
const stockService = require('../services/stockService');
const {
  findProductByCode,
  normalizeCode,
  variantLabel,
  generateShortCode: newShortCode,
  parseMaybeJSON,
  getMainBranchId,
  withBranchStock,
} = require('../helper/productCodes');
const { resolveWriteBranch } = require('../middleware/access');

// The product as the shop sees it: `stock` / batches = the shop's (productCodes.withBranchStock).
const shopView = async (product) => {
  const shopId = await getMainBranchId();
  return withBranchStock(product, shopId, shopId);
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

const sendError = (res, error, fallbackMessage) => {
  const status = error && error.status && error.status >= 400 && error.status < 600 ? error.status : 400;
  return res.status(status).json({
    success: false,
    message:
      (error && (error.isStockError || error.code === 'DUPLICATE_CODE' || status === 403) && error.message) ||
      fallbackMessage,
    error: error && error.message,
    code: error && typeof error.code === 'string' ? error.code : undefined,
    duplicateCode: error && error.duplicateCode,
  });
};

const inventoryController = {
  // POST /products/:id/stock/receive
  // body { variantId?, quantity?, boxes?, loosePieces?, batch?: {batchNo?, barcode?, costPrice?, expiryDate?, note?} }
  // quantity wins; otherwise boxes * piecesPerBox + loosePieces.
  receiveStock: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid product id' });
      const body = req.body || {};
      const batch = parseMaybeJSON(body.batch);
      const branchId = await resolveWriteBranch(req);

      const result = await stockService.receiveStock({
        productId: id,
        variantId: body.variantId || undefined,
        quantity: body.quantity,
        boxes: body.boxes,
        loosePieces: body.loosePieces,
        batch: batch && typeof batch === 'object' ? batch : undefined,
        branchId,
      });
      return res.status(200).json({
        success: true,
        data: await shopView(result.product),
        batch: result.batch, // null when no batch was created (plain stock)
        received: result.quantity,
        variantId: result.variantId,
        branchId: result.branchId,
        message: `Received ${result.quantity} piece(s)${result.batch ? ` into batch ${result.batch.batchNo}` : ''}`,
      });
    } catch (error) {
      console.error('Receive stock error:', error);
      return sendError(res, error, 'Error receiving stock');
    }
  },

  // GET /products/codes/check?code=X&excludeId=Y
  // Is this code free to use (not on any other product)?
  checkCode: async (req, res) => {
    try {
      const code = normalizeCode(req.query.code);
      if (!code) return res.status(400).json({ success: false, message: 'Code is required' });
      const { excludeId } = req.query;

      const filter = { scanCodes: code };
      if (excludeId) {
        if (!isValidId(excludeId)) return res.status(400).json({ success: false, message: 'Invalid excludeId' });
        filter._id = { $ne: excludeId };
      }
      const owner = await Product.findOne(filter, { name: 1 }).lean();
      const result = {
        code,
        available: !owner,
        usedBy: owner ? { productId: owner._id, name: owner.name } : undefined,
      };
      return res.status(200).json({ success: true, ...result, data: result });
    } catch (error) {
      console.error('Check code error:', error);
      return sendError(res, error, 'Error checking code');
    }
  },

  // GET /products/codes/lookup/:code — admin version of the POS scan (any status).
  lookupCode: async (req, res) => {
    try {
      const found = await findProductByCode(req.params.code);
      if (!found) return res.status(404).json({ success: false, message: 'No product uses this code' });

      const { product, match: m } = found;
      const shopId = await getMainBranchId();
      const here = withBranchStock(product, shopId, shopId);
      const unit = m.variant || (product.productType === 'variant' ? null : product);
      // The same unit as the shop sees it (its batches = the shop's batches).
      const hereUnit = m.variantId
        ? (here.variants || []).find((v) => String(v.variantId) === String(m.variantId))
        : product.productType === 'variant' ? null : here;
      const batch =
        m.batchNo && hereUnit ? (hereUnit.batches || []).find((b) => normalizeCode(b.batchNo) === m.batchNo) || null : null;
      const match = {
        variantId: m.variantId || null,
        batchNo: m.batchNo || null,
        qty: m.qty || 1,
        kind: m.kind,
        code: m.code,
        variantLabel: variantLabel(m.variant),
        // pieces in the shop
        available: unit ? stockService.unitAvailable(unit, shopId, shopId) : Math.max(0, Number(here.stock) || 0),
        batch,
      };
      return res.status(200).json({ success: true, data: here, match, message: 'Product found' });
    } catch (error) {
      console.error('Lookup code error:', error);
      return sendError(res, error, 'Error looking up code');
    }
  },

  // GET /products/codes/new-short-code — a free short code to pre-fill a form.
  // Not reserved: it is checked again when the product is saved.
  generateShortCode: async (req, res) => {
    try {
      const shortCode = await newShortCode();
      return res.status(200).json({ success: true, shortCode, data: { shortCode } });
    } catch (error) {
      console.error('Generate short code error:', error);
      return sendError(res, error, 'Error generating short code');
    }
  },
};

module.exports = inventoryController;
