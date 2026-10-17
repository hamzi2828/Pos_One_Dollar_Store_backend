// src/controller/assetController.js

const Asset = require('../models/asset');
const { paginate, buildRegexSearchFilter, readPagingQuery } = require('../helper/paginate');

const ASSET_SORTABLE = ['createdAt', 'name', 'purchaseDate', 'purchasePrice', 'status', 'type'];
const ASSET_SEARCH_FIELDS = ['name', 'description', 'vendor', 'location', 'serialNumber'];

const assetController = {
    // GET /assets
    getAllAssets: async (req, res) => {
        try {
            const { search, type, status } = req.query;

            const filter = { isDeleted: { $ne: true } };
            if (type) filter.type = type;
            if (status) filter.status = status;

            const regexFilter = buildRegexSearchFilter(search, ASSET_SEARCH_FIELDS);
            if (regexFilter) Object.assign(filter, regexFilter);

            const paging = readPagingQuery(req.query, {
                defaultSortBy: 'createdAt',
                defaultSortDir: 'desc',
                allowedSortFields: ASSET_SORTABLE,
            });

            const { items, pagination } = await paginate(Asset, { filter, ...paging });

            return res.status(200).json({
                message: 'Assets fetched successfully',
                data: items,
                pagination,
            });
        } catch (error) {
            console.error('Error fetching assets:', error);
            return res.status(500).json({ message: 'Failed to fetch assets' });
        }
    },

    // GET /assets/:id
    getAssetById: async (req, res) => {
        try {
            const { id } = req.params;
            const asset = await Asset.findOne({ _id: id, isDeleted: { $ne: true } }).lean();

            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }

            return res.status(200).json({
                message: 'Asset fetched successfully',
                data: asset
            });
        } catch (error) {
            console.error('Error fetching asset:', error);
            return res.status(500).json({ message: 'Failed to fetch asset' });
        }
    },

    // POST /assets - Create new asset
    createAsset: async (req, res) => {
        try {
            const {
                name,
                type,
                description,
                purchasePrice,
                currentValue,
                purchaseDate,
                vendor,
                location,
                serialNumber,
                status,
                notes
            } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ message: 'Asset name is required' });
            }
            if (purchasePrice === undefined || purchasePrice === null) {
                return res.status(400).json({ message: 'Purchase price is required' });
            }
            if (!purchaseDate) {
                return res.status(400).json({ message: 'Purchase date is required' });
            }

            const asset = await Asset.create({
                name: name.trim(),
                type: type || 'other',
                description: description?.trim() || '',
                purchasePrice: Number(purchasePrice),
                currentValue: currentValue ? Number(currentValue) : null,
                purchaseDate: new Date(purchaseDate),
                vendor: vendor?.trim() || '',
                location: location?.trim() || '',
                serialNumber: serialNumber?.trim() || '',
                status: status || 'active',
                notes: notes?.trim() || '',
            });

            return res.status(201).json({
                message: 'Asset created successfully',
                data: asset
            });
        } catch (error) {
            console.error('Error creating asset:', error);
            return res.status(500).json({ message: 'Failed to create asset' });
        }
    },

    // PUT /assets/:id - Update asset
    updateAsset: async (req, res) => {
        try {
            const { id } = req.params;
            const {
                name,
                type,
                description,
                purchasePrice,
                currentValue,
                purchaseDate,
                vendor,
                location,
                serialNumber,
                status,
                notes
            } = req.body;

            const asset = await Asset.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }

            // Update fields
            if (name !== undefined) asset.name = name.trim();
            if (type !== undefined) asset.type = type;
            if (description !== undefined) asset.description = description?.trim() || '';
            if (purchasePrice !== undefined) asset.purchasePrice = Number(purchasePrice);
            if (currentValue !== undefined) asset.currentValue = currentValue ? Number(currentValue) : null;
            if (purchaseDate !== undefined) asset.purchaseDate = new Date(purchaseDate);
            if (vendor !== undefined) asset.vendor = vendor?.trim() || '';
            if (location !== undefined) asset.location = location?.trim() || '';
            if (serialNumber !== undefined) asset.serialNumber = serialNumber?.trim() || '';
            if (status !== undefined) asset.status = status;
            if (notes !== undefined) asset.notes = notes?.trim() || '';

            await asset.save();

            return res.status(200).json({
                message: 'Asset updated successfully',
                data: asset
            });
        } catch (error) {
            console.error('Error updating asset:', error);
            return res.status(500).json({ message: 'Failed to update asset' });
        }
    },

    // DELETE /assets/:id - Soft delete asset
    deleteAsset: async (req, res) => {
        try {
            const { id } = req.params;

            const asset = await Asset.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }

            asset.isDeleted = true;
            asset.deletedAt = new Date();
            asset.deletedBy = req.user?.id || req.user?._id || null;
            await asset.save();

            return res.status(200).json({
                message: 'Asset deleted successfully',
                data: asset
            });
        } catch (error) {
            console.error('Error deleting asset:', error);
            return res.status(500).json({ message: 'Failed to delete asset' });
        }
    },

    // PUT /assets/:id/status - Update asset status
    updateAssetStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const validStatuses = ['active', 'maintenance', 'sold', 'disposed'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ message: 'Invalid status value' });
            }

            const asset = await Asset.findByIdAndUpdate(
                id,
                { status },
                { new: true }
            );

            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }

            return res.status(200).json({
                message: 'Asset status updated successfully',
                data: asset
            });
        } catch (error) {
            console.error('Error updating asset status:', error);
            return res.status(500).json({ message: 'Failed to update asset status' });
        }
    },
};

module.exports = assetController;
