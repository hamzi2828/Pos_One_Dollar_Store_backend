// src/controller/productController.js
// Admin products: list, get, create, update, delete. Stock numbers are the
// shop's (productCodes.withBranchStock with the shop's branch id).
const mongoose = require('mongoose');
const Product = require('../models/product');
const { resolveWriteBranch } = require('../middleware/access');
const { getMainBranchId, withBranchStock, branchStockLevelQuery } = require('../helper/productCodes');
const createProductService = require('../services/products/createProductService');
const updateProductService = require('../services/products/updateProductService');

// 409 for a barcode / short code that is already used (thrown by helper/productCodes.js)
const duplicateCodeResponse = (res, error) =>
  res.status(409).json({
    message: error.message,
    duplicateCode: error.duplicateCode,
    conflictProductId: error.conflictProductId,
  });

// The product as the shop sees it: `stock` / batches = the shop's.
const toView = (product, shopId) => (product ? withBranchStock(product, shopId, shopId) : product);

// Context for the create / update services: stock typed in the form goes to the shop.
const writeOptions = async (req) => ({
  branchId: await resolveWriteBranch(req),
  warnings: [],
  // Who made the change (price-history log).
  userId: req.access.userId,
});

const uniq = (list) => [...new Set(list || [])];

// Status-carrying errors (400 bad input, 409 conflict).
const statusError = (res, error) => {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ message: error.message, code: typeof error.code === 'string' ? error.code : undefined });
  }
  return null;
};

const sendWriteError = (res, error, label) => {
  if (error && error.code === 'DUPLICATE_CODE') return duplicateCodeResponse(res, error);
  if (error && error.code === 11000) return res.status(409).json({ message: 'Slug already exists' });
  if (statusError(res, error)) return undefined;
  console.error(`${label} error:`, error);
  return res.status(400).json({ message: `Error ${label.toLowerCase()}`, error: error.message });
};

const productController = {
  // GET /products?status=&category=&search=&stockLevel=low|out|in&page=&limit=
  listProducts: async (req, res) => {
    try {
      const { status, category, search, stockLevel } = req.query;
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const hasLimit = req.query.limit !== undefined;
      const limitNum = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 12));
      const shopId = await getMainBranchId();

      const filter = {};
      // Stock conditions on the shop's stock.
      const and = [];
      if (status && status !== 'all') {
        if (status === 'out_of_stock') and.push(branchStockLevelQuery(shopId, shopId, 'out'));
        else filter.status = status;
      }
      if (category && category !== 'all') filter.category = category;
      // Stock level filter (used by /admin/products/stock)
      if (['low', 'out', 'in'].includes(stockLevel)) and.push(branchStockLevelQuery(shopId, shopId, stockLevel));

      // Search — use text index for 3+ chars, regex fallback for shorter
      if (search && search.trim()) {
        const s = search.trim();
        const scanCode = s.toUpperCase();
        // Exact barcode / short code / SKU hit (scanner or typed code) wins
        if (await Product.exists({ scanCodes: scanCode })) {
          filter.scanCodes = scanCode;
        } else if (s.length >= 3) {
          filter.$text = { $search: s };
        } else {
          const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          filter.$or = [{ name: rx }, { slug: rx }, { category: rx }];
        }
      }

      if (and.length) filter.$and = and;

      // Exclude heavy fields the list view never renders.
      const findQuery = Product.find(filter, { description: 0, features: 0 })
        .sort({ createdAt: -1 })
        .lean();
      if (hasLimit) findQuery.skip((pageNum - 1) * limitNum).limit(limitNum);

      const [products, total] = await Promise.all([findQuery, Product.countDocuments(filter)]);

      return res.status(200).json({
        message: 'Products fetched successfully',
        data: products.map((p) => toView(p, shopId)),
        pagination: {
          total,
          page: pageNum,
          limit: hasLimit ? limitNum : products.length,
          totalPages: hasLimit ? Math.max(1, Math.ceil(total / limitNum)) : 1,
          hasNextPage: hasLimit ? pageNum * limitNum < total : false,
          hasPreviousPage: pageNum > 1,
        },
      });
    } catch (error) {
      console.error('List products error:', error);
      return res.status(400).json({ message: 'Error fetching products', error: error.message });
    }
  },

  // GET /products/:id
  getProductById: async (req, res) => {
    try {
      const product = mongoose.isValidObjectId(req.params.id) ? await Product.findById(req.params.id) : null;
      if (!product) return res.status(404).json({ message: 'Product not found' });
      return res.status(200).json({ message: 'Product fetched successfully', data: toView(product, await getMainBranchId()) });
    } catch (error) {
      console.error('Get product error:', error);
      return res.status(400).json({ message: 'Error fetching product', error: error.message });
    }
  },

  // POST /products — multipart form (see services/products/createProductService.js)
  createProduct: async (req, res) => {
    try {
      const opts = await writeOptions(req);
      const created = await createProductService.createProduct(req.body || {}, req.files || {}, opts);
      const productId = created && created._id ? String(created._id) : '';
      return res.status(201).json({
        message: 'Product created successfully',
        data: toView(created, await getMainBranchId()),
        ...(opts.warnings.length ? { warnings: uniq(opts.warnings) } : {}),
        // Frontend opens the sticker print flow right after creating
        next: {
          printLabels: `/products/${productId}/labels`,
          labelData: `/products/${productId}/label-data`,
        },
      });
    } catch (error) {
      return sendWriteError(res, error, 'Creating product');
    }
  },

  // PUT /products/:id — multipart form, partial update (see services/products/updateProductService.js)
  updateProduct: async (req, res) => {
    try {
      const opts = await writeOptions(req);
      const updated = await updateProductService.updateProduct(req.params.id, req.body || {}, req.files || {}, opts);
      return res.status(200).json({
        message: 'Product updated successfully',
        data: toView(updated, await getMainBranchId()),
        ...(opts.warnings.length ? { warnings: uniq(opts.warnings) } : {}),
      });
    } catch (error) {
      return sendWriteError(res, error, 'Updating product');
    }
  },

  // DELETE /products/:id — soft delete
  deleteProduct: async (req, res) => {
    try {
      const deleted = await Product.softDeleteById(req.params.id, req.access.userId || null);
      if (!deleted) return res.status(404).json({ message: 'Product not found' });
      return res.status(200).json({ message: 'Product deleted successfully', id: req.params.id });
    } catch (error) {
      console.error('Delete product error:', error);
      return res.status(400).json({ message: 'Error deleting product', error: error.message });
    }
  },
};

module.exports = productController;
