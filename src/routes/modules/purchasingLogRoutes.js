// Purchasing log (/api/purchasing-log): read-only activity log of the
// Purchasing & Vendors area (rows are written by middleware/purchasingLogger.js).
// Permission: `purchasing_log` view. There is no edit / delete: it is an audit trail.
//
// GET /purchasing-log?startDate&endDate&user&area&action&search&purchaseOrder&grn&vendor&ok&page&limit
//   -> { success, data, pagination: { page, limit, total, totalPages }, users: [{ _id, name }] }
// GET /purchasing-log/:id -> { success, data } (with the sanitized request body)
const express = require('express');
const mongoose = require('mongoose');
const { staff, can, handle } = require('./_access');
const PurchasingLog = require('../../models/purchasingLog');
const User = require('../../models/user');
const tillService = require('../../services/tillService');

const router = express.Router();

const isId = (v) => !!v && /^[a-f0-9]{24}$/i.test(String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const notFound = () => Object.assign(new Error('Log row not found'), { status: 404 });

router.get(
  '/purchasing-log',
  ...staff,
  can('purchasing_log', 'view'),
  handle(async (req, res) => {
    const q = req.query || {};
    const filter = {};
    const tz = await tillService.getTimeZone();
    const range = tillService.dayRange(q.startDate, q.endDate, tz);
    if (range) filter.at = range;
    if (isId(q.user)) filter.user = oid(q.user);
    if (PurchasingLog.AREAS.includes(q.area)) filter.area = q.area;
    if (q.action && String(q.action).trim()) filter.action = String(q.action).trim();
    if (isId(q.purchaseOrder)) filter['refs.purchaseOrder'] = oid(q.purchaseOrder);
    if (isId(q.grn)) filter['refs.grn'] = oid(q.grn);
    if (isId(q.vendor)) filter['refs.vendor'] = oid(q.vendor);
    if (q.ok === 'true' || q.ok === 'false') filter.ok = q.ok === 'true';
    const search = String(q.search || q.q || '').trim().slice(0, 100);
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = ['refs.poNumber', 'refs.grnNumber', 'refs.billNo', 'refs.vendorName', 'refs.productName', 'refs.paymentNo', 'refs.returnNo', 'refs.consignmentNo', 'refs.settlementNo', 'summary'].map(
        (k) => ({ [k]: rx })
      );
    }

    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
    const [data, total, userIds] = await Promise.all([
      PurchasingLog.find(filter).select('-request').sort({ at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PurchasingLog.countDocuments(filter),
      PurchasingLog.distinct('user'),
    ]);
    const ids = userIds.filter(Boolean);
    const people = ids.length ? await User.find({ _id: { $in: ids } }).select('firstName lastName email').lean() : [];
    const users = people
      .map((u) => ({ _id: String(u._id), name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'User' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, users });
  })
);

router.get(
  '/purchasing-log/:id',
  ...staff,
  can('purchasing_log', 'view'),
  handle(async (req, res) => {
    if (!isId(req.params.id)) throw notFound();
    const data = await PurchasingLog.findById(req.params.id).lean();
    if (!data) throw notFound();
    res.json({ success: true, data });
  })
);

module.exports = router;
