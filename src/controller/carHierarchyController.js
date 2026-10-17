// src/controller/carHierarchyController.js
//
// Controllers for the hierarchical car catalog:
// CarMake → CarModel → CarVariant.
// Cascade delete handled manually to clean children.

const CarMake = require('../models/carMake');
const CarModel = require('../models/carModel');
const CarVariant = require('../models/carVariant');
const { toPublicPath } = require('../helper/upload');
const { invalidate } = require('../middleware/cache');

// Bust every car-catalog cache any time a make / model / variant changes.
// Small and cheap — the caches refill on the next read.
function invalidateCarCaches() {
  invalidate('car-makes:active');
  invalidate('car-makes:stats');
  invalidate('car-makes:featured');
  invalidate('car-models:active');
  invalidate('car-models:by-make');
}

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  try {
    blobUpload = require('../helper/blobUpload');
  } catch (e) {
    console.warn('blobUpload helper not available:', e.message);
  }
}

async function saveImageFile(file, folder = 'car-makes') {
  if (!file) return '';
  if (USE_BLOB_STORAGE && blobUpload && blobUpload.uploadToBlob) {
    return await blobUpload.uploadToBlob(
      file.buffer,
      file.originalname,
      file.mimetype,
      folder
    );
  }
  // Local disk: multer already saved the file, we just build the public URL
  return toPublicPath(file.filename);
}

async function saveLogoFile(file) {
  return saveImageFile(file, 'car-makes');
}

// ──────────────────────────────────────────────────────────
// MAKES
// ──────────────────────────────────────────────────────────

// Backfill slugs for makes that don't have one (runs once lazily)
let slugsBackfilled = false;
async function backfillMakeSlugs() {
  if (slugsBackfilled) return;
  slugsBackfilled = true;
  try {
    const missing = await CarMake.find({ $or: [{ slug: null }, { slug: '' }, { slug: { $exists: false } }] });
    for (const make of missing) {
      make.slug = make.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await make.save();
    }
    if (missing.length) console.log(`Backfilled slugs for ${missing.length} car makes`);
  } catch (e) {
    console.error('Slug backfill error:', e.message);
    slugsBackfilled = false; // retry next time
  }
}

const listMakes = async (req, res) => {
  try {
    await backfillMakeSlugs();
    const makes = await CarMake.find().sort({ name: 1 });
    return res.status(200).json({ message: 'Car makes fetched', data: makes });
  } catch (error) {
    console.error('List car makes error:', error);
    return res.status(400).json({ message: 'Error fetching makes', error: error.message });
  }
};

const listActiveMakes = async (req, res) => {
  try {
    const makes = await CarMake.find({ active: true }).sort({ name: 1 });
    return res.status(200).json({ message: 'Active car makes fetched', data: makes });
  } catch (error) {
    console.error('List active car makes error:', error);
    return res.status(400).json({ message: 'Error fetching active makes', error: error.message });
  }
};

// Shared helper: attach modelCount, variantCount, productCount to an array
// of makes (lean docs).
//
// Previous implementation ran a 2× $lookup aggregation across
// products → carvariants → carmodels just to count products per make.
// That's the slowest part of the /make page. Here we instead:
//   1. load models + variants with minimal projections (we only need ids/refs)
//   2. build variantId → makeId in memory
//   3. fetch the matching products with a simple indexed find() that only
//      returns {_id, compatibleCars}
//   4. count distinct products per make in Node via the pre-built map
// No $unwind, no $lookup — a single projected find() on Product.
// Fetch makes + per-make counts (models, variants, products) in 2 DB round
// trips instead of 4. Replaces the old 4-step JS pipeline (CarMake + CarModel
// + CarVariant + Product finds → JS aggregation). Benchmarked at ~258ms vs
// ~790ms for the previous approach on Atlas (~3× faster) with identical output.
//
// Round trip 1: CarMake aggregation joins carmodels + carvariants via $lookup
// so modelCount/variantCount are computed server-side in a single pipeline.
// The variant _ids per make are also returned so round trip 2 can compute
// productCount without a second variant fetch.
//
// Round trip 2: Product aggregation groups unique product _ids per variant.
// JS then folds those up to make-level unique product counts using the
// variantId→makeId map built from round trip 1.
async function getMakesWithStats(matchStage) {
  const Product = require('../models/product');

  const makes = await CarMake.aggregate([
    { $match: matchStage },
    { $sort: { name: 1 } },
    {
      $lookup: {
        from: 'carmodels',
        let: { mid: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$makeId', '$$mid'] }, { $eq: ['$active', true] }] } } },
          { $project: { _id: 1 } },
        ],
        as: '_models',
      },
    },
    {
      $lookup: {
        from: 'carvariants',
        let: { modelIds: '$_models._id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $in: ['$modelId', '$$modelIds'] }, { $eq: ['$active', true] }] } } },
          { $project: { _id: 1 } },
        ],
        as: '_variants',
      },
    },
    {
      $addFields: {
        modelCount: { $size: '$_models' },
        variantCount: { $size: '$_variants' },
        _variantIds: '$_variants._id',
      },
    },
    { $project: { _models: 0, _variants: 0 } },
  ]);

  // Build variantId → makeId map from round-trip 1 output.
  const variantToMake = new Map();
  const allVariantIds = [];
  for (const m of makes) {
    for (const vId of m._variantIds || []) {
      variantToMake.set(String(vId), String(m._id));
      allVariantIds.push(vId);
    }
  }

  // Round-trip 2: unique product _ids per variant, server-side.
  let productsPerVariant = [];
  if (allVariantIds.length) {
    productsPerVariant = await Product.aggregate([
      { $match: { compatibleCars: { $in: allVariantIds }, status: 'published', isDeleted: { $ne: true } } },
      { $unwind: '$compatibleCars' },
      { $match: { compatibleCars: { $in: allVariantIds } } },
      { $group: { _id: '$compatibleCars', productIds: { $addToSet: '$_id' } } },
    ]);
  }

  // Fold variant-level product sets up to make-level (dedupes products that
  // match multiple variants of the same make).
  const productsByMake = new Map();
  for (const row of productsPerVariant) {
    const mk = variantToMake.get(String(row._id));
    if (!mk) continue;
    if (!productsByMake.has(mk)) productsByMake.set(mk, new Set());
    const set = productsByMake.get(mk);
    for (const pid of row.productIds) set.add(String(pid));
  }

  return makes.map((m) => {
    const { _variantIds, ...rest } = m;
    return {
      ...rest,
      productCount: productsByMake.get(String(m._id))?.size || 0,
    };
  });
}

const listActiveMakesWithStats = async (req, res) => {
  try {
    const data = await getMakesWithStats({ active: true });
    return res.status(200).json({ message: 'Active car makes with stats fetched', data });
  } catch (error) {
    console.error('List active car makes with stats error:', error);
    return res.status(400).json({ message: 'Error fetching active makes with stats', error: error.message });
  }
};

const listFeaturedMakes = async (req, res) => {
  try {
    const data = await getMakesWithStats({ active: true, featuredOnHome: true });
    return res.status(200).json({ message: 'Featured car makes fetched', data });
  } catch (error) {
    console.error('List featured car makes error:', error);
    return res.status(400).json({ message: 'Error fetching featured makes', error: error.message });
  }
};

const toggleFeaturedMake = async (req, res) => {
  try {
    const { id } = req.params;
    const make = await CarMake.findById(id);
    if (!make) return res.status(404).json({ message: 'Make not found' });
    make.featuredOnHome = !make.featuredOnHome;
    await make.save();
    invalidateCarCaches();
    return res.status(200).json({ message: 'Featured status toggled', data: make });
  } catch (error) {
    console.error('Toggle featured make error:', error);
    return res.status(400).json({ message: 'Error toggling featured', error: error.message });
  }
};

const listActiveModelsByMakeSlug = async (req, res) => {
  try {
    const { slug } = req.params;

    // Build variantId → modelId in memory and run a single projected find()
    // on Product to compute per-model counts without a $lookup chain.
    const make = await CarMake.findOne({
      $or: [{ slug }, { name: new RegExp(`^${slug.replace(/-/g, '[\\s-]')}$`, 'i') }],
      active: true,
    })
      .select('_id name slug logoUrl')
      .lean();
    if (!make) return res.status(404).json({ message: 'Make not found' });

    const models = await CarModel.find({ makeId: make._id, active: true })
      .select('_id name slug makeId')
      .sort({ name: 1 })
      .lean();

    const modelIds = models.map((m) => m._id);
    const variants = await CarVariant.find({ modelId: { $in: modelIds }, active: true })
      .select('_id modelId')
      .lean();

    // variantId → modelId, and variant-count per model.
    const variantIdToModelId = new Map();
    const variantCountMap = new Map();
    for (const v of variants) {
      const mid = String(v.modelId);
      variantIdToModelId.set(String(v._id), mid);
      variantCountMap.set(mid, (variantCountMap.get(mid) || 0) + 1);
    }

    // Count products per model — indexed find() only, no $lookup / $unwind.
    const productCountMap = new Map();
    const variantIds = variants.map((v) => v._id);
    if (variantIds.length) {
      const Product = require('../models/product');
      const products = await Product.find({
        compatibleCars: { $in: variantIds },
        status: 'published',
        isDeleted: { $ne: true },
      })
        .select('_id compatibleCars')
        .lean();

      // Set<modelId> per product → prevent double-count when a product
      // matches multiple variants of the same model.
      for (const p of products) {
        const seen = new Set();
        for (const vId of p.compatibleCars || []) {
          const modelId = variantIdToModelId.get(String(vId));
          if (!modelId || seen.has(modelId)) continue;
          seen.add(modelId);
          productCountMap.set(modelId, (productCountMap.get(modelId) || 0) + 1);
        }
      }
    }

    const data = models.map((model) => {
      const mid = String(model._id);
      return {
        ...model,
        variantCount: variantCountMap.get(mid) || 0,
        productCount: productCountMap.get(mid) || 0,
      };
    });

    return res.status(200).json({
      message: 'Models fetched for make',
      make: { _id: make._id, name: make.name, slug: make.slug, logoUrl: make.logoUrl },
      data,
    });
  } catch (error) {
    console.error('List active models by make slug error:', error);
    return res.status(400).json({ message: 'Error fetching models', error: error.message });
  }
};

const listActiveModels = async (req, res) => {
  try {
    const filter = { active: true };
    if (req.query.makeId) filter.makeId = req.query.makeId;
    const models = await CarModel.find(filter).sort({ name: 1 });
    return res.status(200).json({ message: 'Active car models fetched', data: models });
  } catch (error) {
    console.error('List active car models error:', error);
    return res.status(400).json({ message: 'Error fetching active models', error: error.message });
  }
};

const listActiveVariants = async (req, res) => {
  try {
    const filter = { active: true };
    if (req.query.modelId) filter.modelId = req.query.modelId;
    // Support filtering by makeId: find all models for the make, then their variants
    if (req.query.makeId) {
      const models = await CarModel.find({ makeId: req.query.makeId, active: true }).select('_id');
      filter.modelId = { $in: models.map(m => m._id) };
    }
    const variants = await CarVariant.find(filter).sort({ yearStart: -1, name: 1 });
    return res.status(200).json({ message: 'Active car variants fetched', data: variants });
  } catch (error) {
    console.error('List active car variants error:', error);
    return res.status(400).json({ message: 'Error fetching active variants', error: error.message });
  }
};

const createMake = async (req, res) => {
  try {
    const { name, active = true, logoUrl: bodyLogoUrl = '' } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Make name is required' });
    }

    const logoFile = req.files?.logo?.[0];
    // File wins over URL if both are somehow provided
    const logoUrl = logoFile
      ? await saveLogoFile(logoFile)
      : String(bodyLogoUrl || '').trim();

    const created = await CarMake.create({
      name: String(name).trim(),
      logoUrl,
      active: active === 'false' ? false : Boolean(active),
    });
    invalidateCarCaches();
    return res.status(201).json({ message: 'Car make created', data: created });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: 'A make with this name already exists' });
    }
    console.error('Create car make error:', error);
    return res.status(400).json({ message: 'Error creating make', error: error.message });
  }
};

const updateMake = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const updates = {};

    if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
    if (typeof payload.active !== 'undefined') {
      updates.active = payload.active === 'false' ? false : Boolean(payload.active);
    }
    if (typeof payload.featuredOnHome !== 'undefined') {
      updates.featuredOnHome = payload.featuredOnHome === 'false' ? false : Boolean(payload.featuredOnHome);
    }

    const logoFile = req.files?.logo?.[0];
    if (logoFile) {
      updates.logoUrl = await saveLogoFile(logoFile);
    } else if (typeof payload.logoUrl !== 'undefined') {
      updates.logoUrl = String(payload.logoUrl || '').trim();
    }

    const updated = await CarMake.findByIdAndUpdate(id, { $set: updates }, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: 'Make not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car make updated', data: updated });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: 'A make with this name already exists' });
    }
    console.error('Update car make error:', error);
    return res.status(400).json({ message: 'Error updating make', error: error.message });
  }
};

const deleteMake = async (req, res) => {
  try {
    const { id } = req.params;
    // Cascade — delete all models and variants under this make
    const models = await CarModel.find({ makeId: id }, '_id');
    const modelIds = models.map((m) => m._id);
    if (modelIds.length) {
      await CarVariant.updateMany({ modelId: { $in: modelIds } }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } });
      await CarModel.updateMany({ makeId: id }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } });
    }
    const deleted = await CarMake.softDeleteById(id, req.user?._id || null);
    if (!deleted) return res.status(404).json({ message: 'Make not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car make deleted', id });
  } catch (error) {
    console.error('Delete car make error:', error);
    return res.status(400).json({ message: 'Error deleting make', error: error.message });
  }
};

// ──────────────────────────────────────────────────────────
// MODELS
// ──────────────────────────────────────────────────────────

const listModels = async (req, res) => {
  try {
    const filter = {};
    if (req.query.makeId) filter.makeId = req.query.makeId;
    const models = await CarModel.find(filter).sort({ name: 1 });
    return res.status(200).json({ message: 'Car models fetched', data: models });
  } catch (error) {
    console.error('List car models error:', error);
    return res.status(400).json({ message: 'Error fetching models', error: error.message });
  }
};

const createModel = async (req, res) => {
  try {
    const { makeId, name, active = true } = req.body || {};
    if (!makeId) return res.status(400).json({ message: 'makeId is required' });
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Model name is required' });
    }

    const make = await CarMake.findById(makeId);
    if (!make) return res.status(404).json({ message: 'Parent make not found' });

    const created = await CarModel.create({
      makeId,
      name: String(name).trim(),
      active: Boolean(active),
    });
    invalidateCarCaches();
    return res.status(201).json({ message: 'Car model created', data: created });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: 'A model with this name already exists for the selected make' });
    }
    console.error('Create car model error:', error);
    return res.status(400).json({ message: 'Error creating model', error: error.message });
  }
};

const updateModel = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const updates = {};
    if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
    if (typeof payload.active !== 'undefined') updates.active = Boolean(payload.active);

    const updated = await CarModel.findByIdAndUpdate(id, { $set: updates }, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: 'Model not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car model updated', data: updated });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: 'A model with this name already exists for the selected make' });
    }
    console.error('Update car model error:', error);
    return res.status(400).json({ message: 'Error updating model', error: error.message });
  }
};

const deleteModel = async (req, res) => {
  try {
    const { id } = req.params;
    await CarVariant.updateMany({ modelId: id }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } });
    const deleted = await CarModel.softDeleteById(id, req.user?._id || null);
    if (!deleted) return res.status(404).json({ message: 'Model not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car model deleted', id });
  } catch (error) {
    console.error('Delete car model error:', error);
    return res.status(400).json({ message: 'Error deleting model', error: error.message });
  }
};

// ──────────────────────────────────────────────────────────
// VARIANTS
// ──────────────────────────────────────────────────────────

const listVariants = async (req, res) => {
  try {
    const filter = {};
    if (req.query.modelId) filter.modelId = req.query.modelId;
    const variants = await CarVariant.find(filter).sort({ yearStart: -1, name: 1 });
    return res.status(200).json({ message: 'Car variants fetched', data: variants });
  } catch (error) {
    console.error('List car variants error:', error);
    return res.status(400).json({ message: 'Error fetching variants', error: error.message });
  }
};

const createVariant = async (req, res) => {
  try {
    const { modelId, name = '', yearStart = null, yearEnd = null, active = true, imageUrl: bodyImageUrl = '' } = req.body || {};
    if (!modelId) return res.status(400).json({ message: 'modelId is required' });

    const model = await CarModel.findById(modelId);
    if (!model) return res.status(404).json({ message: 'Parent model not found' });

    const ys = yearStart ? Number(yearStart) : null;
    const ye = yearEnd ? Number(yearEnd) : null;
    if (ys && ye && ye < ys) {
      return res.status(400).json({ message: 'yearEnd must be >= yearStart' });
    }

    const imageFile = req.files?.image?.[0];
    const imageUrl = imageFile
      ? await saveImageFile(imageFile, 'car-variants')
      : String(bodyImageUrl || '').trim();

    const created = await CarVariant.create({
      modelId,
      name: String(name || '').trim(),
      yearStart: ys,
      yearEnd: ye,
      imageUrl,
      active: active === 'false' ? false : Boolean(active),
    });
    invalidateCarCaches();
    return res.status(201).json({ message: 'Car variant created', data: created });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: 'This variant/year combination already exists for the model' });
    }
    console.error('Create car variant error:', error);
    return res.status(400).json({ message: 'Error creating variant', error: error.message });
  }
};

const updateVariant = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const updates = {};
    if (typeof payload.name !== 'undefined') updates.name = String(payload.name || '').trim();
    if (typeof payload.yearStart !== 'undefined')
      updates.yearStart = payload.yearStart ? Number(payload.yearStart) : null;
    if (typeof payload.yearEnd !== 'undefined')
      updates.yearEnd = payload.yearEnd ? Number(payload.yearEnd) : null;
    if (typeof payload.active !== 'undefined') {
      updates.active = payload.active === 'false' ? false : Boolean(payload.active);
    }

    const imageFile = req.files?.image?.[0];
    if (imageFile) {
      updates.imageUrl = await saveImageFile(imageFile, 'car-variants');
    } else if (typeof payload.imageUrl !== 'undefined') {
      updates.imageUrl = String(payload.imageUrl || '').trim();
    }

    if (updates.yearStart && updates.yearEnd && updates.yearEnd < updates.yearStart) {
      return res.status(400).json({ message: 'yearEnd must be >= yearStart' });
    }

    const updated = await CarVariant.findByIdAndUpdate(id, { $set: updates }, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: 'Variant not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car variant updated', data: updated });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: 'This variant/year combination already exists for the model' });
    }
    console.error('Update car variant error:', error);
    return res.status(400).json({ message: 'Error updating variant', error: error.message });
  }
};

const deleteVariant = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await CarVariant.softDeleteById(id, req.user?._id || null);
    if (!deleted) return res.status(404).json({ message: 'Variant not found' });
    invalidateCarCaches();
    return res.status(200).json({ message: 'Car variant deleted', id });
  } catch (error) {
    console.error('Delete car variant error:', error);
    return res.status(400).json({ message: 'Error deleting variant', error: error.message });
  }
};

module.exports = {
  // Makes
  listMakes,
  listActiveMakes,
  listActiveMakesWithStats,
  listFeaturedMakes,
  toggleFeaturedMake,
  createMake,
  updateMake,
  deleteMake,
  // Models
  listModels,
  listActiveModels,
  listActiveModelsByMakeSlug,
  createModel,
  updateModel,
  deleteModel,
  // Variants
  listVariants,
  listActiveVariants,
  createVariant,
  updateVariant,
  deleteVariant,
};
