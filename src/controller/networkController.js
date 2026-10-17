// src/controller/networkController.js
//
// Easyload register: networks (Jazz, Zong, ...) and their per-day balance sheet.

const Network = require('../models/network');
const NetworkDay = require('../models/networkDay');
const { paginate, buildRegexSearchFilter, readPagingQuery } = require('../helper/paginate');

const NETWORK_SORTABLE = ['createdAt', 'name', 'code'];
const NETWORK_SEARCH_FIELDS = ['name', 'code', 'notes'];

// The shop books its day on Pakistan local time, not the server's timezone.
const SHOP_TIMEZONE = 'Asia/Karachi';

// Seeded the first time the list is opened on an empty collection.
const DEFAULT_NETWORKS = [
    { name: 'Jazz', code: 'JAZZ', color: '#E4002B' },
    { name: 'Zong', code: 'ZONG', color: '#00A99D' },
    { name: 'Telenor', code: 'TELENOR', color: '#00A9E0' },
    { name: 'Ufone', code: 'UFONE', color: '#F58220' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date as 'YYYY-MM-DD' in the shop's timezone. */
function todayString() {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: SHOP_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function isValidDateString(value) {
    if (!DATE_RE.test(String(value || ''))) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Attach the derived figures to a day row. Nothing here is stored — it is all
 * recomputed from openingBalance / loads / closingBalance so the numbers can
 * never drift out of sync with their inputs.
 */
function decorateDay(day) {
    const loads = Array.isArray(day?.loads) ? day.loads : [];
    const loadTotal = loads.reduce((sum, l) => sum + (Number(l?.amount) || 0), 0);
    const opening = Number(day?.openingBalance) || 0;
    const closing = day?.closingBalance === null || day?.closingBalance === undefined
        ? null
        : Number(day.closingBalance);

    return {
        ...day,
        loads,
        loadTotal,
        // What we should be holding before today's sales are deducted.
        expectedBalance: opening + loadTotal,
        // Only knowable once the day has been closed off.
        sold: closing === null ? null : opening + loadTotal - closing,
        isClosed: closing !== null,
    };
}

/** Most recent closing balance strictly before `date`, or 0 if there is none. */
async function carriedOpeningBalance(networkId, date) {
    const previous = await NetworkDay.findOne({
        network: networkId,
        date: { $lt: date },
        closingBalance: { $ne: null },
        isDeleted: { $ne: true },
    })
        .sort({ date: -1 })
        .select('closingBalance')
        .lean();

    return previous ? Number(previous.closingBalance) || 0 : 0;
}

/**
 * The day row for (network, date). When the row does not exist yet this returns
 * an unsaved shape with the opening balance already carried over, so the UI can
 * render the day before anything has been typed into it.
 */
async function readDay(networkId, date) {
    const existing = await NetworkDay.findOne({
        network: networkId,
        date,
        isDeleted: { $ne: true },
    }).lean();

    if (existing) return decorateDay(existing);

    return decorateDay({
        _id: null,
        network: networkId,
        date,
        openingBalance: await carriedOpeningBalance(networkId, date),
        closingBalance: null,
        loads: [],
        notes: '',
    });
}

/** Create the row on demand, carrying the opening balance over on first touch. */
async function readOrCreateDay(networkId, date) {
    const existing = await NetworkDay.findOne({
        network: networkId,
        date,
        isDeleted: { $ne: true },
    });
    if (existing) return existing;

    return NetworkDay.create({
        network: networkId,
        date,
        openingBalance: await carriedOpeningBalance(networkId, date),
        closingBalance: null,
        loads: [],
    });
}

const networkController = {
    // GET /networks — list with each network's position for a given day
    getAllNetworks: async (req, res) => {
        try {
            const { search, isActive } = req.query;
            const date = isValidDateString(req.query.date) ? req.query.date : todayString();

            // First run on a fresh install: give the shop the operators it
            // actually uses instead of an empty screen.
            const liveCount = await Network.countDocuments({ isDeleted: { $ne: true } });
            if (liveCount === 0) {
                await Network.insertMany(DEFAULT_NETWORKS);
            }

            const filter = { isDeleted: { $ne: true } };
            if (isActive === 'true') filter.isActive = true;
            else if (isActive === 'false') filter.isActive = false;

            const regexFilter = buildRegexSearchFilter(search, NETWORK_SEARCH_FIELDS);
            if (regexFilter) Object.assign(filter, regexFilter);

            const paging = readPagingQuery(req.query, {
                defaultSortBy: 'name',
                defaultSortDir: 'asc',
                allowedSortFields: NETWORK_SORTABLE,
            });

            const { items, pagination } = await paginate(Network, { filter, ...paging });

            const withDay = await Promise.all(
                items.map(async (network) => ({
                    ...network,
                    today: await readDay(network._id, date),
                }))
            );

            return res.status(200).json({
                message: 'Networks fetched successfully',
                data: withDay,
                date,
                pagination,
            });
        } catch (error) {
            console.error('Error fetching networks:', error);
            return res.status(500).json({ message: 'Failed to fetch networks' });
        }
    },

    // GET /networks/:id
    getNetworkById: async (req, res) => {
        try {
            const { id } = req.params;
            const date = isValidDateString(req.query.date) ? req.query.date : todayString();

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            return res.status(200).json({
                message: 'Network fetched successfully',
                data: { ...network, today: await readDay(network._id, date) },
                date,
            });
        } catch (error) {
            console.error('Error fetching network:', error);
            return res.status(500).json({ message: 'Failed to fetch network' });
        }
    },

    // POST /networks
    createNetwork: async (req, res) => {
        try {
            const { name, code, color, notes } = req.body;

            if (!name || !String(name).trim()) {
                return res.status(400).json({ message: 'Network name is required' });
            }

            const trimmedName = String(name).trim();
            const finalCode = String(code || trimmedName)
                .trim()
                .toUpperCase()
                .replace(/\s+/g, '-');

            if (!finalCode) {
                return res.status(400).json({ message: 'Network code is required' });
            }

            const clash = await Network.findOne({ code: finalCode, isDeleted: { $ne: true } }).lean();
            if (clash) {
                return res.status(409).json({ message: `A network with code ${finalCode} already exists` });
            }

            const network = await Network.create({
                name: trimmedName,
                code: finalCode,
                color: String(color || '#dc2626').trim(),
                notes: String(notes || '').trim(),
            });

            return res.status(201).json({
                message: 'Network created successfully',
                data: network,
            });
        } catch (error) {
            if (error?.code === 11000) {
                return res.status(409).json({ message: 'A network with that code already exists' });
            }
            console.error('Error creating network:', error);
            return res.status(500).json({ message: 'Failed to create network' });
        }
    },

    // PUT /networks/:id
    updateNetwork: async (req, res) => {
        try {
            const { id } = req.params;
            const { name, code, color, notes, isActive } = req.body;

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            if (name !== undefined) {
                if (!String(name).trim()) {
                    return res.status(400).json({ message: 'Network name cannot be empty' });
                }
                network.name = String(name).trim();
            }

            if (code !== undefined) {
                const finalCode = String(code).trim().toUpperCase().replace(/\s+/g, '-');
                if (!finalCode) {
                    return res.status(400).json({ message: 'Network code cannot be empty' });
                }
                const clash = await Network.findOne({
                    code: finalCode,
                    _id: { $ne: network._id },
                    isDeleted: { $ne: true },
                }).lean();
                if (clash) {
                    return res.status(409).json({ message: `A network with code ${finalCode} already exists` });
                }
                network.code = finalCode;
            }

            if (color !== undefined) network.color = String(color || '#dc2626').trim();
            if (notes !== undefined) network.notes = String(notes || '').trim();
            if (isActive !== undefined) network.isActive = Boolean(isActive);

            await network.save();

            return res.status(200).json({
                message: 'Network updated successfully',
                data: network,
            });
        } catch (error) {
            if (error?.code === 11000) {
                return res.status(409).json({ message: 'A network with that code already exists' });
            }
            console.error('Error updating network:', error);
            return res.status(500).json({ message: 'Failed to update network' });
        }
    },

    // DELETE /networks/:id — soft delete
    deleteNetwork: async (req, res) => {
        try {
            const { id } = req.params;

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            network.isDeleted = true;
            network.deletedAt = new Date();
            network.deletedBy = req.user?.id || req.user?._id || null;
            await network.save();

            return res.status(200).json({
                message: 'Network deleted successfully',
                data: network,
            });
        } catch (error) {
            console.error('Error deleting network:', error);
            return res.status(500).json({ message: 'Failed to delete network' });
        }
    },

    // GET /networks/:id/days — the ledger, newest first
    getNetworkDays: async (req, res) => {
        try {
            const { id } = req.params;
            const { from, to } = req.query;

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            const filter = { network: network._id, isDeleted: { $ne: true } };
            if (isValidDateString(from) || isValidDateString(to)) {
                filter.date = {};
                if (isValidDateString(from)) filter.date.$gte = from;
                if (isValidDateString(to)) filter.date.$lte = to;
            }

            const { items, pagination } = await paginate(NetworkDay, {
                filter,
                page: req.query.page,
                limit: req.query.limit,
                sort: { date: -1 },
            });

            return res.status(200).json({
                message: 'Network days fetched successfully',
                data: items.map(decorateDay),
                pagination,
            });
        } catch (error) {
            console.error('Error fetching network days:', error);
            return res.status(500).json({ message: 'Failed to fetch network days' });
        }
    },

    // GET /networks/:id/days/:date
    getNetworkDay: async (req, res) => {
        try {
            const { id, date } = req.params;

            if (!isValidDateString(date)) {
                return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
            }

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            return res.status(200).json({
                message: 'Network day fetched successfully',
                data: await readDay(network._id, date),
            });
        } catch (error) {
            console.error('Error fetching network day:', error);
            return res.status(500).json({ message: 'Failed to fetch network day' });
        }
    },

    // PUT /networks/:id/days/:date — set opening / closing balance for the day
    upsertNetworkDay: async (req, res) => {
        try {
            const { id, date } = req.params;
            const { openingBalance, closingBalance, notes } = req.body;

            if (!isValidDateString(date)) {
                return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
            }

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            const day = await readOrCreateDay(network._id, date);

            if (openingBalance !== undefined) {
                const value = toFiniteNumber(openingBalance);
                if (value === null || value < 0) {
                    return res.status(400).json({ message: 'openingBalance must be a number of 0 or more' });
                }
                day.openingBalance = value;
            }

            // Passing null re-opens a day that was closed by mistake.
            if (closingBalance !== undefined) {
                if (closingBalance === null || closingBalance === '') {
                    day.closingBalance = null;
                } else {
                    const value = toFiniteNumber(closingBalance);
                    if (value === null || value < 0) {
                        return res.status(400).json({ message: 'closingBalance must be a number of 0 or more' });
                    }
                    day.closingBalance = value;
                }
            }

            if (notes !== undefined) day.notes = String(notes || '').trim();

            await day.save();

            return res.status(200).json({
                message: 'Day saved successfully',
                data: decorateDay(day.toObject()),
            });
        } catch (error) {
            console.error('Error saving network day:', error);
            return res.status(500).json({ message: 'Failed to save day' });
        }
    },

    // POST /networks/:id/days/:date/loads — record a top-up from the provider
    addLoad: async (req, res) => {
        try {
            const { id, date } = req.params;
            const { amount, provider, reference, note } = req.body;

            if (!isValidDateString(date)) {
                return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
            }

            const value = toFiniteNumber(amount);
            if (value === null || value <= 0) {
                return res.status(400).json({ message: 'Load amount must be greater than 0' });
            }

            const network = await Network.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
            if (!network) {
                return res.status(404).json({ message: 'Network not found' });
            }

            const day = await readOrCreateDay(network._id, date);

            day.loads.push({
                amount: value,
                provider: String(provider || '').trim(),
                reference: String(reference || '').trim(),
                note: String(note || '').trim(),
                at: new Date(),
                addedBy: req.user?.id || req.user?._id || null,
            });

            await day.save();

            return res.status(201).json({
                message: 'Load added successfully',
                data: decorateDay(day.toObject()),
            });
        } catch (error) {
            console.error('Error adding load:', error);
            return res.status(500).json({ message: 'Failed to add load' });
        }
    },

    // DELETE /networks/:id/days/:date/loads/:loadId
    deleteLoad: async (req, res) => {
        try {
            const { id, date, loadId } = req.params;

            if (!isValidDateString(date)) {
                return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
            }

            const day = await NetworkDay.findOne({
                network: id,
                date,
                isDeleted: { $ne: true },
            });

            if (!day) {
                return res.status(404).json({ message: 'No record for that day' });
            }

            const entry = day.loads.id(loadId);
            if (!entry) {
                return res.status(404).json({ message: 'Load entry not found' });
            }

            entry.deleteOne();
            await day.save();

            return res.status(200).json({
                message: 'Load removed successfully',
                data: decorateDay(day.toObject()),
            });
        } catch (error) {
            console.error('Error deleting load:', error);
            return res.status(500).json({ message: 'Failed to delete load' });
        }
    },
};

module.exports = networkController;
module.exports.todayString = todayString;
module.exports.DEFAULT_NETWORKS = DEFAULT_NETWORKS;
