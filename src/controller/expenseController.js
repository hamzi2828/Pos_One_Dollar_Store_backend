// src/controller/expenseController.js

const Expense = require('../models/expense');
const ExpenseCategory = require('../models/expenseCategory');
const { uploadToBlob, deleteFromBlob } = require('../helper/blobUpload');
const { toPublicPath } = require('../helper/upload');
const { paginate, buildRegexSearchFilter, readPagingQuery } = require('../helper/paginate');
const { resolveWriteBranch } = require('../middleware/access');

// Expenses of the shop (stamped with the shop's branch id).

// Check if using Vercel Blob storage
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

const EXPENSE_SORTABLE = ['date', 'createdAt', 'amount', 'title', 'category'];
const EXPENSE_SEARCH_FIELDS = ['title', 'category', 'reference', 'notes'];

const invLink = require('../services/investmentExpenseLink');
const loanService = require('../services/loanService');
const isYes = (v) => v === true || v === 'true';

// ----- Receipt / slip images (many per expense) -----
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('../helper/upload');
const MAX_RECEIPTS = 10;

// Expense for the answer, with `receipts` filled (old single receipt = first item).
const withReceipts = (e) => {
    if (!e) return e;
    const o = typeof e.toObject === 'function' ? e.toObject() : { ...e };
    o.receipts = Expense.receiptsOf(o);
    return o;
};

// Uploaded files: new field `receipts` (many) and old field `receipt` (one).
const pickFiles = (req) => {
    const f = req.files || {};
    if (Array.isArray(f)) return f;
    return [...(f.receipts || []), ...(f.receipt || []), ...(req.file ? [req.file] : [])];
};

// Drop files multer already wrote to disk when we refuse the request.
const dropLocal = (files) => {
    for (const f of files) {
        if (f && f.filename) {
            try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(f.filename))); } catch { /* gone */ }
        }
    }
};

const saveFiles = async (files) => {
    const out = [];
    for (const f of files) {
        const url = USE_BLOB_STORAGE
            ? await uploadToBlob(f.buffer, f.originalname, f.mimetype, 'expenses/receipts')
            : toPublicPath(f.filename);
        out.push({ url, originalName: f.originalname || '', uploadedAt: new Date() });
    }
    return out;
};

const dropBlob = async (url) => {
    if (url && USE_BLOB_STORAGE && url.includes('blob')) {
        try { await deleteFromBlob(url); } catch (e) { console.error('Could not delete receipt:', e.message); }
    }
};

// removeReceipts: array, JSON array string, or one url.
const toUrlList = (v) => {
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) return v.flatMap(toUrlList);
    if (typeof v === 'string' && v.trim().startsWith('[')) {
        try { return toUrlList(JSON.parse(v)); } catch { return [v]; }
    }
    return [String(v)];
};

const expenseController = {
    // GET /expenses
    getAllExpenses: async (req, res) => {
        try {
            const { search, category, paymentMethod, isActive, startDate, endDate, minAmount, maxAmount } = req.query;

            const filter = { isDeleted: { $ne: true } };
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

            // Same date -> newest entry first (dates have no time, so ties are common).
            paging.sort = { ...paging.sort, createdAt: -1, _id: -1 };
            const { items, pagination } = await paginate(Expense, { filter, ...paging });

            return res.status(200).json({
                message: 'Expenses fetched successfully',
                data: items.map(withReceipts),
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
            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } }).lean();

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense fetched successfully',
                data: withReceipts(expense)
            });
        } catch (error) {
            console.error('Error fetching expense:', error);
            return res.status(500).json({ message: 'Failed to fetch expense' });
        }
    },

    // GET /expenses/investment-bills - investment bills with something left to pay
    getInvestmentBills: async (req, res) => {
        try {
            return res.json({ success: true, data: await invLink.openBills() });
        } catch (error) {
            console.error('Error loading investment bills:', error);
            return res.status(500).json({ message: 'Failed to load investment bills' });
        }
    },

    // GET /expenses/banks - our bank accounts for the "Bank" dropdown
    getBankOptions: async (req, res) => {
        try {
            const Bank = require('../models/bank');
            const data = await Bank.find({ isDeleted: { $ne: true }, isActive: { $ne: false } })
                .select('name accountTitle accountNumber')
                .sort({ name: 1 })
                .lean();
            return res.json({ success: true, data });
        } catch (error) {
            console.error('Error loading banks:', error);
            return res.status(500).json({ message: 'Failed to load bank accounts' });
        }
    },

    // GET /expenses/counters - live sale counters for the "Paid from" dropdown
    getCounterOptions: async (req, res) => {
        try {
            const SaleCounter = require('../models/saleCounter');
            const data = await SaleCounter.find({ isActive: true }).select('name code').sort({ name: 1 }).lean();
            return res.json({ success: true, data });
        } catch (error) {
            console.error('Error loading counters:', error);
            return res.status(500).json({ message: 'Failed to load counters' });
        }
    },

    // POST /expenses - Create new expense
    createExpense: async (req, res) => {
        const files = pickFiles(req);
        try {
            if (files.length > MAX_RECEIPTS) {
                dropLocal(files);
                return res.status(400).json({ message: `At most ${MAX_RECEIPTS} receipt images` });
            }
            const { title, amount, category, categories, date, paymentMethod, reference, notes } = req.body;
            const bankPick = await bankFor(paymentMethod, req.body.bankId);
            if (bankPick.error) return res.status(400).json({ message: bankPick.error });
            const counterPick = await counterFor(req.body.counter);
            if (counterPick.error) return res.status(400).json({ message: counterPick.error });
            let invPick = null;
            try {
                invPick = await invLink.checkLink(req.body.investmentId, Number(amount));
            } catch (e) {
                return res.status(e.status || 400).json({ message: e.message });
            }

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

            // Paid from personal money -> a loan from that person is made too.
            const fromPersonal = isYes(req.body.fromPersonal);
            // Owner 2026-11-10: cash out of a drawer must say which counter, or the till math goes wrong.
            if ((paymentMethod?.trim() || 'Cash') === 'Cash' && !fromPersonal && !counterPick.counter && (await require('../models/saleCounter').countDocuments({ isActive: true, isDeleted: { $ne: true } })) > 0) {
                dropLocal(files);
                return res.status(400).json({ message: 'Pick which counter paid it (Paid from Counter 1 / Counter 2).' });
            }
            if (fromPersonal && !req.body.lenderId) {
                return res.status(400).json({ message: 'Pick whose personal money paid it' });
            }

            const branch = await resolveWriteBranch(req);

            // Receipt images (first one also kept in `receipt` for old screens)
            const receipts = await saveFiles(files);

            const expense = await Expense.create({
                branch,
                title: title.trim(),
                amount: Number(amount),
                category: categoryValue,
                categories: parsedCategories,
                date: date ? new Date(date) : new Date(),
                paymentMethod: paymentMethod?.trim() || 'Cash',
                bank: bankPick.bank,
                bankName: bankPick.bankName,
                counter: counterPick.counter,
                counterName: counterPick.counterName,
                investment: invPick ? invPick._id : null,
                investmentTitle: invPick ? invPick.title : '',
                reference: reference?.trim() || '',
                notes: notes?.trim() || '',
                receipt: receipts.length ? receipts[0].url : null,
                receipts,
                fromPersonal,
            });
            if (invPick) await invLink.sync(expense);
            if (fromPersonal) {
                try {
                    const loan = await loanService.createForExpense(expense, { lenderType: 'person', lender: req.body.lenderId }, { user: req.user });
                    expense.loan = loan._id;
                    expense.loanNo = loan.loanNo;
                    await expense.save();
                } catch (e) {
                    // No half records: drop the expense if the loan could not be made.
                    await Expense.deleteOne({ _id: expense._id });
                    return res.status(e.status || 400).json({ message: e.message || 'Could not add the loan' });
                }
            }

            return res.status(201).json({
                message: 'Expense created successfully',
                data: withReceipts(expense)
            });
        } catch (error) {
            console.error('Error creating expense:', error);
            return res.status(500).json({ message: 'Failed to create expense' });
        }
    },

    // POST /expenses/:id/adjust { amount (+ or −), note } - change the amount with a logged adjustment.
    adjustExpense: async (req, res) => {
        try {
            const { id } = req.params;
            const delta = Math.round(Number(req.body && req.body.amount) * 100) / 100;
            const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
            if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ message: 'Enter the adjustment amount (+ or −).' });
            if (!note) return res.status(400).json({ message: 'Write why the amount changes.' });
            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!expense) return res.status(404).json({ message: 'Expense not found' });
            const next = Math.round((Number(expense.amount) + delta) * 100) / 100;
            if (next < 0) return res.status(400).json({ message: `The amount cannot go below 0 (now Rs ${expense.amount}).` });
            if (expense.investment) {
                try {
                    await invLink.checkLink(expense.investment, next, expense._id);
                } catch (e) {
                    return res.status(e.status || 400).json({ message: e.message });
                }
            }
            try {
                await loanService.checkExpenseAmount(expense, next);
            } catch (e) {
                return res.status(e.status || 400).json({ message: e.message });
            }
            if (expense.originalAmount === null || expense.originalAmount === undefined) expense.originalAmount = expense.amount;
            const u = req.user || {};
            expense.adjustments.push({
                amount: delta,
                note,
                by: req.access && req.access.userId ? req.access.userId : null,
                byName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '',
                at: new Date(),
            });
            expense.amount = next;
            await expense.save();
            await loanService.syncFromExpense(expense);
            res.json({ success: true, data: withReceipts(expense), message: `Amount is now Rs ${next}` });
        } catch (error) {
            res.status(500).json({ message: error.message || 'Could not add the adjustment' });
        }
    },

    // PUT /expenses/:id - Update expense
    updateExpense: async (req, res) => {
        const files = pickFiles(req);
        try {
            const { id } = req.params;
            const { title, amount, category, date, paymentMethod, reference, notes, isActive, removeReceipt } = req.body;

            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!expense) {
                dropLocal(files);
                return res.status(404).json({ message: 'Expense not found' });
            }

            // Receipts after this edit: old list (or old single receipt), minus removed, plus new.
            // Old screens send one `receipt` file to replace the old image.
            const current = Expense.receiptsOf(expense);
            const oldReplace = !(req.files && req.files.receipts) && files.length > 0;
            const removeAll = isYes(removeReceipt) || oldReplace;
            const removeSet = new Set(toUrlList(req.body.removeReceipts));
            const kept = removeAll ? [] : current.filter((r) => !removeSet.has(r.url));
            const gone = current.filter((r) => !kept.includes(r));
            if (kept.length + files.length > MAX_RECEIPTS) {
                dropLocal(files);
                return res.status(400).json({ message: `At most ${MAX_RECEIPTS} receipt images (${kept.length} already saved)` });
            }

            // Update fields
            if (title !== undefined) expense.title = title.trim();
            // The amount is changed only by a + / − adjustment (POST /expenses/:id/adjust).
            if (amount !== undefined && Math.abs(Number(amount) - Number(expense.amount)) >= 0.01) {
                return res.status(400).json({ message: 'The amount cannot be edited. Add a + or − adjustment instead.' });
            }
            if (category !== undefined) expense.category = category.trim();
            if (date !== undefined) expense.date = new Date(date);
            if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod?.trim() || 'Cash';
            const invChanged = req.body.investmentId !== undefined;
            if (invChanged || amount !== undefined) {
                const want = invChanged ? req.body.investmentId : expense.investment;
                try {
                    const pick = await invLink.checkLink(want, expense.amount, expense._id);
                    expense.investment = pick ? pick._id : null;
                    expense.investmentTitle = pick ? pick.title : '';
                } catch (e) {
                    return res.status(e.status || 400).json({ message: e.message });
                }
            }
            if (paymentMethod !== undefined || req.body.bankId !== undefined) {
                const bankPick = await bankFor(expense.paymentMethod, req.body.bankId !== undefined ? req.body.bankId : expense.bank);
                if (bankPick.error) return res.status(400).json({ message: bankPick.error });
                expense.bank = bankPick.bank;
                expense.bankName = bankPick.bankName;
            }
            if (req.body.counter !== undefined) {
                const counterPick = await counterFor(req.body.counter, expense.counter);
                if (counterPick.error) return res.status(400).json({ message: counterPick.error });
                expense.counter = counterPick.counter;
                expense.counterName = counterPick.counterName;
            }
            if (reference !== undefined) expense.reference = reference?.trim() || '';
            if (notes !== undefined) expense.notes = notes?.trim() || '';
            if (isActive !== undefined) expense.isActive = isActive;

            // Receipt images: kept + new; the first one is also kept in `receipt`.
            if (files.length || gone.length || (!expense.receipts.length && current.length)) {
                const added = await saveFiles(files);
                expense.receipts = [...kept, ...added];
                expense.receipt = expense.receipts.length ? expense.receipts[0].url : null;
                for (const r of gone) await dropBlob(r.url);
            }

            await expense.save();
            await invLink.sync(expense);
            await loanService.syncFromExpense(expense);

            return res.status(200).json({
                message: 'Expense updated successfully',
                data: withReceipts(expense)
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

            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            if (expense.loan) {
                const Loan = require('../models/loan');
                const ln = await Loan.findOne({ _id: expense.loan, isDeleted: { $ne: true } }).select('paid loanNo').lean();
                if (ln && ln.paid > 0) {
                    return res.status(400).json({ message: `Loan ${ln.loanNo} of this expense is already partly paid back. Remove those payments first.` });
                }
            }
            expense.isDeleted = true;
            expense.deletedAt = new Date();
            expense.deletedBy = req.user?.id || req.user?._id || null;
            await expense.save();
            // Its payment comes off the investment bill again.
            await invLink.sync(expense);
            // Paid from personal money: its loan goes too.
            await loanService.syncFromExpense(expense);

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
                { _id: id, isDeleted: { $ne: true } },
                { isActive },
                { new: true }
            );

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense status updated successfully',
                data: withReceipts(expense)
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

            const match = { isActive: true, isDeleted: { $ne: true } };
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

// Bank Transfer -> the chosen bank account (must exist); any other method -> no bank.
async function bankFor(paymentMethod, bankId) {
    const method = String(paymentMethod || 'Cash').trim();
    if (method !== 'Bank Transfer' || !bankId || bankId === 'null') return { bank: null, bankName: '' };
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(String(bankId))) return { error: 'Choose a valid bank account' };
    const Bank = require('../models/bank');
    const b = await Bank.findOne({ _id: bankId, isDeleted: { $ne: true } }).select('name accountNumber').lean();
    if (!b) return { error: 'Bank account not found' };
    return { bank: b._id, bankName: `${b.name}${b.accountNumber ? ` (${String(b.accountNumber).slice(-4)})` : ''}` };
}

// "Paid from" counter: '' / null = none; else must be a live, active counter
// (the one already saved may stay even if it was switched off since).
async function counterFor(counterId, current = null) {
    if (counterId === undefined || counterId === null || counterId === '' || counterId === 'null') return { counter: null, counterName: '' };
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(String(counterId))) return { error: 'Choose a valid counter' };
    const SaleCounter = require('../models/saleCounter');
    const c = await SaleCounter.findOne({ _id: counterId }).select('name isActive').lean();
    const keep = current && String(current) === String(counterId);
    if (!c || (!c.isActive && !keep)) return { error: 'That counter is not active' };
    return { counter: c._id, counterName: c.name };
}

module.exports = expenseController;
