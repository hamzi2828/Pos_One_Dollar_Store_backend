// src/helper/paginate.js
// Generic pagination helper for Mongoose models.
// Runs count + find in parallel, returns lean docs, clamps page/limit.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * @param {import('mongoose').Model} Model
 * @param {object} opts
 * @param {object}   [opts.filter={}]
 * @param {number}   [opts.page=1]
 * @param {number}   [opts.limit=20]
 * @param {object}   [opts.sort={ createdAt: -1 }]
 * @param {object|string} [opts.projection]
 * @param {any}      [opts.populate]     — passed to .populate()
 * @param {boolean}  [opts.lean=true]
 * @param {object}   [opts.collation]    — e.g. { locale: 'en', strength: 2 } for case-insensitive sort
 */
async function paginate(Model, opts = {}) {
    const {
        filter = {},
        sort = { createdAt: -1 },
        projection,
        populate,
        lean = true,
        collation,
    } = opts;

    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(opts.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    let query = Model.find(filter, projection).sort(sort).skip(skip).limit(limit);
    if (populate) query = query.populate(populate);
    if (collation) query = query.collation(collation);
    if (lean) query = query.lean();

    const [items, total] = await Promise.all([
        query.exec(),
        Model.countDocuments(filter),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
        items,
        pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
        },
    };
}

/**
 * Escape a user-supplied string for use inside a RegExp.
 */
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive $or filter across fields. Suitable when the caller
 * wants substring matching rather than full-text search.
 */
function buildRegexSearchFilter(search, fields) {
    const term = String(search || '').trim();
    if (!term || !fields?.length) return null;
    const regex = new RegExp(escapeRegex(term), 'i');
    return { $or: fields.map(f => ({ [f]: regex })) };
}

/**
 * Merge pagination query string ({page, limit, sortBy, sortDir}) into a
 * {page, limit, sort} triple suitable for paginate().
 */
function readPagingQuery(query, defaults = {}) {
    const {
        defaultSortBy = 'createdAt',
        defaultSortDir = 'desc',
        allowedSortFields = null, // if provided, restrict sortBy to this list
    } = defaults;

    const sortBy = (query.sortBy && (!allowedSortFields || allowedSortFields.includes(query.sortBy)))
        ? query.sortBy
        : defaultSortBy;
    const sortDir = query.sortDir === 'asc' ? 1 : (query.sortDir === 'desc' ? -1 : (defaultSortDir === 'asc' ? 1 : -1));

    return {
        page: query.page,
        limit: query.limit,
        sort: { [sortBy]: sortDir },
    };
}

module.exports = { paginate, escapeRegex, buildRegexSearchFilter, readPagingQuery };
