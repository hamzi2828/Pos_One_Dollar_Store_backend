const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    // Link back to the Product master when the line item is a catalog product.
    // Free-text line items (shipping, service fees, etc.) leave productId null.
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    productName: { type: String, default: '', trim: true },
    productSku: { type: String, default: '', trim: true },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0, default: 1 },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: true }
);

const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: ['cash', 'bank', 'card', 'cheque', 'other'],
      default: 'cash',
    },
    paymentDate: { type: Date, required: true, default: Date.now },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: true, timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

const purchaseSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    // Denormalized vendor fields for fast list rendering without $lookup.
    vendorName: { type: String, default: '', trim: true },
    // Branch that made the purchase. null = old record = main branch.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },

    invoiceNumber: { type: String, required: true, trim: true, unique: true, index: true },
    purchaseDate: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date, default: null },

    items: { type: [itemSchema], default: [] },

    subtotal: { type: Number, required: true, min: 0, default: 0 },
    taxPercent: { type: Number, min: 0, max: 100, default: 0 },
    taxAmount: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0, default: 0 },

    // Payments are embedded to avoid a third collection (Atlas collection cap).
    payments: { type: [paymentSchema], default: [] },

    paidAmount: { type: Number, min: 0, default: 0 },
    pendingAmount: { type: Number, min: 0, default: 0 },
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'paid', 'overdue'],
      default: 'pending',
      index: true,
    },

    notes: { type: String, default: '', trim: true },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Compound indexes for the common filter combinations on the purchases list.
purchaseSchema.index({ isDeleted: 1, purchaseDate: -1 });
purchaseSchema.index({ branch: 1, isDeleted: 1, purchaseDate: -1 });
purchaseSchema.index({ isDeleted: 1, vendorId: 1, purchaseDate: -1 });
purchaseSchema.index({ isDeleted: 1, paymentStatus: 1, purchaseDate: -1 });
purchaseSchema.index({ isDeleted: 1, dueDate: 1 });
purchaseSchema.index(
  { invoiceNumber: 'text', vendorName: 'text', notes: 'text' },
  { name: 'purchase_text_idx', weights: { invoiceNumber: 10, vendorName: 5, notes: 1 } }
);

// Recompute totals + payment status before every save.
purchaseSchema.methods.recalc = function recalc() {
  const subtotal = (this.items || []).reduce((acc, it) => acc + (Number(it.total) || 0), 0);
  const tax = subtotal * (Number(this.taxPercent) || 0) / 100;
  const discount = Number(this.discount) || 0;
  const total = Math.max(0, subtotal + tax - discount);
  const paid = (this.payments || []).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  const pending = Math.max(0, total - paid);

  this.subtotal = subtotal;
  this.taxAmount = tax;
  this.total = total;
  this.paidAmount = paid;
  this.pendingAmount = pending;

  // Status: paid if nothing pending, partial if some paid, overdue if past due, else pending.
  if (pending <= 0) {
    this.paymentStatus = 'paid';
  } else if (paid > 0) {
    this.paymentStatus = 'partial';
  } else if (this.dueDate && new Date() > new Date(this.dueDate)) {
    this.paymentStatus = 'overdue';
  } else {
    this.paymentStatus = 'pending';
  }
};

purchaseSchema.pre('save', function preSave(next) {
  this.recalc();
  next();
});

module.exports = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);
