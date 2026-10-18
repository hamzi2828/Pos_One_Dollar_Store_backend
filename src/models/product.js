// src/models/product.js
// A product of the shop: a single item, or a product with variants (colour /
// size / any attributes). Stock is counted in pieces (helper/productCodes.js).

const mongoose = require('mongoose');

// One scannable code on a product or variant. `qty` = how many pieces one
// scan sells (1 for a normal/box label, N for a "full box" code).
const barcodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    qty: { type: Number, min: 1, default: 1 },
    label: { type: String, trim: true, default: '' }, // e.g. 'manufacturer', 'box', 'full-box'
  },
  { _id: false }
);

// A received lot of stock. When a product/variant has batches, its stock is
// the sum of the batches' remaining `quantity` (sold oldest/expiring first).
const batchSchema = new mongoose.Schema(
  {
    batchNo: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, trim: true, uppercase: true, default: undefined },
    quantity: { type: Number, min: 0, default: 0 }, // remaining pieces
    initialQuantity: { type: Number, min: 0, default: 0 },
    costPrice: { type: Number, min: 0, default: undefined },
    expiryDate: { type: Date, default: undefined },
    receivedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: '' },
    // The shop (see models/branch.js). Old batches without one belong to it.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: undefined },
  },
  { _id: true }
);

// Pieces of one unit held by the shop (one row: the shop's branch id). Kept in
// sync by helper/productCodes.js (syncProductBranchStock) and
// services/stockService.js — do not edit by hand.
//   unit with batches:    stock = sum of the batches
//   unit without batches: unit.stock = sum of branchStock
// Missing/empty on old data = everything is in the shop.
const branchStockSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    stock: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const variantSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true, unique: false, trim: true }, // Custom unique ID for variant
    // color / size; any other options (Pack, Material...) go in `attributes`.
    color: { type: String, trim: true, default: '' },
    size: { type: String, trim: true, default: '' },
    attributes: { type: Map, of: String, default: undefined },
    shortCode: { type: String, trim: true, default: undefined }, // small number cashier can type
    barcodes: { type: [barcodeSchema], default: [] },
    batches: { type: [batchSchema], default: [] },
    branchStock: { type: [branchStockSchema], default: [] },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    sku: { type: String, trim: true, default: undefined },
    // Weighted-average landed cost per piece (see services/inventory/costingService.js).
    costPrice: { type: Number, min: 0, default: undefined },
    discountedPrice: { type: Number, min: 0, default: undefined },
    // Receipt history (stamped by stockService.receiveStock `cost`).
    lastPurchasePrice: { type: Number, min: 0, default: undefined },
    lastLandedCost: { type: Number, min: 0, default: undefined },
    lastVendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: undefined },
    lastVendorName: { type: String, trim: true, default: undefined },
    lastReceivedAt: { type: Date, default: undefined },
    lastReceivedQty: { type: Number, min: 0, default: undefined },
    firstPurchasePrice: { type: Number, min: 0, default: undefined },
    firstReceivedAt: { type: Date, default: undefined },
  },
  { _id: true } // Enable MongoDB _id for variants
);

const colorMediaSchema = new mongoose.Schema(
  {
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    category: { type: String, required: true, trim: true },
    subCategory: { type: String, trim: true, default: undefined },
    price: { type: Number, required: true, min: 0 },
    discountedPrice: { type: Number, min: 0, default: undefined },
    // Weighted-average landed cost per piece (purchase price + share of
    // transport / builty / landing / misc charges). Snapshot into each POS sale line
    // as cost of goods sold. Kept by stockService.receiveStock `cost`.
    costPrice: { type: Number, min: 0, default: undefined },
    sku: { type: String, trim: true, default: undefined },

    // ----- Purchase / cost history (stamped on every costed receipt) -----
    lastPurchasePrice: { type: Number, min: 0, default: undefined }, // vendor price, last receipt
    lastLandedCost: { type: Number, min: 0, default: undefined }, // landed cost, last receipt
    lastVendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: undefined },
    lastVendorName: { type: String, trim: true, default: undefined },
    lastReceivedAt: { type: Date, default: undefined },
    lastReceivedQty: { type: Number, min: 0, default: undefined }, // base of the 25% demand rule
    firstPurchasePrice: { type: Number, min: 0, default: undefined }, // "where the price started"
    firstReceivedAt: { type: Date, default: undefined },

    // ----- Demand list (reports) -----
    // Optional target stock; when set, demand uses it instead of lastReceivedQty.
    parLevel: { type: Number, min: 0, default: undefined },
    // Optional per-product threshold % (default: config "demand.thresholdPct" = 25).
    reorderPct: { type: Number, min: 0, max: 100, default: undefined },

    // ----- Dollar-store price point (models/priceTier.js) -----
    // When set, the sale price follows the tier's price.
    priceTier: { type: mongoose.Schema.Types.ObjectId, ref: 'PriceTier', default: null, index: true },

    // ----- Consignment (sale-or-return) -----
    // Stock belongs to the vendor until sold; we owe consignmentRate per piece sold.
    isConsignment: { type: Boolean, default: false, index: true },
    consignmentVendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    consignmentRate: { type: Number, min: 0, default: undefined },

    // TOTAL pieces (lists / reports read this).
    stock: { type: Number, required: true, min: 0 },
    // Pieces held by the shop. Single product: its own stock. Variant product:
    // sum of the variants' branchStock (kept in sync on every write).
    branchStock: { type: [branchStockSchema], default: [] },

    // ----- Barcode / packaging (single products; variants carry their own) -----
    shortCode: { type: String, trim: true, default: undefined },
    barcodes: { type: [barcodeSchema], default: [] },
    batches: { type: [batchSchema], default: [] },
    // Pieces inside one box. 1 = sold loose. Stock is always counted in pieces.
    piecesPerBox: { type: Number, min: 1, default: 1 },
    // Every code that can be scanned/typed for this product (uppercased).
    // Built by helper/productCodes.js — do not edit by hand.
    scanCodes: { type: [String], default: [], index: true },

    status: { type: String, enum: ['published', 'draft', 'out_of_stock'], default: 'draft', index: true },
    featured: { type: Boolean, default: false, index: true },

    // Global media (hidden in variant mode on UI but kept here for compatibility)
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },

    productType: { type: String, enum: ['single', 'variant'], default: 'single', index: true },
    variants: { type: [variantSchema], default: [] },

    // Optional future use: media per color
    colorMedia: {
      type: Map,
      of: colorMediaSchema,
      default: undefined,
    },

    // Description fields
    description: { type: String, trim: true, default: undefined },
    shortDescription: { type: String, trim: true, maxLength: 500, default: undefined },
    features: { type: String, trim: true, default: undefined },

    // Tags
    tags: { type: [String], default: [] },

    // Dimensions (L x W x H) and weight
    dimensionLength: { type: String, trim: true, default: undefined },
    dimensionWidth: { type: String, trim: true, default: undefined },
    dimensionHeight: { type: String, trim: true, default: undefined },
    weight: { type: String, trim: true, default: undefined },
  },
  { timestamps: true }
);

// Ensure formatting on save
productSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = String(this.name).trim();
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Simple length validator for banners
productSchema.path('bannerUrls').validate(function (value) {
  return !value || value.length <= 5;
}, 'You can upload up to 5 banner images');

// ----- Indexes: serve the admin product list + stock page efficiently -----
// Default sort column on the list page.
productSchema.index({ createdAt: -1 });
// status + newest-first (status filter + default sort)
productSchema.index({ status: 1, createdAt: -1 });
// category + newest-first (category filter + default sort)
productSchema.index({ category: 1, createdAt: -1 });
// category + status combined (common combo filter)
productSchema.index({ category: 1, status: 1, createdAt: -1 });
// Stock page queries — low / out of stock
productSchema.index({ stock: 1 });
productSchema.index({ status: 1, stock: 1 });
// Shop stock lookups (branchStockQuery / POS product list)
productSchema.index({ 'branchStock.branch': 1, 'branchStock.stock': 1 });
productSchema.index({ 'variants.branchStock.branch': 1 });
// Product count per category (categories list).
productSchema.index({ status: 1, category: 1 });
// Price / name sorted lists.
productSchema.index({ status: 1, price: 1 });
productSchema.index({ status: 1, name: 1 });

// Full-text search over the fields the admin search box hits
productSchema.index(
  { name: 'text', slug: 'text', category: 'text', tags: 'text' },
  { name: 'product_text_idx', weights: { name: 10, slug: 8, category: 4, tags: 3 } }
);

// Delete cached model to ensure schema updates are applied
if (mongoose.models.Product) {
  delete mongoose.models.Product;
}

productSchema.plugin(require('../helper/softDeletePlugin'));

module.exports = mongoose.model('Product', productSchema);
