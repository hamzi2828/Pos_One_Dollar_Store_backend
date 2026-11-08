// src/services/purchasingLog/routes.js
// Which requests the Purchasing log records, and how each one is described.
//
// Each route: { method, path, area, action, label, before?, describe? }
//   path      express-like pattern under /api (':name' = one path part)
//   label     generic text used when describe() is missing or throws
//   before    async ({ params, req }) -> snapshot read BEFORE the change (for diffs / names)
//   describe  ({ params, body, data, res, before, ok, req }) -> { summary, refs, changes }
// Any other non-GET under one of the AREA_PREFIXES is still logged (generic row),
// so a new endpoint is never missed.
const mongoose = require('mongoose');

const model = (name) => mongoose.models[name] || require(`../../models/${name.charAt(0).toLowerCase()}${name.slice(1)}`);
const isId = (v) => !!v && mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(String(v));
const sid = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);
const same = (a, b) => !!a && !!b && sid(a) === sid(b);

// ---------------------------------------------------------------- formatting

const num = (n) => {
  const x = Number(n || 0);
  return Number.isInteger(x) ? x.toLocaleString('en-US') : x.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const rs = (n) => `Rs ${num(n)}`;
const PK_OFFSET_MS = 5 * 60 * 60 * 1000;
const day = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + PK_OFFSET_MS).toISOString().slice(0, 10);
};
const pcs = (n) => `${num(n)} pc${Number(n) === 1 ? '' : 's'}`;
const billName = (b) => (b ? `${b.vendorName || 'vendor'}'s bill${b.billNo ? ` ${b.billNo}` : ''}` : 'a bill');

let chargeLabels = null;
const chargeLabel = (type) => {
  if (!chargeLabels) {
    try {
      chargeLabels = require('../purchasing/purchaseOrderService').CHARGE_LABELS || {};
    } catch {
      chargeLabels = {};
    }
  }
  return chargeLabels[type] || String(type || 'cost').replace(/_/g, ' ');
};

// ---------------------------------------------------------------- diff

const norm = (v, kind) => {
  if (v === undefined || v === '') return null;
  if (kind === 'date') return day(v);
  if (kind === 'id') return v ? sid(v) : null;
  if (kind === 'count') return Array.isArray(v) ? v.length : 0;
  if (kind === 'list') return Array.isArray(v) ? v.join(', ') || null : v;
  if (kind === 'charge') return v ? chargeLabel(v) : null;
  if (v && typeof v === 'object' && v._id) return sid(v);
  return v;
};
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

/** [{ field: label, from, to }] for the fields that changed. fields: [[path, label, kind?]] */
function diff(before, after, fields) {
  if (!before || !after) return [];
  const out = [];
  for (const [p, label, kind] of fields) {
    const a = getPath(after, p);
    if (a === undefined && kind !== 'count') continue; // not in the answer: unknown, not changed
    const from = norm(getPath(before, p), kind);
    const to = norm(a, kind);
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field: label, from, to });
  }
  return out;
}
const changeText = (changes, max = 4) =>
  changes
    .slice(0, max)
    .map((c) => `${c.field} ${c.from == null ? '—' : c.from} → ${c.to == null ? '—' : c.to}`)
    .join(', ') + (changes.length > max ? ` (+${changes.length - max} more)` : '');

// ---------------------------------------------------------------- snapshots

const PO_FIELDS = 'poNumber status notes buyerName expectedArrival allocationMethod bills charges goodsReceipt grnNumber builty';
const loadPO = async ({ params }) => (isId(params.id) ? model('PurchaseOrder').findById(params.id).select(PO_FIELDS).lean() : null);
const GRN_FIELDS = 'grnNumber poNumber purchaseOrder status boxes boxesDone entries lines cartonsReceived photos totals';
const loadGRN = async ({ params }) => (isId(params.id) ? model('GoodsReceipt').findById(params.id).select(GRN_FIELDS).lean() : null);
const byId = (name) => async ({ params }) => (isId(params.id) ? model(name).findById(params.id).lean() : null);

// ---------------------------------------------------------------- trips (purchase orders)

const poRefs = (po, extra = {}) => ({
  purchaseOrder: po && po._id,
  poNumber: po && po.poNumber,
  grn: po && (po.goodsReceipt || undefined),
  grnNumber: (po && po.grnNumber) || undefined,
  ...extra,
});
const tripName = (po) => (po && po.poNumber) || 'the trip';
const findBill = (po, billId) => (po && (po.bills || []).find((b) => same(b._id, billId))) || null;
const billRefs = (b) => (b ? { bill: b._id, billNo: b.billNo || undefined, vendor: b.vendor, vendorName: b.vendorName } : {});
const billAmountText = (b) => {
  const total = b.billAmount > 0 ? b.billAmount : b.billTotal;
  const parts = [];
  if (total > 0) parts.push(rs(total));
  if (b.cartons) parts.push(`${num(b.cartons)} box${b.cartons === 1 ? '' : 'es'}`);
  if (b.paidNow > 0) parts.push(`paid now ${rs(b.paidNow)}`);
  return parts.length ? ` — ${parts.join(', ')}` : '';
};
const BILL_FIELDS = [
  ['vendorName', 'Vendor'],
  ['billNo', 'Bill no'],
  ['billDate', 'Bill date', 'date'],
  ['cartons', 'Boxes'],
  ['billAmount', 'Bill amount'],
  ['discount', 'Discount'],
  ['billTotal', 'Bill total'],
  ['paidNow', 'Paid now'],
  ['paidMethod', 'Paid by'],
  ['paidBank', 'Paid from bank', 'id'],
  ['notes', 'Notes'],
  ['photos', 'Photos', 'count'],
];
const ITEM_FIELDS = [
  ['productName', 'Product'],
  ['qty', 'Pieces'],
  ['unitPrice', 'Price'],
  ['discount', 'Discount'],
  ['boxes', 'Boxes'],
  ['piecesPerBox', 'Pieces per box'],
  ['lineTotal', 'Line total'],
  ['note', 'Note'],
];
const CHARGE_FIELDS = [
  ['type', 'Type', 'charge'],
  ['amount', 'Amount'],
  ['date', 'Date', 'date'],
  ['paidTo', 'Paid to'],
  ['note', 'Note'],
  ['photos', 'Photos', 'count'],
];
const itemText = (i) => `${i.productName || 'item'} × ${num(i.qty)} @ ${rs(i.unitPrice)}`;
const chargeText = (c) => `${chargeLabel(c.type)} ${rs(c.amount)}${c.paidTo ? ` (paid to ${c.paidTo})` : ''}${c.date ? ` on ${day(c.date)}` : ''}`;

const tripRoutes = [
  {
    method: 'PUT',
    path: '/purchase-orders/settings',
    action: 'po_settings',
    label: 'Changed purchasing settings',
    describe: ({ body }) => ({
      summary: 'Changed purchasing settings',
      changes: Object.entries(body || {}).map(([k, v]) => ({ field: k, from: null, to: v })),
    }),
  },
  {
    method: 'POST',
    path: '/purchase-orders',
    action: 'po_create',
    label: 'Started a trip',
    describe: ({ data }) => ({ summary: `Started trip ${tripName(data)}${data && data.buyerName ? ` (buyer ${data.buyerName})` : ''}`, refs: poRefs(data) }),
  },
  {
    method: 'PUT',
    path: '/purchase-orders/:id',
    action: 'po_update',
    label: 'Edited trip details',
    before: loadPO,
    describe: ({ before, data }) => {
      const changes = diff(before, data, [
        ['buyerName', 'Buyer'],
        ['notes', 'Notes'],
        ['expectedArrival', 'Expected arrival', 'date'],
        ['allocationMethod', 'Spread costs by'],
      ]);
      return { summary: `Edited trip ${tripName(before || data)}${changes.length ? `: ${changeText(changes)}` : ''}`, refs: poRefs(data || before), changes };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/bills',
    action: 'bill_add',
    label: 'Added a vendor bill',
    before: loadPO,
    describe: ({ data, res, before, body }) => {
      const b = findBill(data, res && res.billId) || (data && (data.bills || []).slice(-1)[0]);
      if (!b) return { summary: `Tried to add a vendor bill to ${tripName(before)}`, refs: poRefs(before, { vendor: body && (body.vendorId || body.vendor) }) };
      return { summary: `Added ${billName(b)}${billAmountText(b)} to ${tripName(data)}`, refs: poRefs(data, billRefs(b)) };
    },
  },
  {
    method: 'PUT',
    path: '/purchase-orders/:id/bills/:billId',
    action: 'bill_edit',
    label: 'Edited a vendor bill',
    before: loadPO,
    describe: ({ before, data, params }) => {
      const was = findBill(before, params.billId);
      const now = findBill(data, params.billId);
      const changes = diff(was, now, BILL_FIELDS);
      return {
        summary: `Edited ${billName(was || now)} on ${tripName(before || data)}${changes.length ? `: ${changeText(changes)}` : ''}`,
        refs: poRefs(data || before, billRefs(now || was)),
        changes,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/purchase-orders/:id/bills/:billId',
    action: 'bill_remove',
    label: 'Removed a vendor bill',
    before: loadPO,
    describe: ({ before, params }) => {
      const b = findBill(before, params.billId);
      return { summary: `Removed ${billName(b)}${b ? billAmountText(b) : ''} from ${tripName(before)}`, refs: poRefs(before, billRefs(b)) };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/bills/:billId/send',
    action: 'bill_send',
    label: 'Sent a bill to the warehouse',
    before: loadPO,
    describe: ({ before, data, res, params }) => {
      const b = findBill(data, params.billId) || findBill(before, params.billId);
      const grn = res && res.grn;
      const refs = poRefs(data || before, billRefs(b));
      if (grn) Object.assign(refs, { grn: grn._id, grnNumber: grn.grnNumber });
      return {
        summary: `Sent ${billName(b)}${b ? billAmountText(b) : ''} to the warehouse${grn && grn.grnNumber ? ` (${grn.grnNumber})` : ''} from ${tripName(before || data)}`,
        refs,
      };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/bills/:billId/unsend',
    action: 'bill_unsend',
    label: 'Took a bill back from the warehouse',
    before: loadPO,
    describe: ({ before, data, params }) => {
      const b = findBill(before, params.billId) || findBill(data, params.billId);
      return { summary: `Took ${billName(b)} back from the warehouse on ${tripName(before || data)}`, refs: poRefs(before || data, billRefs(b)) };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/bills/:billId/items',
    action: 'bill_item_add',
    label: 'Added items to a bill',
    before: loadPO,
    describe: ({ before, data, res, params }) => {
      const b = findBill(data, params.billId) || findBill(before, params.billId);
      const ids = new Set(((res && res.itemIds) || []).map(String));
      const old = new Set(((findBill(before, params.billId) || {}).items || []).map((i) => String(i._id)));
      const added = ((b && b.items) || []).filter((i) => (ids.size ? ids.has(String(i._id)) : !old.has(String(i._id))));
      const one = added.length === 1 ? added[0] : null;
      return {
        summary: `Added ${added.length ? added.map(itemText).slice(0, 5).join(', ') : 'items'} to ${billName(b)} on ${tripName(data || before)}`,
        refs: poRefs(data || before, { ...billRefs(b), ...(one ? { item: one._id, product: one.product, productName: one.productName } : {}) }),
      };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/bills/:billId/new-product',
    action: 'bill_new_product',
    label: 'Created a new product on a bill',
    before: loadPO,
    describe: ({ before, data, res, params }) => {
      const b = findBill(data, params.billId) || findBill(before, params.billId);
      const p = (res && res.product) || {};
      const name = p.name || p.productName || 'a new product';
      return {
        summary: `Created new product ${name}${p.shortCode || p.code ? ` (${p.shortCode || p.code})` : ''} on ${billName(b)}, ${tripName(data || before)}`,
        refs: poRefs(data || before, { ...billRefs(b), product: p._id || p.productId, productName: name }),
      };
    },
  },
  {
    method: 'PUT',
    path: '/purchase-orders/:id/bills/:billId/items/:itemId',
    action: 'bill_item_edit',
    label: 'Edited an item on a bill',
    before: loadPO,
    describe: ({ before, data, params }) => {
      const b = findBill(before, params.billId);
      const was = ((b && b.items) || []).find((i) => same(i._id, params.itemId));
      const now = ((findBill(data, params.billId) || {}).items || []).find((i) => same(i._id, params.itemId));
      const changes = diff(was, now, ITEM_FIELDS);
      const name = (now || was || {}).productName || 'item';
      return {
        summary: `Edited ${name} on ${billName(b)} (${tripName(before)})${changes.length ? `: ${changeText(changes)}` : ''}`,
        refs: poRefs(data || before, { ...billRefs(b), item: params.itemId, product: (now || was || {}).product, productName: name }),
        changes,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/purchase-orders/:id/bills/:billId/items/:itemId',
    action: 'bill_item_remove',
    label: 'Removed an item from a bill',
    before: loadPO,
    describe: ({ before, params }) => {
      const b = findBill(before, params.billId);
      const was = ((b && b.items) || []).find((i) => same(i._id, params.itemId));
      return {
        summary: `Removed ${was ? itemText(was) : 'an item'} from ${billName(b)} (${tripName(before)})`,
        refs: poRefs(before, { ...billRefs(b), item: params.itemId, product: was && was.product, productName: was && was.productName }),
      };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/charges',
    action: 'charge_add',
    label: 'Added a trip cost',
    before: loadPO,
    describe: ({ before, data }) => {
      const old = new Set(((before && before.charges) || []).map((c) => String(c._id)));
      const c = ((data && data.charges) || []).find((x) => !old.has(String(x._id)));
      return {
        summary: `Added trip cost ${c ? chargeText(c) : ''} to ${tripName(data || before)}`.replace('  ', ' '),
        refs: poRefs(data || before, c ? { charge: c._id, chargeType: c.type } : {}),
        changes: c ? [{ field: 'Amount', from: null, to: c.amount }] : [],
      };
    },
  },
  {
    method: 'PUT',
    path: '/purchase-orders/:id/charges/:chargeId',
    action: 'charge_edit',
    label: 'Edited a trip cost',
    before: loadPO,
    describe: ({ before, data, params }) => {
      const was = ((before && before.charges) || []).find((c) => same(c._id, params.chargeId));
      const now = ((data && data.charges) || []).find((c) => same(c._id, params.chargeId));
      const changes = diff(was, now, CHARGE_FIELDS);
      return {
        summary: `Edited trip cost ${was ? chargeLabel(was.type) : ''} on ${tripName(before || data)}${changes.length ? `: ${changeText(changes)}` : ''}`,
        refs: poRefs(data || before, { charge: params.chargeId, chargeType: (now || was || {}).type }),
        changes,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/purchase-orders/:id/charges/:chargeId',
    action: 'charge_remove',
    label: 'Removed a trip cost',
    before: loadPO,
    describe: ({ before, params }) => {
      const was = ((before && before.charges) || []).find((c) => same(c._id, params.chargeId));
      return {
        summary: `Removed trip cost ${was ? chargeText(was) : ''} from ${tripName(before)}`,
        refs: poRefs(before, { charge: params.chargeId, chargeType: was && was.type }),
        changes: was ? [{ field: 'Amount', from: was.amount, to: null }] : [],
      };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/close',
    action: 'po_close',
    label: 'Sent the trip to the warehouse',
    before: loadPO,
    describe: ({ before, data, res }) => {
      const grn = res && res.grn;
      const refs = poRefs(data || before);
      if (grn) Object.assign(refs, { grn: grn._id, grnNumber: grn.grnNumber });
      return {
        summary: `Sent trip ${tripName(before || data)} to the warehouse${grn && grn.grnNumber ? ` (${grn.grnNumber})` : ''}${data && data.totals ? ` — ${num(data.totals.bills)} bills, ${rs(data.totals.grand)}` : ''}`,
        refs,
        changes: diff(before, data, [
          ['status', 'Status'],
          ['builty.builtyNo', 'Builty no'],
          ['builty.freight', 'Builty freight'],
        ]),
      };
    },
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/reopen',
    action: 'po_reopen',
    label: 'Reopened the trip',
    before: loadPO,
    describe: ({ before, data, body }) => ({
      summary: `Reopened trip ${tripName(before || data)}${body && body.reason ? ` — ${body.reason}` : ''}`,
      refs: poRefs(before || data),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
  {
    method: 'POST',
    path: '/purchase-orders/:id/cancel',
    action: 'po_cancel',
    label: 'Cancelled the trip',
    before: loadPO,
    describe: ({ before, data, body }) => ({
      summary: `Cancelled trip ${tripName(before || data)}${body && body.reason ? ` — ${body.reason}` : ''}`,
      refs: poRefs(before || data),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
].map((r) => ({ ...r, area: 'trips' }));

// ---------------------------------------------------------------- receiving (GRN)

const grnRefs = (g, extra = {}) => {
  if (!g) return { ...extra };
  const po = g.purchaseOrder;
  return {
    grn: g._id,
    grnNumber: g.grnNumber,
    purchaseOrder: po && po._id ? po._id : po,
    poNumber: g.poNumber || (po && po.poNumber) || undefined,
    ...extra,
  };
};
const grnName = (g) => (g && g.grnNumber) || 'the goods receipt';
const findEntry = (g, entryId) => ((g && g.entries) || []).find((e) => same(e._id, entryId)) || null;
const entryRefs = (e) =>
  e
    ? {
        entry: e._id,
        entryNo: e.entryNo,
        bill: e.bill,
        billNo: e.billNo || undefined,
        vendor: e.vendor || undefined,
        vendorName: e.vendorName || undefined,
        product: e.product,
        productName: e.productName,
      }
    : {};
const entryText = (e) => {
  const extra = [];
  if (e.damagedQty) extra.push(`${num(e.damagedQty)} damaged`);
  if (e.boxNo) extra.push(`box ${e.boxNo}`);
  return `#${e.entryNo} ${e.productName || 'item'} — ${pcs(e.qty)} × ${rs(e.costPrice)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
};
const ENTRY_FIELDS = [
  ['qty', 'Pieces'],
  ['damagedQty', 'Damaged'],
  ['stockQty', 'Good pieces'],
  ['costPrice', 'Cost price'],
  ['boxNo', 'Box no'],
  ['entryNo', 'Entry no'],
];
const boxOf = (g, bill) => ((g && g.boxes) || []).find((b) => same(b.bill, bill));

const receivingRoutes = [
  {
    method: 'POST',
    path: '/receiving/:id/start',
    action: 'grn_start',
    label: 'Started receiving',
    before: loadGRN,
    describe: ({ before, data }) => ({
      summary: `Started receiving ${grnName(before || data)}`,
      refs: grnRefs(data || before),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
  {
    method: 'PUT',
    path: '/receiving/:id/lines',
    action: 'grn_counts',
    label: 'Saved counts',
    before: loadGRN,
    describe: ({ before, data }) => {
      const changes = [];
      for (const l of (data && data.lines) || []) {
        const was = ((before && before.lines) || []).find((x) => same(x._id, l._id));
        if (!was) continue;
        for (const [k, label] of [
          ['receivedQty', 'received'],
          ['damagedQty', 'damaged'],
        ]) {
          if ((was[k] || 0) !== (l[k] || 0)) changes.push({ field: `${l.productName || `Line ${l.lineNo}`} ${label}`, from: was[k] || 0, to: l[k] || 0 });
        }
      }
      return { summary: `Saved counts on ${grnName(before || data)}${changes.length ? `: ${changeText(changes, 3)}` : ''}`, refs: grnRefs(data || before), changes };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/scan',
    action: 'grn_scan',
    label: 'Scanned an item',
    before: loadGRN,
    describe: ({ before, body, res }) => {
      const s = (res && res.scanned) || {};
      const name = s.productName || (s.line && s.line.productName) || '';
      return { summary: `Scanned ${body && body.code ? `"${body.code}"` : 'an item'}${name ? ` (${name})` : ''} on ${grnName(before)}`, refs: grnRefs(before) };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/photos',
    action: 'grn_photos',
    label: 'Added photos',
    before: loadGRN,
    describe: ({ before, data, req }) => {
      const n = data && before ? (data.photos || []).length - (before.photos || []).length : (req.files || []).length;
      return { summary: `Added ${n || ''} photo${n === 1 ? '' : 's'} to ${grnName(before || data)}`.replace('  ', ' '), refs: grnRefs(data || before) };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/complete',
    action: 'grn_complete',
    label: 'Finished receiving',
    before: loadGRN,
    describe: ({ before, data }) => {
      const t = (data && data.totals) || {};
      const bits = [];
      if (t.pieces) bits.push(pcs(t.pieces));
      if (t.entered) bits.push(`${rs(t.entered)} entered`);
      if (t.claimed) bits.push(`claim ${rs(t.claimed)}`);
      return {
        summary: `Finished receiving ${grnName(before || data)}${data && data.alreadyCompleted ? ' (already finished)' : ''}${bits.length ? ` — ${bits.join(', ')}` : ''}`,
        refs: grnRefs(data || before),
        changes: diff(before, data, [['status', 'Status']]),
      };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/boxes',
    action: 'boxes_check',
    label: 'Checked boxes',
    before: loadGRN,
    describe: ({ before, data, body }) => {
      const changes = [];
      for (const x of (body && body.boxes) || []) {
        const was = boxOf(before, x.bill);
        const now = boxOf(data, x.bill) || was;
        const name = now ? `Boxes — ${now.vendorName || 'vendor'}${now.billNo ? ` (${now.billNo})` : ''}` : 'Boxes';
        const from = was ? (was.checkedAt ? was.received : null) : null;
        const to = now ? now.received : x.received;
        if (from !== to) changes.push({ field: name, from, to });
      }
      const one = ((body && body.boxes) || []).length === 1 ? boxOf(data || before, body.boxes[0].bill) : null;
      return {
        summary: `Checked boxes on ${grnName(before || data)}${changes.length ? `: ${changeText(changes)}` : ''}`,
        refs: grnRefs(data || before, one ? { bill: one.bill, billNo: one.billNo || undefined, vendor: one.vendor || undefined, vendorName: one.vendorName } : {}),
        changes,
      };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/boxes/done',
    action: 'box_done',
    label: 'Marked a box',
    before: loadGRN,
    describe: ({ before, body }) => {
      const b = boxOf(before, body && (body.bill || body.billId));
      const done = !(body && (body.done === false || body.done === 'false'));
      return {
        summary: `Marked box ${(body && body.boxNo) || ''} of ${billName(b)} as ${done ? 'fully unpacked' : 'open again'} on ${grnName(before)}`,
        refs: grnRefs(before, b ? { bill: b.bill, billNo: b.billNo || undefined, vendor: b.vendor || undefined, vendorName: b.vendorName } : {}),
      };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/new-product',
    action: 'product_new',
    label: 'Created a new product while receiving',
    before: loadGRN,
    describe: ({ before, data, body }) => {
      const name = (data && (data.name || data.productName)) || (body && body.name) || 'a product';
      return {
        summary: `Created new product ${name}${data && data.code ? ` (${data.code})` : ''}${data && data.salePrice ? `, sale price ${rs(data.salePrice)}` : ''} on ${grnName(before)}`,
        refs: grnRefs(before, { product: data && data.productId, productName: name }),
      };
    },
  },
  {
    method: 'POST',
    path: '/receiving/:id/entries',
    action: 'entry_add',
    label: 'Added an entry',
    before: loadGRN,
    describe: ({ before, data, body }) => {
      const e = data && data.entry;
      const g = (data && data.grn) || before;
      if (!e) {
        const bill = boxOf(before, body && body.bill);
        return {
          summary: `Tried to add ${pcs((body && body.qty) || 0)}${body && body.costPrice ? ` × ${rs(body.costPrice)}` : ''} to ${billName(bill)} on ${grnName(before)}`,
          refs: grnRefs(before, {
            bill: body && body.bill,
            billNo: bill && bill.billNo,
            vendor: bill && bill.vendor,
            vendorName: bill && bill.vendorName,
            product: body && body.productId,
          }),
        };
      }
      return {
        summary: `${data.repeated ? 'Resent (same) entry' : 'Added entry'} ${entryText(e)} to ${billName(e)} on ${grnName(g)}`,
        refs: grnRefs(g, entryRefs(e)),
      };
    },
  },
  {
    method: 'DELETE',
    path: '/receiving/:id/entries/:entryId',
    action: 'entry_undo',
    label: 'Undid an entry',
    before: loadGRN,
    describe: ({ before, data, params }) => {
      const e = findEntry(before, params.entryId) || (data && data.entry);
      return {
        summary: `${data && data.alreadyUndone ? 'Undo again (already undone):' : 'Undid'} entry ${e ? entryText(e) : ''} from ${billName(e)} on ${grnName(before)}`,
        refs: grnRefs(before, entryRefs(e)),
        changes: e ? [{ field: 'Pieces', from: e.qty, to: 0 }] : [],
      };
    },
  },
  {
    method: 'PUT',
    path: '/receiving/:id/entries/:entryId',
    action: 'entry_edit',
    label: 'Edited an entry',
    before: loadGRN,
    describe: ({ before, data, params }) => {
      const was = findEntry(before, params.entryId);
      const now = data && data.entry;
      const changes = diff(was, now, ENTRY_FIELDS);
      const e = now || was;
      const nos = was && now && was.entryNo !== now.entryNo ? `#${was.entryNo} → #${now.entryNo}` : e ? `#${e.entryNo}` : '';
      const shown = changes.filter((c) => c.field !== 'Entry no');
      return {
        summary: `Edited entry ${nos} ${(e && e.productName) || ''} on ${billName(e)} (${grnName(before)})${shown.length ? `: ${changeText(shown)}` : ''}`.replace('  ', ' '),
        refs: grnRefs((data && data.grn) || before, entryRefs(e)),
        changes,
      };
    },
  },
].map((r) => ({ ...r, area: 'receiving' }));

// ---------------------------------------------------------------- sticker prints

let ticketKey = null;
const decodeTicket = (ticket) => {
  try {
    const jwt = require('jsonwebtoken');
    if (!ticketKey) ticketKey = `${process.env.JWT_SECRET || ''}|label-print-log`;
    return jwt.verify(String(ticket || ''), ticketKey);
  } catch {
    return null;
  }
};
const entryOfGRN = async (grnId, entryId) => {
  if (!isId(grnId)) return null;
  const g = await model('GoodsReceipt').findById(grnId).select('grnNumber poNumber purchaseOrder entries').lean();
  return g ? { grn: g, entry: findEntry(g, entryId) } : null;
};

const labelRoutes = [
  {
    method: 'POST',
    path: '/public/label-prints',
    action: 'label_print',
    label: 'Printed stickers',
    // The sticker page has no sign-in header: the signed ticket says who printed.
    user: ({ body }) => {
      const t = decodeTicket(body && body.ticket);
      return t ? { id: t.u, name: t.un } : null;
    },
    describe: ({ body, data }) => {
      const t = decodeTicket(body && body.ticket);
      const items = (t && Array.isArray(t.i) ? t.i : []).filter((x) => x.k > 0);
      const n = (data && data.logged) || Number(body && body.count) || 0;
      const one = items.length === 1 ? items[0] : null;
      const names = items.slice(0, 4).map((x) => `${x.n || 'item'} ×${x.k}`).join(', ');
      return {
        summary: `Printed ${num(n)} sticker${n === 1 ? '' : 's'}${names ? `: ${names}${items.length > 4 ? ` (+${items.length - 4} more)` : ''}` : ''}${body && body.via ? ` (${body.via})` : ''}`,
        refs: one ? { product: one.p, productName: one.n, bill: one.b || undefined } : {},
      };
    },
  },
  {
    method: 'POST',
    path: '/label-prints/scanned',
    action: 'label_scanned',
    label: 'Marked pieces as scanned (own barcode)',
    before: async ({ req }) => {
      const b = req.body || {};
      return isId(b.productId) ? model('Product').findById(b.productId).select('name').lean() : null;
    },
    describe: ({ before, body }) => ({
      summary: `Marked ${pcs((body && body.count) || 0)} of ${(before && before.name) || 'a product'} as having their own barcode (no sticker needed)`,
      refs: { product: body && body.productId, productName: before && before.name, bill: body && body.bill },
    }),
  },
  {
    method: 'POST',
    path: '/label-prints/remove-extra',
    action: 'label_remove_extra',
    label: 'Removed extra stickers',
    before: async ({ req }) => entryOfGRN((req.body || {}).grnId, (req.body || {}).entryId),
    describe: ({ before, data }) => {
      const e = before && before.entry;
      const g = before && before.grn;
      const removed = (data && data.removed) || 0;
      return {
        summary: `Removed ${num(removed)} extra sticker${removed === 1 ? '' : 's'} of ${e ? `entry #${e.entryNo} ${e.productName}` : 'an entry'}${g ? ` on ${g.grnNumber}` : ''}`,
        refs: grnRefs(g, entryRefs(e)),
        changes: data && data.printed !== undefined ? [{ field: 'Stickers counted', from: data.printed + removed, to: data.printed }] : [],
      };
    },
  },
  {
    method: 'PATCH',
    path: '/label-prints/:id',
    action: 'label_ignore',
    label: 'Changed a sticker print',
    before: byId('LabelPrint'),
    describe: ({ before, body, params }) => {
      const ignored = !!(body && (body.ignored === true || body.ignored === 'true'));
      return {
        summary: `${ignored ? 'Left out (test / wrong print)' : 'Counted again'}: ${before ? `${num(before.count)} stickers of ${before.productName}` : 'a sticker print'}`,
        refs: { labelPrint: params.id, product: before && before.product, productName: before && before.productName, bill: before && before.bill },
        changes: before ? [{ field: 'Left out', from: !!before.ignored, to: ignored }] : [],
      };
    },
  },
].map((r) => ({ ...r, area: 'labels' }));

// ---------------------------------------------------------------- vendors & ledger

const VENDOR_FIELDS = [
  ['name', 'Name'],
  ['code', 'Code'],
  ['contactPerson', 'Contact person'],
  ['phone', 'Phone'],
  ['whatsapp', 'WhatsApp'],
  ['email', 'Email'],
  ['cnic', 'CNIC'],
  ['ntn', 'NTN'],
  ['category', 'Category'],
  ['categories', 'Categories', 'list'],
  ['city', 'City'],
  ['address.street', 'Address'],
  ['address.city', 'Address city'],
  ['bankDetails.bankName', 'Bank'],
  ['bankDetails.accountTitle', 'Account title'],
  ['bankDetails.accountNumber', 'Account number'],
  ['bankDetails.iban', 'IBAN'],
  ['paymentTermsDays', 'Payment terms (days)'],
  ['isConsignment', 'Consignment vendor'],
  ['openingBalance', 'Opening balance'],
  ['notes', 'Notes'],
  ['isActive', 'Active'],
];
const vRefs = (v) => (v ? { vendor: v._id, vendorName: v.name } : {});

const vendorRoutes = [
  {
    method: 'POST',
    path: '/vendors',
    action: 'vendor_create',
    label: 'Added a vendor',
    describe: ({ data, body }) => ({
      summary: `Added vendor ${(data && data.name) || (body && body.name) || ''}${data && data.phone ? ` (${data.phone})` : ''}`,
      refs: vRefs(data),
    }),
  },
  {
    method: 'PUT',
    path: '/vendors/:id',
    action: 'vendor_update',
    label: 'Edited a vendor',
    before: byId('Vendor'),
    describe: ({ before, data }) => {
      const changes = diff(before, data, VENDOR_FIELDS);
      return { summary: `Edited vendor ${(before && before.name) || ''}${changes.length ? `: ${changeText(changes)}` : ''}`, refs: vRefs(data || before), changes };
    },
  },
  {
    method: 'PATCH',
    path: '/vendors/:id/status',
    action: 'vendor_status',
    label: 'Changed vendor status',
    before: byId('Vendor'),
    describe: ({ before, data }) => ({
      summary: `${data && data.isActive === false ? 'Deactivated' : 'Activated'} vendor ${(before && before.name) || ''}`,
      refs: vRefs(before || data),
      changes: diff(before, data, [['isActive', 'Active']]),
    }),
  },
  {
    method: 'DELETE',
    path: '/vendors/:id',
    action: 'vendor_delete',
    label: 'Deleted a vendor',
    before: byId('Vendor'),
    describe: ({ before }) => ({ summary: `Deleted vendor ${(before && before.name) || ''}`, refs: vRefs(before) }),
  },
  {
    method: 'POST',
    path: '/vendors/:id/ledger/:entryId/void',
    action: 'ledger_void',
    label: 'Voided a ledger row',
    before: async ({ params }) => {
      const [v, e] = await Promise.all([
        isId(params.id) ? model('Vendor').findById(params.id).select('name').lean() : null,
        isId(params.entryId) ? model('VendorLedgerEntry').findById(params.entryId).lean() : null,
      ]);
      return { vendor: v, entry: e };
    },
    describe: ({ before, body, params }) => {
      const e = before && before.entry;
      const amt = e ? e.credit || e.debit : 0;
      return {
        summary: `Voided ledger row of ${(before && before.vendor && before.vendor.name) || 'vendor'}: ${e ? `${e.description || e.type} ${rs(amt)}` : ''}${body && body.reason ? ` — ${body.reason}` : ''}`,
        refs: { ...vRefs(before && before.vendor), ledgerEntry: params.entryId },
        changes: e ? [{ field: 'Voided', from: !!e.isVoided, to: true }] : [],
      };
    },
  },
  {
    method: 'POST',
    path: '/vendors/:id/adjustments',
    action: 'ledger_adjust',
    label: 'Posted a ledger adjustment',
    before: async ({ params }) => (isId(params.id) ? model('Vendor').findById(params.id).select('name').lean() : null),
    describe: ({ before, data, body }) => {
      const amt = (data && (data.credit || data.debit)) || (body && body.amount);
      const dir = (data && (data.credit ? 'we owe more' : data.debit ? 'we owe less' : '')) || (body && body.direction) || '';
      return {
        summary: `Posted adjustment ${rs(amt)}${dir ? ` (${dir})` : ''} on ${(before && before.name) || 'vendor'}'s ledger${body && body.reason ? ` — ${body.reason}` : ''}`,
        refs: { ...vRefs(before), ledgerEntry: data && data._id },
      };
    },
  },
].map((r) => ({ ...r, area: 'vendors' }));

// ---------------------------------------------------------------- vendor payments

const PAYMENT_FIELDS = [
  ['amount', 'Amount'],
  ['method', 'Method'],
  ['bank', 'Bank', 'id'],
  ['reference', 'Reference'],
  ['date', 'Date', 'date'],
  ['notes', 'Notes'],
  ['attachments', 'Photos', 'count'],
  ['status', 'Status'],
];
const payRefs = (p) => (p ? { payment: p._id, paymentNo: p.paymentNo, vendor: p.vendor && p.vendor._id ? p.vendor._id : p.vendor, vendorName: p.vendorName || (p.vendor && p.vendor.name) } : {});
const payText = (p) => `${p.paymentNo || 'payment'} ${rs(p.amount)} to ${p.vendorName || (p.vendor && p.vendor.name) || 'vendor'}${p.method ? ` (${p.method})` : ''}`;

const paymentRoutes = [
  {
    method: 'POST',
    path: '/vendor-payments',
    action: 'payment_create',
    label: 'Recorded a vendor payment',
    describe: ({ data, body }) => ({
      summary: data ? `Recorded payment ${payText(data)}${data.date ? ` on ${day(data.date)}` : ''}` : `Tried to record a payment of ${rs(body && body.amount)}`,
      refs: data ? payRefs(data) : { vendor: body && (body.vendorId || body.vendor) },
    }),
  },
  {
    method: 'PUT',
    path: '/vendor-payments/:id',
    action: 'payment_edit',
    label: 'Edited a vendor payment',
    before: byId('VendorPayment'),
    describe: ({ before, data }) => {
      const changes = diff(before, data, PAYMENT_FIELDS);
      return { summary: `Edited payment ${before ? payText(before) : ''}${changes.length ? `: ${changeText(changes)}` : ''}`, refs: payRefs(data || before), changes };
    },
  },
  {
    method: 'POST',
    path: '/vendor-payments/:id/void',
    action: 'payment_void',
    label: 'Voided a vendor payment',
    before: byId('VendorPayment'),
    describe: ({ before, data, body }) => ({
      summary: `Voided payment ${before ? payText(before) : ''}${body && body.reason ? ` — ${body.reason}` : ''}`,
      refs: payRefs(before || data),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
].map((r) => ({ ...r, area: 'payments' }));

// ---------------------------------------------------------------- vendor returns

const retRefs = (r) => (r ? { vendorReturn: r._id, returnNo: r.returnNo, vendor: r.vendor && r.vendor._id ? r.vendor._id : r.vendor, vendorName: r.vendorName } : {});
const retText = (r) => `${r.returnNo || 'return'} to ${r.vendorName || 'vendor'} — ${pcs(r.totalQty)}, ${rs(r.total)}`;
const RETURN_FIELDS = [
  ['status', 'Status'],
  ['date', 'Date', 'date'],
  ['totalQty', 'Pieces'],
  ['total', 'Total'],
  ['notes', 'Notes'],
];

const returnRoutes = [
  {
    method: 'POST',
    path: '/vendor-returns',
    action: 'return_create',
    label: 'Made a vendor return',
    describe: ({ data }) => ({
      summary: data ? `${data.status === 'completed' ? 'Made and completed' : 'Saved draft'} return ${retText(data)}` : 'Tried to make a vendor return',
      refs: retRefs(data),
    }),
  },
  {
    method: 'PUT',
    path: '/vendor-returns/:id',
    action: 'return_edit',
    label: 'Edited a vendor return',
    before: byId('VendorReturn'),
    describe: ({ before, data }) => {
      const changes = diff(before, data, RETURN_FIELDS);
      return { summary: `Edited return ${before ? retText(before) : ''}${changes.length ? `: ${changeText(changes)}` : ''}`, refs: retRefs(data || before), changes };
    },
  },
  {
    method: 'POST',
    path: '/vendor-returns/:id/complete',
    action: 'return_complete',
    label: 'Completed a vendor return',
    before: byId('VendorReturn'),
    describe: ({ before, data }) => ({
      summary: `Completed return ${retText(data || before || {})} (stock out, debit note)`,
      refs: retRefs(data || before),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
  {
    method: 'POST',
    path: '/vendor-returns/:id/cancel',
    action: 'return_cancel',
    label: 'Cancelled a vendor return',
    before: byId('VendorReturn'),
    describe: ({ before, data, body }) => ({
      summary: `Cancelled return ${retText(before || data || {})}${body && body.reason ? ` — ${body.reason}` : ''}`,
      refs: retRefs(before || data),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
].map((r) => ({ ...r, area: 'returns' }));

// ---------------------------------------------------------------- consignment

const conRefs = (c) => (c ? { consignment: c._id, consignmentNo: c.consignmentNo, vendor: c.vendor && c.vendor._id ? c.vendor._id : c.vendor, vendorName: c.vendorName } : {});
const setRefs = (s) =>
  s ? { settlement: s._id, settlementNo: s.settlementNo, vendor: s.vendor && s.vendor._id ? s.vendor._id : s.vendor, vendorName: s.vendorName, payment: s.payment && s.payment._id ? s.payment._id : s.payment || undefined } : {};

const consignmentRoutes = [
  {
    method: 'POST',
    path: '/consignments',
    action: 'consignment_intake',
    label: 'Received consignment stock',
    describe: ({ data }) => ({
      summary: data ? `Received ${pcs(data.totalQty)} on consignment from ${data.vendorName || 'vendor'} (${data.consignmentNo}, value ${rs(data.totalValue)})` : 'Tried to receive consignment stock',
      refs: conRefs(data),
    }),
  },
  {
    method: 'POST',
    path: '/consignments/returns',
    action: 'consignment_return',
    label: 'Gave consignment stock back',
    describe: ({ data }) => ({
      summary: data ? `Gave ${pcs(data.totalQty)} back to ${data.vendorName || 'vendor'} (${data.consignmentNo})` : 'Tried to give consignment stock back',
      refs: conRefs(data),
    }),
  },
  {
    method: 'POST',
    path: '/consignments/:id/post',
    action: 'consignment_post',
    label: 'Posted consignment stock again',
    before: byId('Consignment'),
    describe: ({ before, data }) => ({ summary: `Posted ${(data || before || {}).consignmentNo || 'consignment'} stock again`, refs: conRefs(data || before) }),
  },
  {
    method: 'POST',
    path: '/consignments/settlements',
    action: 'settlement_create',
    label: 'Settled consignment sales',
    describe: ({ data }) => ({
      summary: data
        ? `Settled ${pcs(data.totalQty)} sold for ${data.vendorName || 'vendor'} (${data.settlementNo}) — ${rs(data.total)} payable${data.paidAmount ? `, paid now ${rs(data.paidAmount)}` : ''}`
        : 'Tried to settle consignment sales',
      refs: setRefs(data),
    }),
  },
  {
    method: 'POST',
    path: '/consignments/settlements/:id/void',
    action: 'settlement_void',
    label: 'Voided a consignment settlement',
    before: byId('ConsignmentSettlement'),
    describe: ({ before, data, body }) => ({
      summary: `Voided settlement ${(before || data || {}).settlementNo || ''} of ${(before || data || {}).vendorName || 'vendor'} (${rs((before || data || {}).total)})${body && body.reason ? ` — ${body.reason}` : ''}`,
      refs: setRefs(before || data),
      changes: diff(before, data, [['status', 'Status']]),
    }),
  },
].map((r) => ({ ...r, area: 'consignment' }));

// ---------------------------------------------------------------- matching

// Unknown non-GET routes under these prefixes still get a generic row.
const AREA_PREFIXES = [
  ['/purchase-orders', 'trips'],
  ['/receiving', 'receiving'],
  ['/vendor-payments', 'payments'],
  ['/vendor-returns', 'returns'],
  ['/vendors', 'vendors'],
  ['/consignments', 'consignment'],
  ['/label-prints', 'labels'],
  ['/public/label-prints', 'labels'],
];

const compile = (r) => {
  const names = [];
  const re = r.path.replace(/:([A-Za-z]+)/g, (_, n) => {
    names.push(n);
    return '([^/]+)';
  });
  return { ...r, re: new RegExp(`^${re}/?$`), names };
};

// Static paths first (e.g. /purchase-orders/settings before /purchase-orders/:id).
const ROUTES = [...tripRoutes, ...receivingRoutes, ...labelRoutes, ...vendorRoutes, ...paymentRoutes, ...returnRoutes, ...consignmentRoutes]
  .map(compile)
  .sort((a, b) => (a.path.includes(':') ? 1 : 0) - (b.path.includes(':') ? 1 : 0));

/** { route, params } for a request path under /api, or null when not a purchasing route. */
function match(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { route: r, params };
  }
  const hit = AREA_PREFIXES.find(([p]) => path === p || path.startsWith(`${p}/`));
  if (!hit) return null;
  const generic = path.replace(/\/[a-f0-9]{24}(?=\/|$)/gi, '/:id');
  return {
    route: { method, path: generic, area: hit[1], action: `${method.toLowerCase()} ${generic}`, label: `${method} ${generic}` },
    params: {},
  };
}

module.exports = { match, diff, ROUTES, isId };
