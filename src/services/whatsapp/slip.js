// src/services/whatsapp/slip.js
// Plain-text transaction slip for the WhatsApp group (WhatsApp *bold* markup).
//
//   buildOrderSlip(order, { shopName, header, footer, timeZone, event })
//   order: POSOrder (lean) with items.product / cashier populated when possible.
//   event: 'sale' | 'payment' | 'resend'; copy: true adds "(copy)" to the title

const LINE = '------------------------------';

const money = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `Rs ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

const METHOD_LABELS = { cash: 'Cash', card: 'Card', split: 'Cash + Card', bank_transfer: 'Bank transfer' };
const methodLabel = (m) => METHOD_LABELS[m] || (m ? String(m) : '—');

function formatDateTime(date, timeZone) {
  const d = date ? new Date(date) : new Date();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

const personName = (p) => {
  if (!p || typeof p !== 'object') return '';
  return `${p.firstName || ''} ${p.lastName || ''}`.trim();
};

function itemName(item) {
  const p = item.product;
  let name = (p && typeof p === 'object' && p.name) || item.name || 'Item';
  const extra = [item.size, item.color].filter(Boolean).join(' / ');
  if (extra) name += ` (${extra})`;
  return name;
}

function buildOrderSlip(order, { shopName = 'Our Shop', header = '', footer = '', timeZone = 'Asia/Karachi', event = 'sale', copy = false } = {}) {
  const o = order || {};
  const lines = [];

  lines.push(`*${shopName}*`);
  if (header) lines.push(...String(header).split(/\r?\n/).filter(Boolean));

  const history = Array.isArray(o.paymentHistory) ? o.paymentHistory : [];
  const lastPayment = history.length ? history[history.length - 1] : null;
  const title = `${event === 'payment' ? 'PAYMENT RECEIVED' : 'SALE RECEIPT'}${copy || event === 'resend' ? ' (copy)' : ''}`;
  lines.push(title);

  lines.push(`Bill: ${o.orderNumber || '—'}`);
  const when = event === 'payment' && lastPayment ? lastPayment.paidAt : o.createdAt;
  lines.push(`Date: ${formatDateTime(when, timeZone)}`);
  const customer = o.customerInfo && o.customerInfo.name;
  if (customer) lines.push(`Customer: ${customer}`);
  lines.push(LINE);

  // Items: "2 x Glass Mug @ Rs 280 = Rs 560"; gifts marked FREE.
  for (const item of o.items || []) {
    const qty = Number(item.quantity) || 0;
    const name = itemName(item);
    if (item.isGift) {
      lines.push(`${qty} x ${name} - FREE (gift)`);
      continue;
    }
    const price = Number(item.price) || 0;
    const lineDiscount = Number(item.discount) || 0;
    let text = `${qty} x ${name} @ ${money(price)} = ${money(qty * price - lineDiscount)}`;
    if (lineDiscount > 0) text += ` (disc ${money(lineDiscount)})`;
    lines.push(text);
  }
  lines.push(LINE);

  lines.push(`Subtotal: ${money(o.subtotal)}`);
  const applied = Array.isArray(o.appliedDiscounts) ? o.appliedDiscounts.filter((d) => Number(d.amount) > 0) : [];
  if (applied.length) {
    for (const d of applied) lines.push(`Discount${d.name ? ` (${d.name})` : ''}: -${money(d.amount)}`);
  } else if (Number(o.discount) > 0) {
    lines.push(`Discount${o.discountReason ? ` (${o.discountReason})` : ''}: -${money(o.discount)}`);
  }
  if (Number(o.tax) > 0) lines.push(`Tax: ${money(o.tax)}`);
  lines.push(`*Total: ${money(o.total)}*`);

  if (event === 'payment' && lastPayment) {
    lines.push(`This payment: ${money(lastPayment.amount)} (${methodLabel(lastPayment.paymentMethod)})`);
    lines.push(`Paid so far: ${money(o.paidAmount)}`);
  } else {
    let paid = `Paid: ${money(o.paidAmount)} (${methodLabel(o.paymentMethod)})`;
    if (o.paymentMethod === 'split' && (o.cashAmount || o.cardAmount)) {
      paid += ` - cash ${money(o.cashAmount)}, card ${money(o.cardAmount)}`;
    }
    lines.push(paid);
    if (o.paymentMethod === 'cash' && Number(o.changeGiven) > 0) lines.push(`Change: ${money(o.changeGiven)}`);
  }
  if (Number(o.pendingAmount) > 0) lines.push(`*Balance due: ${money(o.pendingAmount)}*`);
  if (o.orderStatus === 'refunded') lines.push('Status: REFUNDED');

  const cashier = personName(o.cashier);
  const receivedBy = event === 'payment' && lastPayment ? personName(lastPayment.receivedBy) : '';
  if (receivedBy) lines.push(`Received by: ${receivedBy}`);
  else if (cashier) lines.push(`Cashier: ${cashier}`);

  if (footer) {
    lines.push(LINE);
    lines.push(...String(footer).split(/\r?\n/).filter(Boolean));
  }
  return lines.join('\n');
}

module.exports = { buildOrderSlip, money, formatDateTime };
