// src/controller/categoryController.js
// Product categories (admin). Thumbnails / banner go to Vercel Blob when it is
// configured, otherwise to local /uploads.
const Category = require('../models/category');
const Product = require('../models/product');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
const blobUpload = USE_BLOB_STORAGE ? require('../helper/blobUpload') : null;

const toBool = (v) => v === true || v === 'true';

// Stored URL of an uploaded file (Blob or local disk).
const storeFile = async (file, folder) =>
  blobUpload ? blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, folder) : `/uploads/${file.filename}`;

// `existingThumbnailUrls` (JSON list of URLs the form keeps). undefined when not sent.
const keptThumbnailUrls = (body) => {
  if (typeof body.existingThumbnailUrls === 'undefined') return undefined;
  try {
    const parsed = JSON.parse(body.existingThumbnailUrls);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
  } catch (_) {
    return [];
  }
};

// '' / 'null' / 'undefined' from a form = no parent.
const parentIdOf = (raw) => (raw === '' || raw === 'null' || raw === 'undefined' ? null : raw || null);

const categoryController = {
  // GET /categories?parentOnly=&flat=&active=&search=
  listCategories: async (req, res) => {
    try {
      const { parentOnly, flat, active, search } = req.query;

      const query = {};
      if (parentOnly === 'true') query.parentId = null;
      if (active === 'true') query.active = true;
      else if (active === 'false') query.active = false;
      if (search && String(search).trim()) {
        const s = String(search).trim();
        if (s.length >= 3) {
          query.$text = { $search: s };
        } else {
          query.name = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
      }

      const [categories, productCounts] = await Promise.all([
        Category.find(query).populate('parentId', 'name slug').sort({ sortOrder: 1, createdAt: -1 }).lean(),
        Product.aggregate([
          { $match: { status: 'published', isDeleted: { $ne: true } } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
        ]),
      ]);

      const countMap = Object.create(null);
      for (const pc of productCounts) countMap[pc._id] = pc.count;
      for (const c of categories) c.productCount = countMap[c.name] || 0;

      if (flat === 'false') {
        const parents = [];
        const childrenByParent = new Map();
        for (const c of categories) {
          const pid = c.parentId?._id?.toString();
          if (!pid) {
            parents.push(c);
            continue;
          }
          childrenByParent.set(pid, [...(childrenByParent.get(pid) || []), c]);
        }
        const hierarchical = parents.map((p) => ({ ...p, children: childrenByParent.get(p._id.toString()) || [] }));
        return res.status(200).json({ message: 'Categories fetched successfully', data: hierarchical });
      }

      return res.status(200).json({ message: 'Categories fetched successfully', data: categories });
    } catch (error) {
      console.error('List categories error:', error);
      return res.status(400).json({ message: 'Error fetching categories', error: error.message });
    }
  },

  // POST /categories - multipart: name, slug, description?, active?, parentId?, thumbnail[], banner
  createCategory: async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const slug = String(body.slug || '').trim().toLowerCase();
      if (!name || !slug) {
        return res.status(400).json({ message: 'name and slug are required' });
      }

      const parentId = parentIdOf(body.parentId);
      if (parentId && !(await Category.findById(parentId))) {
        return res.status(400).json({ message: 'Parent category not found' });
      }

      const newThumbnailUrls = [];
      for (const file of req.files?.thumbnail || []) newThumbnailUrls.push(await storeFile(file, 'categories/thumbnails'));
      const bannerFile = req.files?.banner?.[0];
      const thumbnailUrls = [...(keptThumbnailUrls(body) || []), ...newThumbnailUrls];

      const created = await Category.create({
        name,
        slug,
        description: String(body.description || '').trim(),
        active: body.active === undefined ? true : toBool(body.active),
        // single thumbnailUrl = the first one (older screens read it)
        thumbnailUrl: thumbnailUrls[0] || null,
        thumbnailUrls,
        bannerUrl: bannerFile ? await storeFile(bannerFile, 'categories/banners') : null,
        parentId,
      });

      return res.status(201).json({ message: 'Category created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create category error:', error);
      return res.status(400).json({ message: 'Error creating category', error: error.message });
    }
  },

  // PUT /categories/:id - same fields as create, all optional
  updateCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.description !== 'undefined') updates.description = String(payload.description || '').trim();
      if (typeof payload.active !== 'undefined') updates.active = toBool(payload.active);

      if (typeof payload.parentId !== 'undefined') {
        const parentId = parentIdOf(payload.parentId);
        if (parentId) {
          if (String(parentId) === String(id)) {
            return res.status(400).json({ message: 'Category cannot be its own parent' });
          }
          if (!(await Category.findById(parentId))) {
            return res.status(400).json({ message: 'Parent category not found' });
          }
        }
        updates.parentId = parentId;
      }

      const newThumbnailUrls = [];
      for (const file of req.files?.thumbnail || []) newThumbnailUrls.push(await storeFile(file, 'categories/thumbnails'));
      const bannerFile = req.files?.banner?.[0];
      if (bannerFile) updates.bannerUrl = await storeFile(bannerFile, 'categories/banners');

      // Only touch the thumbnails when the form sent the kept list or new files.
      const kept = keptThumbnailUrls(payload);
      if (kept !== undefined || newThumbnailUrls.length > 0) {
        updates.thumbnailUrls = [...(kept || []), ...newThumbnailUrls];
        updates.thumbnailUrl = updates.thumbnailUrls[0] || null;
      }

      const updated = await Category.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
      if (!updated) {
        return res.status(404).json({ message: 'Category not found' });
      }

      return res.status(200).json({ message: 'Category updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update category error:', error);
      return res.status(400).json({ message: 'Error updating category', error: error.message });
    }
  },

  // PUT /categories/reorder - reorder categories
  reorderCategories: async (req, res) => {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ message: 'Items array is required' });
      }

      const bulkOps = items.map((item, index) => ({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { sortOrder: index } },
        },
      }));

      await Category.bulkWrite(bulkOps);
      const categories = await Category.find()
        .populate('parentId', 'name slug')
        .sort({ sortOrder: 1, createdAt: -1 });

      return res.status(200).json({ message: 'Categories reordered successfully', data: categories });
    } catch (error) {
      console.error('Reorder categories error:', error);
      return res.status(400).json({ message: 'Error reordering categories', error: error.message });
    }
  },

  // DELETE /categories/:id - delete a category (its children move to the top level)
  deleteCategory: async (req, res) => {
    try {
      const { id } = req.params;

      const childCount = await Category.countDocuments({ parentId: id });
      if (childCount > 0) {
        await Category.updateMany({ parentId: id }, { $set: { parentId: null } });
      }

      const deleted = await Category.softDeleteById(id, req.user?._id || null);
      if (!deleted) {
        return res.status(404).json({ message: 'Category not found' });
      }

      return res.status(200).json({
        message: 'Category deleted successfully',
        id,
        childrenMoved: childCount,
      });
    } catch (error) {
      console.error('Delete category error:', error);
      return res.status(400).json({ message: 'Error deleting category', error: error.message });
    }
  },
};

module.exports = categoryController;
