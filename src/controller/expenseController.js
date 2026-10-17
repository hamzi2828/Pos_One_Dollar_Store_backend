// src/controller/expenseController.js

const Expense = require('../models/expense');
const ExpenseCategory = require('../models/expenseCategory');
const { uploadToBlob, deleteFromBlob } = require('../helper/blobUpload');
const { toPublicPath } = require('../helper/upload');
const { paginate, buildRegexSearchFilter, readPagingQuery } = require('../helper/paginate');
const { resolveWriteBranch } = require('../middleware/access');
const { scopedBranchFilter } = require('../helper/branchScope');

// Expenses are per branch (categories are shared). Old expenses without a
// branch belong to the main branch.

// Check if using Vercel Blob storage
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

const EXPENSE_SORTABLE = ['date', 'createdAt', 'amount', 'title', 'category'];
const EXPENSE_SEARCH_FIELDS = ['title', 'category', 'reference', 'notes'];

const expenseController = {
    // GET /expenses
    getAllExpenses: async (req, res) => {
        try {
            const { search, category, paymentMethod, isActive, startDate, endDate, minAmount, maxAmount } = req.query;

            const filter = { isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) };
            if (category) filter.category = category;
            if (paymentMethod) filter.paymentMethod = paymentMethod;
            if (isActive === 'true') filter.isActive = true;
            else if (isActive === 'false') filter.isActive = false;
            if (startDate || endDate) {
                filter.date = {};
                if (startDate) filter.date.$gte = new Date(startDate);
                if (endDate) {
                    const end = new Date(endDate);
                    end.setHours(23, 59, 59, 999);
                    filter.date.$lte = end;
                }
            }
            if (minAmount || maxAmount) {
                filter.amount = {};
                if (minAmount) filter.amount.$gte = Number(minAmount);
                if (maxAmount) filter.amount.$lte = Number(maxAmount);
            }

            const regexFilter = buildRegexSearchFilter(search, EXPENSE_SEARCH_FIELDS);
            if (regexFilter) Object.assign(filter, regexFilter);

            const paging = readPagingQuery(req.query, {
                defaultSortBy: 'date',
                defaultSortDir: 'desc',
                allowedSortFields: EXPENSE_SORTABLE,
            });

            const { items, pagination } = await paginate(Expense, { filter, ...paging });

            return res.status(200).json({
                message: 'Expenses fetched successfully',
                data: items,
                pagination,
            });
        } catch (error) {
            console.error('Error fetching expenses:', error);
            return res.status(500).json({ message: 'Failed to fetch expenses' });
        }
    },

    // GET /expenses/:id
    getExpenseById: async (req, res) => {
        try {
            const { id } = req.params;
            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) }).lean();

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense fetched successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error fetching expense:', error);
            return res.status(500).json({ message: 'Failed to fetch expense' });
        }
    },

    // POST /expenses - Create new expense
    createExpense: async (req, res) => {
        try {
            const { title, amount, category, categories, date, paymentMethod, reference, notes } = req.body;

            if (!title || !title.trim()) {
                return res.status(400).json({ message: 'Expense title is required' });
            }
            if (amount === undefined || amount === null || isNaN(amount)) {
                return res.status(400).json({ message: 'Valid amount is required' });
            }
            if (amount < 0) {
                return res.status(400).json({ message: 'Amount cannot be negative' });
            }

            // Parse categories - support both single category and array of categories
            let parsedCategories = [];
            if (categories) {
                try {
                    parsedCategories = typeof categories === 'string' ? JSON.parse(categories) : categories;
                } catch {
                    parsedCategories = [categories];
                }
            }

            // Fallback to single category if no categories array
            const categoryValue = parsedCategories.length > 0
                ? parsedCategories.join(', ')
                : (category?.trim() || '');

            if (!categoryValue) {
                return res.status(400).json({ message: 'Category is required' });
            }

            let branch;
            try {
                branch = await resolveWriteBranch(req);
            } catch (err) {
                if (err.status) return res.status(err.status).json({ message: err.message });
                throw err;
            }

            // Handle receipt file upload
            let receiptUrl = null;
            if (req.file) {
                if (USE_BLOB_STORAGE) {
                    receiptUrl = await uploadToBlob(
                        req.file.buffer,
                        req.file.originalname,
                        req.file.mimetype,
                        'expenses/receipts'
                    );
                } else {
                    receiptUrl = toPublicPath(req.file.filename);
                }
            }

            const expense = await Expense.create({
                branch,
                title: title.trim(),
                amount: Number(amount),
                category: categoryValue,
                categories: parsedCategories,
                date: date ? new Date(date) : new Date(),
                paymentMethod: paymentMethod?.trim() || 'Cash',
                reference: reference?.trim() || '',
                notes: notes?.trim() || '',
                receipt: receiptUrl,
            });

            return res.status(201).json({
                message: 'Expense created successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error creating expense:', error);
            return res.status(500).json({ message: 'Failed to create expense' });
        }
    },

    // PUT /expenses/:id - Update expense
    updateExpense: async (req, res) => {
        try {
            const { id } = req.params;
            const { title, amount, category, date, paymentMethod, reference, notes, isActive, removeReceipt } = req.body;

            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) });
            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            // Update fields
            if (title !== undefined) expense.title = title.trim();
            if (amount !== undefined) {
                if (isNaN(amount) || amount < 0) {
                    return res.status(400).json({ message: 'Valid positive amount is required' });
                }
                expense.amount = Number(amount);
            }
            if (category !== undefined) expense.category = category.trim();
            if (date !== undefined) expense.date = new Date(date);
            if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod?.trim() || 'Cash';
            if (reference !== undefined) expense.reference = reference?.trim() || '';
            if (notes !== undefined) expense.notes = notes?.trim() || '';
            if (isActive !== undefined) expense.isActive = isActive;

            // Handle receipt file upload
            if (req.file) {
                // Delete old receipt if exists and using blob storage
                if (expense.receipt && USE_BLOB_STORAGE && expense.receipt.includes('blob')) {
                    await deleteFromBlob(expense.receipt);
                }

                if (USE_BLOB_STORAGE) {
                    expense.receipt = await uploadToBlob(
                        req.file.buffer,
                        req.file.originalname,
                        req.file.mimetype,
                        'expenses/receipts'
                    );
                } else {
                    expense.receipt = toPublicPath(req.file.filename);
                }
            } else if (removeReceipt === 'true' || removeReceipt === true) {
                // Remove existing receipt
                if (expense.receipt && USE_BLOB_STORAGE && expense.receipt.includes('blob')) {
                    await deleteFromBlob(expense.receipt);
                }
                expense.receipt = null;
            }

            await expense.save();

            return res.status(200).json({
                message: 'Expense updated successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error updating expense:', error);
            return res.status(500).json({ message: 'Failed to update expense' });
        }
    },

    // DELETE /expenses/:id - Soft delete expense
    deleteExpense: async (req, res) => {
        try {
            const { id } = req.params;

            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) });

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            expense.isDeleted = true;
            expense.deletedAt = new Date();
            expense.deletedBy = req.user?.id || req.user?._id || null;
            await expense.save();

            return res.status(200).json({
                message: 'Expense deleted successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error deleting expense:', error);
            return res.status(500).json({ message: 'Failed to delete expense' });
        }
    },

    // PUT /expenses/:id/status - Update expense status
    updateExpenseStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const expense = await Expense.findOneAndUpdate(
                { _id: id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) },
                { isActive },
                { new: true }
            );

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense status updated successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error updating expense status:', error);
            return res.status(500).json({ message: 'Failed to update expense status' });
        }
    },

    // GET /expenses/summary - Aggregate totals in-DB (avoids pulling every doc over the wire)
    getExpenseSummary: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;

            const match = { isActive: true, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) };
            if (startDate || endDate) {
                match.date = {};
                if (startDate) match.date.$gte = new Date(startDate);
                if (endDate) {
                    const endDateObj = new Date(endDate);
                    endDateObj.setHours(23, 59, 59, 999);
                    match.date.$lte = endDateObj;
                }
            }

            const [totals, byCategoryArr, byPaymentArr] = await Promise.all([
                Expense.aggregate([
                    { $match: match },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
                ]),
                Expense.aggregate([
                    { $match: match },
                    { $group: { _id: '$category', total: { $sum: '$amount' } } },
                    { $sort: { total: -1 } },
                ]),
                Expense.aggregate([
                    { $match: match },
                    { $group: { _id: '$paymentMethod', total: { $sum: '$amount' } } },
                    { $sort: { total: -1 } },
                ]),
            ]);

            const byCategory = Object.fromEntries(byCategoryArr.map(r => [r._id, r.total]));
            const byPaymentMethod = Object.fromEntries(byPaymentArr.map(r => [r._id, r.total]));
            const totalExpenses = totals[0]?.total || 0;
            const count = totals[0]?.count || 0;

            return res.status(200).json({
                message: 'Expense summary fetched successfully',
                data: { totalExpenses, count, byCategory, byPaymentMethod },
            });
        } catch (error) {
            console.error('Error fetching expense summary:', error);
            return res.status(500).json({ message: 'Failed to fetch expense summary' });
        }
    },

    // ============ Expense Categories ============

    // GET /expenses/categories - Get all expense categories
    getAllCategories: async (req, res) => {
        try {
            const categories = await ExpenseCategory
                .find({ isDeleted: { $ne: true }, isActive: true })
                .sort({ name: 1 })
                .lean();
            return res.status(200).json({
                message: 'Expense categories fetched successfully',
                data: categories
            });
        } catch (error) {
            console.error('Error fetching expense categories:', error);
            return res.status(500).json({ message: 'Failed to fetch expense categories' });
        }
    },

    // POST /expenses/categories - Create new expense category
    createCategory: async (req, res) => {
        try {
            const { name, description } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ message: 'Category name is required' });
            }

            // Check for duplicate
            const existing = await ExpenseCategory.findOne({
                name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
                isDeleted: { $ne: true }
            });

            if (existing) {
                return res.status(400).json({ message: 'Category already exists' });
            }

            const category = await ExpenseCategory.create({
                name: name.trim(),
                description: description?.trim() || ''
            });

            return res.status(201).json({
                message: 'Expense category created successfully',
                data: category
            });
        } catch (error) {
            console.error('Error creating expense category:', error);
            return res.status(500).json({ message: 'Failed to create expense category' });
        }
    },

    // DELETE /expenses/categories/:id - Delete expense category
    deleteCategory: async (req, res) => {
        try {
            const { id } = req.params;

            const category = await ExpenseCategory.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!category) {
                return res.status(404).json({ message: 'Category not found' });
            }

            category.isDeleted = true;
            category.deletedAt = new Date();
            category.deletedBy = req.user?.id || req.user?._id || null;
            await category.save();

            return res.status(200).json({
                message: 'Expense category deleted successfully',
                data: category
            });
        } catch (error) {
            console.error('Error deleting expense category:', error);
            return res.status(500).json({ message: 'Failed to delete expense category' });
        }
    },
};

module.exports = expenseController;
