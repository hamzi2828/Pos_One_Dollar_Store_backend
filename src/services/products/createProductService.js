// createProductService.js
// Create a product from the admin product form (multipart). Codes, batches and
// stock rules: helper/productCodes.js. Stock typed in the form goes to the shop.
const Product = require('../../models/product');
const crypto = require('crypto');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Helper function to convert uploaded filename to public path (for local storage)
const toPublicPath = (filename) => {
  if (!filename) return null;
  return `/uploads/${filename}`;
};

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

const {
  parseMaybeJSON,
  normalizeCode,
  normalizeAttributes,
  normalizeBarcodes,
  normalizeBatches,
  variantLabel,
  isCodeTaken,
  prepareProductCodes,
  toBranchId,
  getMainBranchId,
  generateShortCode,
} = require('../../helper/productCodes');

// Helper function to check if value is a valid number
const isNumber = (value) => {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
};

// multipart/form-data sends booleans as strings
const toBool = (value) => value === true || value === 'true' || value === 1 || value === '1' || value === 'on';

const hasValue = (value) => value !== undefined && value !== null && value !== '';

// piecesPerBox: integer >= 1 (default 1)
const toPiecesPerBox = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

// Stock in pieces from "boxes + loose pieces". Returns undefined when neither is given.
const stockFromBoxes = (boxes, loosePieces, piecesPerBox) => {
  if (!hasValue(boxes) && !hasValue(loosePieces)) return undefined;
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  const l = Math.max(0, Math.floor(Number(loosePieces) || 0));
  return b * toPiecesPerBox(piecesPerBox) + l;
};

const nameInitials = (productName) =>
  String(productName || '').split(' ').map(word => word.charAt(0)).join('').toUpperCase();

// Middle part of a variant id/sku.
// color + size only -> old format "RED-M"; otherwise built from the variant label
// e.g. {Storage:"128GB", Color:"Black"} -> "128GB-BLACK".
const variantCodePart = (variant = {}) => {
  const color = String(variant.color || '').trim();
  const size = String(variant.size || '').trim();
  const attrs = normalizeAttributes(variant.attributes);
  if (color && size && !attrs) {
    return `${color.substring(0, 3).toUpperCase()}-${size.charAt(0).toUpperCase()}`;
  }
  const parts = variantLabel({ color, size, attributes: attrs })
    .split(' / ')
    .map((p) => p.replace(/[^A-Za-z0-9]/g, '').substring(0, 5).toUpperCase())
    .filter(Boolean);
  return parts.length ? parts.join('-') : 'VAR';
};

// Generate unique variant ID: PRODUCT-COLOR-SIZE-RANDOM (or PRODUCT-<label parts>-RANDOM)
const generateVariantId = (productName, variant) => {
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${nameInitials(productName)}-${variantCodePart(variant)}-${randomSuffix}`;
};

// Generate SKU for variant: PRODUCT-COLOR-SIZE-NN (or PRODUCT-<label parts>-NN)
const generateVariantSKU = (productName, variant, index) => {
  const variantNumber = String(index + 1).padStart(2, '0');
  return `${nameInitials(productName)}-${variantCodePart(variant)}-${variantNumber}`;
};

// SKUs are scannable codes now, so a generated SKU must not clash with another
// code of this product (`taken`, uppercased) or of another product.
const ensureUniqueSku = async (sku, taken, excludeId = null) => {
  let candidate = sku;
  for (let n = 2; n < 50; n++) {
    const code = normalizeCode(candidate);
    if (!taken.has(code) && !(await isCodeTaken(code, excludeId))) {
      taken.add(code);
      return candidate;
    }
    candidate = n < 10 ? `${sku}-${n}` : `${sku}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  }
  throw new Error('Could not generate a unique variant SKU, please set one manually');
};

// Code-related fields of one variant from the request (strings allowed).
// Returns only the keys that were present in the input.
const parseVariantCodeFields = (v = {}) => {
  const out = {};
  if (v.attributes !== undefined) out.attributes = normalizeAttributes(v.attributes);
  if (v.shortCode !== undefined) out.shortCode = normalizeCode(v.shortCode) || undefined;
  if (v.barcodes !== undefined) out.barcodes = normalizeBarcodes(v.barcodes);
  if (v.batches !== undefined) out.batches = normalizeBatches(v.batches);
  return out;
};

// ----- Where stock typed in the form goes: the shop -----

/** opts from the controller: { branchId (the shop), warnings[] }. No opts (scripts) = the shop. */
const branchContext = async (opts = {}) => {
  const mainBranchId = await getMainBranchId();
  return {
    mainBranchId,
    writeBranchId: toBranchId(opts.branchId) || mainBranchId,
    warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
  };
};

// Batches typed in the form belong to the shop.
const assignBatchBranches = (batches, ctx) => (batches || []).map((b) => ({ ...b, branch: ctx.writeBranchId }));

// Process color-specific media files
const processColorMedia = (files, existingColorMedia = {}) => {
  const colorMedia = typeof existingColorMedia === 'object' ? existingColorMedia : {};
  
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
  
  return colorMedia;
};

const createProductService = {
  /**
   * Create a new product with the provided data and files
   * @param {Object} payload - Request body data
   * @param {Object} files - Uploaded files
   * @returns {Promise<Object>} Created product
   */
  createProduct: async (payload, files, opts = {}) => {
    const ctx = await branchContext(opts);

    let {
      name,
      slug,
      category,
      subCategory,
      price,
      discountedPrice,
      stock,
      status = 'draft',
      thumbnailUrl,
      bannerUrls = [],
      productType = 'single',
      variants = [],
      colorMedia,
      description,
      shortDescription,
      features,
      dimensionLength,
      dimensionWidth,
      dimensionHeight,
      weight,
      sku,
      costPrice,
      shortCode,
      barcodes,
      batches,
      piecesPerBox,
      addFullBoxBarcode,
      boxes,
      loosePieces,
    } = payload;

    // Barcode / box / batch fields (may be JSON strings via multipart/form-data)
    piecesPerBox = toPiecesPerBox(piecesPerBox);
    addFullBoxBarcode = toBool(addFullBoxBarcode);
    shortCode = normalizeCode(shortCode) || undefined;
    // Single products: short code + SKU are made automatically when not given
    // (the form shows them read-only). SKU = name initials + short code, e.g. "SGA-48213".
    if (productType !== 'variant') {
      if (!shortCode) shortCode = await generateShortCode();
      if (!sku || !String(sku).trim()) {
        sku = await ensureUniqueSku(`${nameInitials(name) || 'P'}-${shortCode}`, new Set([shortCode]));
      }
    }
    barcodes = normalizeBarcodes(barcodes);
    batches = assignBatchBranches(normalizeBatches(batches), ctx);

    // Parse fields that might come as JSON strings via multipart/form-data
    bannerUrls = parseMaybeJSON(bannerUrls) || [];
    variants = parseMaybeJSON(variants) || [];
    colorMedia = parseMaybeJSON(colorMedia);

    // Process files - use Vercel Blob or local storage
    if (USE_BLOB_STORAGE && blobUpload) {
      const blobResult = await blobUpload.processProductFiles(files);

      if (blobResult.thumbnailUrl) {
        thumbnailUrl = blobResult.thumbnailUrl;
      }
      if (blobResult.bannerUrls.length) {
        bannerUrls = [...blobResult.bannerUrls, ...bannerUrls];
      }
      if (Object.keys(blobResult.colorMedia).length) {
        colorMedia = { ...colorMedia, ...blobResult.colorMedia };
      }
    } else {
      // Local storage processing
      const thumbFile = Array.isArray(files?.thumbnail) ? files.thumbnail[0] : undefined;
      const bannerFiles = Array.isArray(files?.banners) ? files.banners : [];

      // Process color-specific media files if present
      if (files.colorThumbnail || files.colorBanner || payload.existingColorThumbnails || payload.existingColorBanners) {
        colorMedia = processColorMedia(files, colorMedia);
      }

      if (thumbFile) {
        thumbnailUrl = toPublicPath(thumbFile.filename);
      }
      if (bannerFiles.length) {
        const uploadedBanners = bannerFiles.map((f) => toPublicPath(f.filename));
        if (Array.isArray(bannerUrls) && bannerUrls.length) {
          bannerUrls = [...uploadedBanners, ...bannerUrls];
        } else {
          bannerUrls = uploadedBanners;
        }
      }
    }

    // Handle existing color thumbnails (for edit scenarios)
    if (payload.existingColorThumbnails) {
      const thumbsArray = Array.isArray(payload.existingColorThumbnails)
        ? payload.existingColorThumbnails
        : [payload.existingColorThumbnails];

      thumbsArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.url) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            if (!colorMedia[parsed.color].thumbnailUrl) {
              colorMedia[parsed.color].thumbnailUrl = parsed.url;
            }
          }
        } catch (e) {
          console.error('Error parsing existingColorThumbnails item:', e);
        }
      });
    }

    // Handle existing color banners (for edit scenarios)
    if (payload.existingColorBanners) {
      const bannersArray = Array.isArray(payload.existingColorBanners)
        ? payload.existingColorBanners
        : [payload.existingColorBanners];

      bannersArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.urls) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            const existingBanners = parsed.urls || [];
            const newBanners = colorMedia[parsed.color].bannerUrls || [];
            const existingUrls = existingBanners.filter(url => !newBanners.includes(url));
            colorMedia[parsed.color].bannerUrls = [...existingUrls, ...newBanners].slice(0, 10);
          }
        } catch (e) {
          console.error('Error parsing existingColorBanners item:', e);
        }
      });
    }

    // Coerce numeric fields when coming from multipart strings
    if (typeof price === 'string' && price !== '') price = Number(price);
    if (typeof discountedPrice === 'string' && discountedPrice !== '') discountedPrice = Number(discountedPrice);
    if (typeof stock === 'string' && stock !== '') stock = Number(stock);
    
    if (!name || !slug || !category) {
      throw new Error('name, slug and category are required');
    }

    name = String(name).trim();
    slug = String(slug).trim().toLowerCase();
    category = String(category).trim();
    subCategory = subCategory ? String(subCategory).trim() : undefined;
    status = ['published', 'draft', 'out_of_stock'].includes(status) ? status : 'draft';

    if (productType === 'variant') {
      if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error('At least one variant is required for variant products');
      }
      
      // Basic validation and ID generation for variants
      variants = variants.map((v, index) => {
        const color = String(v.color || '').trim();
        const size = String(v.size || '').trim();
        const codeFields = parseVariantCodeFields(v);
        const variantBatches = assignBatchBranches(codeFields.batches || [], ctx);
        // Stock: batches win (computed by prepareProductCodes), then boxes + loose pieces, then stock
        const boxStock = stockFromBoxes(v.boxes, v.loosePieces, piecesPerBox);
        let variantStock;
        if (variantBatches.length) variantStock = variantBatches.reduce((s, b) => s + (b.quantity || 0), 0);
        else if (boxStock !== undefined) variantStock = boxStock;
        else variantStock = Number(v.stock || 0);

        // Parse discountedPrice - handle both number and string values
        let discountedPrice = undefined;
        if (v.discountedPrice !== undefined && v.discountedPrice !== null && v.discountedPrice !== '') {
          const parsed = Number(v.discountedPrice);
          if (!isNaN(parsed) && parsed > 0) {
            discountedPrice = parsed;
          }
        }

        // Parse costPrice for variant
        let variantCostPrice = undefined;
        if (v.costPrice !== undefined && v.costPrice !== null && v.costPrice !== '') {
          const parsed = Number(v.costPrice);
          if (!isNaN(parsed) && parsed >= 0) {
            variantCostPrice = parsed;
          }
        }

        return {
          variantId: v.variantId || generateVariantId(name, { color, size, attributes: codeFields.attributes }), // Generate if not provided
          color,
          size,
          attributes: codeFields.attributes,
          shortCode: codeFields.shortCode,
          barcodes: codeFields.barcodes || [],
          batches: variantBatches,
          // typed stock -> the shop (batches carry their own)
          branchStock: variantBatches.length ? [] : [{ branch: ctx.writeBranchId, stock: variantStock }],
          price: Number(v.price || 0),
          stock: variantStock,
          // SKU generated below (after validation) if not provided
          sku: v.sku ? String(v.sku).trim() : undefined,
          costPrice: variantCostPrice,
          discountedPrice,
        };
      });

      for (const v of variants) {
        if (!v.color && !v.size && !v.attributes) {
          throw new Error('Each variant must include at least one option (color, size or attributes)');
        }
        if (!isNumber(v.price) || v.price < 0) {
          throw new Error('Variant price must be a non-negative number');
        }
        if (!Number.isInteger(v.stock) || v.stock < 0) {
          throw new Error('Variant stock must be a non-negative integer');
        }
      }

      // Generate missing SKUs, unique within this product and across products
      const takenSkus = new Set(variants.map((v) => normalizeCode(v.sku)).filter(Boolean));
      for (let index = 0; index < variants.length; index++) {
        const v = variants[index];
        if (!v.sku) v.sku = await ensureUniqueSku(generateVariantSKU(name, v, index), takenSkus);
      }

      // Derive stock and base price if not provided
      const derivedStock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
      const basePrice = isNumber(price) ? price : variants[0]?.price || 0;
      stock = derivedStock;
      price = basePrice;
      
    } else {
      // single product validations
      if (!isNumber(price) || price < 0) {
        throw new Error('price must be a non-negative number');
      }
      if (batches.length) {
        // Stock comes from the batches (summed by prepareProductCodes)
        stock = batches.reduce((s, b) => s + (b.quantity || 0), 0);
      } else {
        const boxStock = stockFromBoxes(boxes, loosePieces, piecesPerBox);
        if (boxStock !== undefined) stock = boxStock;
        if (!Number.isInteger(stock) || stock < 0) {
          throw new Error('stock must be a non-negative integer');
        }
      }
    }

    // Enforce banner length on server as well
    if (Array.isArray(bannerUrls) && bannerUrls.length > 5) {
      bannerUrls = bannerUrls.slice(0, 5);
    }

    const doc = {
      name,
      slug,
      category,
      subCategory,
      price,
      discountedPrice: isNumber(discountedPrice) ? discountedPrice : undefined,
      stock,
      status,
      thumbnailUrl: thumbnailUrl ? String(thumbnailUrl).trim() : undefined,
      bannerUrls: Array.isArray(bannerUrls) ? bannerUrls.map((u) => String(u)) : [],
      productType: productType === 'variant' ? 'variant' : 'single',
      variants: Array.isArray(variants) ? variants : [],
      description: description ? String(description).trim() : undefined,
      shortDescription: shortDescription ? String(shortDescription).trim() : undefined,
      features: features ? String(features).trim() : undefined,
      // Dimensions (L x W x H) and weight
      dimensionLength: dimensionLength ? String(dimensionLength).trim() : undefined,
      dimensionWidth: dimensionWidth ? String(dimensionWidth).trim() : undefined,
      dimensionHeight: dimensionHeight ? String(dimensionHeight).trim() : undefined,
      weight: weight ? String(weight).trim() : undefined,
      // SKU and Cost Price (top-level, for single products)
      sku: sku ? String(sku).trim() : undefined,
      costPrice: costPrice !== undefined && costPrice !== null && costPrice !== '' ? Number(costPrice) : undefined,
      // Barcodes / packaging (single products; variant products keep these per variant)
      shortCode,
      barcodes,
      batches,
      piecesPerBox,
      // The shop's pieces (single product). Variant products: filled from the variants.
      branchStock: productType === 'variant' || batches.length ? [] : [{ branch: ctx.writeBranchId, stock }],
    };

    // Add colorMedia to the document
    if (colorMedia && typeof colorMedia === 'object' && Object.keys(colorMedia).length > 0) {
      doc.colorMedia = colorMedia;
    }

    // Short codes, batch numbers, full-box code, stock from batches, scanCodes.
    // Throws 409 DUPLICATE_CODE if a code is already used.
    await prepareProductCodes(doc, {
      addFullBoxBarcode,
      mainBranchId: ctx.mainBranchId,
      defaultBranchId: ctx.writeBranchId,
    });

    return Product.create(doc);
  }
};

module.exports = createProductService;
// Shared with updateProductService
module.exports.helpers = {
  toBool,
  hasValue,
  toPiecesPerBox,
  stockFromBoxes,
  generateVariantId,
  generateVariantSKU,
  ensureUniqueSku,
  parseVariantCodeFields,
  branchContext,
};