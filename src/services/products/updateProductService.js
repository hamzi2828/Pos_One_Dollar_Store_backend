// updateProductService.js
// Partial update from the admin product form (multipart). Stock typed in the
// form is the shop's stock.
const Product = require('../../models/product');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Helper function to convert uploaded filename to public path (for local storage)
const toPublicPath = (filename) => {
  if (!filename) return null;
  return `/uploads/${filename}`;
};

// Helper function to normalize URLs (fix malformed URLs like /https://...)
const normalizeUrl = (url) => {
  if (!url) return url;
  // If URL starts with /http, remove the leading slash
  if (url.startsWith('/http')) {
    return url.substring(1);
  }
  return url;
};

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

const {
  normalizeCode,
  normalizeBarcodes,
  normalizeBatches,
  prepareProductCodes,
  buildScanCodes,
  toBranchId,
  sameBranch,
  syncProductBranchStock,
} = require('../../helper/productCodes');
const {
  helpers: {
    toBool,
    hasValue,
    toPiecesPerBox,
    stockFromBoxes,
    generateVariantId,
    generateVariantSKU,
    ensureUniqueSku,
    parseVariantCodeFields,
    branchContext,
  },
} = require('./createProductService');

// Payload fields that affect codes / stock. Only when one of these is sent do we
// load the product and rebuild its codes (prepareProductCodes).
const CODE_FIELDS = [
  'variants', 'productType', 'sku', 'stock', 'shortCode', 'barcodes', 'batches',
  'piecesPerBox', 'boxes', 'loosePieces', 'addFullBoxBarcode', 'name',
];

const MAX_SAVE_ATTEMPTS = 3;

// Price history (services/priceHistoryService.js): payload fields that can
// change a sale price / cost, and what to load to compare before vs after.
const priceHistory = require('../priceHistoryService');
const PRICE_FIELDS = ['price', 'costPrice', 'discountedPrice', 'variants'];
const PRICE_SELECT = 'name price costPrice discountedPrice variants.variantId variants.price variants.costPrice variants.discountedPrice';

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

// Keep a batch's _id when the frontend sends it back without one
// (match by batchNo in the same branch).
const keepBatchIds = (incoming, existing = []) =>
  incoming.map((b) => {
    if (b._id || !b.batchNo) return b;
    const prev = existing.find(
      (e) => normalizeCode(e.batchNo) === b.batchNo && (!b.branch || sameBranch(e.branch, b.branch))
    );
    return prev && prev._id ? { ...b, _id: prev._id } : b;
  });

/**
 * Batches sent in the form for one unit = the shop's batches, merged with the
 * saved ones (ids kept). Batches of an old second branch, if any, stay as they are.
 */
const mergeBatches = (incoming, existing = [], ctx) => {
  const mine = keepBatchIds(incoming.map((b) => ({ ...b, branch: ctx.writeBranchId })), existing);
  const others = existing.filter((b) => !sameBranch(b.branch, ctx.writeBranchId));
  return [...normalizeBatches(others), ...mine];
};

const sumRows = (rows) => (rows || []).reduce((s, r) => s + (Number(r.stock) || 0), 0);

/**
 * New branchStock of a unit without batches: `typed` (stock or boxes + loose
 * pieces) becomes the shop's stock. Nothing typed = unchanged.
 */
const applyStockInput = (prevRows, typed, ctx, label) => {
  const out = (prevRows || []).map((r) => ({ branch: toBranchId(r.branch), stock: Math.max(0, Number(r.stock) || 0) }));
  if (typed === undefined || typed === null || typed === '') return out;
  const n = Number(typed);
  if (!Number.isFinite(n)) return out;
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${label}: stock must be a non-negative integer`);
  let row = out.find((x) => x.branch === ctx.writeBranchId);
  if (!row) {
    row = { branch: ctx.writeBranchId, stock: 0 };
    out.push(row);
  }
  row.stock = n;
  return out;
};

// First batch added to a unit that had loose stock: keep those pieces as an
// "Opening stock" batch (sold first), otherwise stock = sum of batches would
// silently drop them.
const keepOpeningStock = (unit, saved, createdAt) => {
  if (!saved || (saved.batches || []).length) return;
  if (!(unit.batches || []).length) return;
  for (const row of [...(saved.branchStock || [])].reverse()) {
    const looseStock = Number(row.stock) || 0;
    if (looseStock <= 0) continue;
    unit.batches.unshift({
      quantity: looseStock,
      initialQuantity: looseStock,
      receivedAt: createdAt || new Date(0),
      note: 'Opening stock',
      branch: toBranchId(row.branch),
    });
  }
};

// Merge incoming variants with the saved ones (matched by variantId): keep
// variantId / sku / shortCode / barcodes / batches / attributes that were not
// sent. Stock: see applyStockInput.
const mergeVariants = async (incoming, existingVariants, { productName, excludeId, piecesPerBox, ctx, createdAt }) => {
  const byId = new Map((existingVariants || []).map((v) => [v.variantId, v]));
  const merged = incoming.map((variant, i) => {
    const v = { ...variant };
    const prev = v.variantId ? byId.get(v.variantId) : undefined;
    const codeFields = parseVariantCodeFields(v);
    v.color = String(v.color || '').trim();
    v.size = String(v.size || '').trim();

    if ('attributes' in codeFields) v.attributes = codeFields.attributes;
    else v.attributes = prev ? prev.attributes : undefined;

    v.shortCode = codeFields.shortCode || (prev ? prev.shortCode : undefined);

    if ('barcodes' in codeFields) v.barcodes = codeFields.barcodes;
    else v.barcodes = prev ? prev.barcodes || [] : [];

    if ('batches' in codeFields) v.batches = mergeBatches(codeFields.batches, prev ? prev.batches || [] : [], ctx);
    else v.batches = prev ? normalizeBatches(prev.batches || []) : [];

    if (!v.sku && prev && prev.sku) v.sku = prev.sku;

    // Stock: batches win (prepareProductCodes), then boxes + loose pieces, then stock.
    const label = `Variant ${i + 1}`;
    const boxStock = stockFromBoxes(v.boxes, v.loosePieces, piecesPerBox);
    const typed = boxStock !== undefined ? boxStock : v.stock;
    if (v.batches.length) {
      v.branchStock = [];
      keepOpeningStock(v, prev, createdAt);
    } else {
      v.branchStock = applyStockInput(prev ? prev.branchStock : [], typed, ctx, label);
    }
    if (!v.batches.length) v.stock = sumRows(v.branchStock);
    delete v.boxes;
    delete v.loosePieces;
    return v;
  });

  // Generate missing ids / SKUs
  const takenSkus = new Set(merged.map((v) => normalizeCode(v.sku)).filter(Boolean));
  for (let index = 0; index < merged.length; index++) {
    const v = merged[index];
    if (!v.variantId) v.variantId = generateVariantId(productName, v);
    if (!v.sku) v.sku = await ensureUniqueSku(generateVariantSKU(productName, v, index), takenSkus, excludeId);
  }
  return merged;
};

/**
 * Code / stock fields of an update, merged with the saved product `existing`
 * (lean). Returns the $set fields to add (see mergeBatches / applyStockInput).
 */
const buildCodeUpdates = async (id, existing, payload, updates, ctx) => {
  // Old data -> explicit shop branch before merging.
  syncProductBranchStock(existing, { mainBranchId: ctx.mainBranchId });

  const piecesPerBox = hasValue(payload.piecesPerBox)
    ? toPiecesPerBox(payload.piecesPerBox)
    : toPiecesPerBox(existing.piecesPerBox);
  const productName = updates.name || existing.name || 'Product';
  const productType = updates.productType || existing.productType || 'single';

  const merged = {
    productType,
    name: productName,
    sku: 'sku' in updates ? updates.sku : existing.sku,
    // An empty shortCode keeps the saved one (printed stickers stay valid)
    shortCode: normalizeCode(payload.shortCode) || existing.shortCode,
    barcodes: typeof payload.barcodes !== 'undefined'
      ? normalizeBarcodes(payload.barcodes)
      : existing.barcodes || [],
    batches: typeof payload.batches !== 'undefined'
      ? mergeBatches(normalizeBatches(payload.batches), existing.batches || [], ctx)
      : existing.batches || [],
    piecesPerBox,
    stock: existing.stock,
    branchStock: existing.branchStock || [],
  };

  if (productType === 'variant') {
    // Variant stock is set per variant (mergeVariants).
  } else if ((merged.batches || []).length) {
    // Stock comes from the batches; typed stock / boxes are ignored (as before).
    merged.branchStock = [];
    keepOpeningStock(merged, existing, existing.createdAt);
  } else {
    const boxStock = stockFromBoxes(payload.boxes, payload.loosePieces, piecesPerBox);
    const typed = boxStock !== undefined ? boxStock : payload.stock;
    merged.branchStock = applyStockInput(existing.branchStock, typed, ctx, existing.name || 'Product');
    merged.stock = sumRows(merged.branchStock);
  }

  merged.variants = Array.isArray(updates.variants)
    ? await mergeVariants(updates.variants, existing.variants, {
      productName,
      excludeId: id,
      piecesPerBox,
      ctx,
      createdAt: existing.createdAt,
    })
    : existing.variants || [];

  await prepareProductCodes(merged, {
    excludeId: id,
    addFullBoxBarcode: toBool(payload.addFullBoxBarcode),
    // Codes the product already had (e.g. an old SKU shared with another
    // product) don't block editing; only new codes must be unique.
    allowExistingCodes: [...(existing.scanCodes || []), ...buildScanCodes(existing)],
    mainBranchId: ctx.mainBranchId,
    defaultBranchId: ctx.writeBranchId,
  });

  return {
    variants: merged.variants,
    shortCode: merged.shortCode,
    barcodes: merged.barcodes,
    batches: merged.batches,
    piecesPerBox: merged.piecesPerBox,
    stock: merged.stock,
    branchStock: merged.branchStock,
    scanCodes: merged.scanCodes,
  };
};

const updateProductService = {
  /**
   * Update product `id` with the form `payload` + uploaded `files`.
   * opts (from the controller): { branchId (the shop), warnings[], userId }.
   * Returns the updated product document.
   */
  updateProduct: async (id, payload, files, opts = {}) => {
    // Initialize colorMedia from payload
    let colorMedia = null;

    // Parse colorMedia if it's a string
    if (typeof payload.colorMedia === 'string') {
      try {
        colorMedia = JSON.parse(payload.colorMedia);
      } catch (error) {
        console.error('Failed to parse colorMedia JSON:', error);
        colorMedia = null;
      }
    } else if (payload.colorMedia && typeof payload.colorMedia === 'object') {
      colorMedia = payload.colorMedia;
    }

    // Process files - use Vercel Blob or local storage
    let blobThumbnailUrl = null;
    let blobBannerUrls = [];

    if (USE_BLOB_STORAGE && blobUpload) {
      const blobResult = await blobUpload.processProductFiles(files);

      if (blobResult.thumbnailUrl) {
        blobThumbnailUrl = blobResult.thumbnailUrl;
      }
      if (blobResult.bannerUrls.length) {
        blobBannerUrls = blobResult.bannerUrls;
      }
      if (Object.keys(blobResult.colorMedia).length) {
        if (!colorMedia) colorMedia = {};
        colorMedia = { ...colorMedia, ...blobResult.colorMedia };
      }
    } else {
      // Local storage - Process new color-specific media files
      if (files.colorThumbnail || files.colorBanner) {
        // Initialize colorMedia if not already present
        if (!colorMedia) colorMedia = {};

        // Process color thumbnails
        if (files.colorThumbnail) {
          const thumbFiles = Array.isArray(files.colorThumbnail) ? files.colorThumbnail : [files.colorThumbnail];
          thumbFiles.forEach(file => {
            // Extract color from filename (format: color_originalname.ext)
            const colorMatch = file.originalname.match(/^([^_]+)_/);
            if (colorMatch) {
              const color = colorMatch[1];
              if (!colorMedia[color]) colorMedia[color] = { bannerUrls: [] };
              colorMedia[color].thumbnailUrl = toPublicPath(file.filename);
            }
          });
        }

        // Process color banners
        if (files.colorBanner) {
          const bannerFiles = Array.isArray(files.colorBanner) ? files.colorBanner : [files.colorBanner];
          bannerFiles.forEach(file => {
            // Extract color from filename
            const colorMatch = file.originalname.match(/^([^_]+)_/);
            if (colorMatch) {
              const color = colorMatch[1];
              if (!colorMedia[color]) colorMedia[color] = { bannerUrls: [] };
              if (!colorMedia[color].bannerUrls) colorMedia[color].bannerUrls = [];

              // Add new banner URL to existing banners
              const newBannerUrl = toPublicPath(file.filename);
              colorMedia[color].bannerUrls.push(newBannerUrl);
            }
          });
        }
      }
    }

    // Process existingColorThumbnails and existingColorBanners
    // These come as arrays of JSON strings, so we need to parse them
    if (payload.existingColorThumbnails && !colorMedia) {
      colorMedia = {};
    }

    if (payload.existingColorThumbnails) {
      const thumbsArray = Array.isArray(payload.existingColorThumbnails)
        ? payload.existingColorThumbnails
        : [payload.existingColorThumbnails];

      thumbsArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.url) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            // Only set if we don't have a new thumbnail for this color
            if (!colorMedia[parsed.color].thumbnailUrl) {
              colorMedia[parsed.color].thumbnailUrl = parsed.url;
            }
          }
        } catch (e) {
          console.error('Error parsing existingColorThumbnails item:', e);
        }
      });
    }

    if (payload.existingColorBanners) {
      const bannersArray = Array.isArray(payload.existingColorBanners)
        ? payload.existingColorBanners
        : [payload.existingColorBanners];

      bannersArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.urls) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            // Merge existing banners with any new ones (put existing first)
            const existingBanners = parsed.urls || [];
            const newBanners = colorMedia[parsed.color].bannerUrls || [];
            // Filter out existing URLs to avoid duplicates
            const existingUrls = existingBanners.filter(url => !newBanners.includes(url));
            colorMedia[parsed.color].bannerUrls = [...existingUrls, ...newBanners].slice(0, 5);
          }
        } catch (e) {
          console.error('Error parsing existingColorBanners item:', e);
        }
      });
    }

    // Build updates object
    const updates = {};

    if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
    if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
    if (typeof payload.category !== 'undefined') updates.category = String(payload.category).trim();
    if (typeof payload.subCategory !== 'undefined') {
      const sub = String(payload.subCategory).trim();
      updates.subCategory = sub ? sub : undefined;
    }
    if (typeof payload.price !== 'undefined') updates.price = Number(payload.price);
    if (typeof payload.discountedPrice !== 'undefined') {
      updates.discountedPrice = payload.discountedPrice === null ? undefined : Number(payload.discountedPrice);
    }
    if (typeof payload.stock !== 'undefined') updates.stock = Number(payload.stock);
    if (typeof payload.piecesPerSale !== 'undefined' && payload.piecesPerSale !== '') {
      const pps = Math.floor(Number(payload.piecesPerSale));
      updates.piecesPerSale = Number.isFinite(pps) && pps >= 1 ? pps : 1;
    }
    if (typeof payload.status !== 'undefined') updates.status = String(payload.status);
    if (typeof payload.featured !== 'undefined') updates.featured = payload.featured === 'true' || payload.featured === true;

    // Handle description fields
    if (typeof payload.description !== 'undefined') {
      updates.description = payload.description ? String(payload.description).trim() : undefined;
    }
    if (typeof payload.shortDescription !== 'undefined') {
      updates.shortDescription = payload.shortDescription ? String(payload.shortDescription).trim() : undefined;
    }
    if (typeof payload.features !== 'undefined') {
      updates.features = payload.features ? String(payload.features).trim() : undefined;
    }

    // Handle dimension fields (L x W x H)
    if (typeof payload.dimensionLength !== 'undefined') {
      updates.dimensionLength = payload.dimensionLength ? String(payload.dimensionLength).trim() : undefined;
    }
    if (typeof payload.dimensionWidth !== 'undefined') {
      updates.dimensionWidth = payload.dimensionWidth ? String(payload.dimensionWidth).trim() : undefined;
    }
    if (typeof payload.dimensionHeight !== 'undefined') {
      updates.dimensionHeight = payload.dimensionHeight ? String(payload.dimensionHeight).trim() : undefined;
    }

    // Handle weight field
    if (typeof payload.weight !== 'undefined') {
      updates.weight = payload.weight ? String(payload.weight).trim() : undefined;
    }

    // Handle sku field (top-level, for single products)
    if (typeof payload.sku !== 'undefined') {
      updates.sku = payload.sku ? String(payload.sku).trim() : undefined;
    }

    // Handle costPrice field (top-level, for single products)
    if (typeof payload.costPrice !== 'undefined') {
      const cp = payload.costPrice;
      updates.costPrice = cp === '' || cp === null ? undefined : Number(cp);
    }

    // Handle thumbnail - check for new upload or existing
    if (USE_BLOB_STORAGE && blobThumbnailUrl) {
      updates.thumbnailUrl = blobThumbnailUrl;
    } else if (files.thumbnail && files.thumbnail[0]) {
      updates.thumbnailUrl = toPublicPath(files.thumbnail[0].filename);
    } else if (payload.existingThumbnail) {
      updates.thumbnailUrl = normalizeUrl(payload.existingThumbnail);
    } else if (typeof payload.thumbnailUrl !== 'undefined') {
      updates.thumbnailUrl = payload.thumbnailUrl ? normalizeUrl(String(payload.thumbnailUrl).trim()) : undefined;
    }

    // Handle banner images
    if (USE_BLOB_STORAGE && blobBannerUrls.length > 0) {
      let existingBanners = [];
      if (payload.existingBanners) {
        try {
          existingBanners = JSON.parse(payload.existingBanners);
          if (!Array.isArray(existingBanners)) existingBanners = [];
          existingBanners = existingBanners.map(u => normalizeUrl(String(u)));
        } catch (e) {
          console.error('Error parsing existingBanners:', e);
        }
      }
      updates.bannerUrls = [...existingBanners, ...blobBannerUrls].slice(0, 5);
    } else if (files.banners && files.banners.length > 0) {
      const uploadedBanners = files.banners.map(f => toPublicPath(f.filename));

      let existingBanners = [];
      if (payload.existingBanners) {
        try {
          existingBanners = JSON.parse(payload.existingBanners);
          if (!Array.isArray(existingBanners)) existingBanners = [];
          existingBanners = existingBanners.map(u => normalizeUrl(String(u)));
        } catch (e) {
          console.error('Error parsing existingBanners:', e);
        }
      }

      updates.bannerUrls = [...existingBanners, ...uploadedBanners].slice(0, 5);
    } else if (payload.existingBanners) {
      try {
        updates.bannerUrls = JSON.parse(payload.existingBanners);
        if (!Array.isArray(updates.bannerUrls)) updates.bannerUrls = [];
        updates.bannerUrls = updates.bannerUrls.slice(0, 5).map(u => normalizeUrl(String(u)));
      } catch (e) {
        console.error('Error parsing existingBanners:', e);
        updates.bannerUrls = [];
      }
    } else if (typeof payload.bannerUrls !== 'undefined') {
      updates.bannerUrls = Array.isArray(payload.bannerUrls)
        ? payload.bannerUrls.slice(0, 5).map((u) => normalizeUrl(String(u)))
        : [];
    }

    if (typeof payload.productType !== 'undefined') {
      updates.productType = payload.productType === 'variant' ? 'variant' : 'single';
    }


    // Parse variants if it's a string
    if (typeof payload.variants === 'string') {
      try {
        updates.variants = JSON.parse(payload.variants);
      } catch (error) {
        console.error('Failed to parse variants JSON:', error);
        updates.variants = [];
      }
    } else if (Array.isArray(payload.variants)) {
      updates.variants = payload.variants;
    }

    // Process variants (numbers). variantId / sku / codes are filled in the code step below.
    if (Array.isArray(updates.variants) && updates.variants.length > 0) {
      updates.variants = updates.variants.map((variant) => {
        // Ensure numeric fields are numbers
        variant.price = Number(variant.price) || 0;
        variant.stock = Number(variant.stock) || 0;

        // Parse discountedPrice - handle both number and string values
        if (variant.discountedPrice !== undefined && variant.discountedPrice !== null && variant.discountedPrice !== '') {
          const parsed = Number(variant.discountedPrice);
          variant.discountedPrice = (!isNaN(parsed) && parsed > 0) ? parsed : undefined;
        } else {
          variant.discountedPrice = undefined;
        }

        // Parse costPrice for variants
        if (variant.costPrice !== undefined && variant.costPrice !== null && variant.costPrice !== '') {
          const parsed = Number(variant.costPrice);
          variant.costPrice = (!isNaN(parsed) && parsed >= 0) ? parsed : undefined;
        } else {
          variant.costPrice = undefined;
        }

        return variant;
      });
    }

    // ----- Price tier (dollar-store price point) -----
    // A product linked to a tier always sells at the tier price
    // (services/sales/priceTierService.js), so edits cannot drift off it.
    // To change the price, unlink the tier first (or change the tier's price).
    if (typeof updates.price !== 'undefined' || Array.isArray(updates.variants)) {
      const current = await Product.findById(id).select('priceTier').lean();
      if (current && current.priceTier) {
        const PriceTier = require('../../models/priceTier');
        const tier = await PriceTier.findById(current.priceTier).select('price').lean();
        if (tier && Number.isFinite(Number(tier.price))) {
          const tierPrice = Number(tier.price);
          if (typeof updates.price !== 'undefined') updates.price = tierPrice;
          if (Array.isArray(updates.variants)) updates.variants.forEach((v) => { v.price = tierPrice; });
        }
      }
    }

    // ----- Barcodes / short codes / batches / boxes / stock -----
    // Updates are partial, so merge with the saved product and rebuild all codes.
    const touchesCodes = CODE_FIELDS.some((k) => typeof payload[k] !== 'undefined');
    const ctx = touchesCodes ? await branchContext(opts) : null;
    delete updates.stock; // stock is always rebuilt from branch stock below

    // colorMedia is a Map on the schema.
    if (colorMedia && typeof colorMedia === 'object' && Object.keys(colorMedia).length > 0) {
      updates.colorMedia = new Map(Object.entries(colorMedia));
    }

    // Update the product in database. When stock/codes were rebuilt from the
    // saved product, only write if nobody changed it meanwhile (a sale at the
    // counter...) — otherwise rebuild from the fresh copy and try again.
    let updated = null;
    // Price history: product as it was right before the write that succeeded.
    const logsPrices = PRICE_FIELDS.some((k) => typeof payload[k] !== 'undefined');
    let before = null;
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const set = { ...updates };
      const filter = { _id: id };
      if (touchesCodes) {
        const existing = await Product.findById(id).lean();
        if (!existing) {
          throw new Error('Product not found');
        }
        before = existing;
        Object.assign(set, await buildCodeUpdates(id, existing, payload, updates, ctx));
        if (existing.updatedAt) filter.updatedAt = existing.updatedAt;
      } else if (logsPrices) {
        before = await Product.findById(id).select(PRICE_SELECT).lean();
      }
      updated = await Product.findOneAndUpdate(filter, { $set: set }, { new: true, runValidators: true });
      if (updated || !filter.updatedAt) break;
      // Changed meanwhile (or deleted): loop reloads it.
    }

    if (!updated) {
      if (touchesCodes && (await Product.exists({ _id: id }))) {
        const err = new Error('This product was changed by someone else at the same time. Please try again.');
        err.status = 409;
        err.code = 'STOCK_CONFLICT';
        throw err;
      }
      throw new Error('Product not found');
    }
    if (ctx && ctx.warnings.length && Array.isArray(opts.warnings) && opts.warnings !== ctx.warnings) {
      opts.warnings.push(...ctx.warnings);
    }

    // Log sale price / cost changes (never throws).
    if (before && logsPrices) {
      await priceHistory.logProductDiff(before, updated.toObject ? updated.toObject() : updated, {
        source: 'product_form',
        userId: opts.userId || null,
      });
    }

    return updated;
  }
};

module.exports = updateProductService;