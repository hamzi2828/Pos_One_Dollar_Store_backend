const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  variantId: {
    type: String,
    required: true
  },
  sku: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true
  },
  size: {
    type: String,
    required: true
  },
  color: {
    type: String,
    required: true
  }
});

const shippingAddressSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    default: ''
  },
  address: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true
  },
  state: {
    type: String,
    default: ''
  },
  zipCode: {
    type: String,
    default: ''
  },
  country: {
    type: String,
    required: true,
    default: 'United States'
  }
});

const orderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  orderNumber: {
    type: String,
    required: true,
    unique: true
  },
  items: [orderItemSchema],
  shippingAddress: {
    type: shippingAddressSchema,
    required: false
  },
  billingAddress: {
    type: shippingAddressSchema,
    required: false
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['stripe', 'paypal', 'cod', 'cash', 'card', 'split'],
    default: 'stripe'
  },
  // POS specific fields
  isPOS: {
    type: Boolean,
    default: false,
    index: true
  },
  cashAmount: {
    type: Number,
    required: false
  },
  cardAmount: {
    type: Number,
    required: false
  },
  changeGiven: {
    type: Number,
    required: false
  },
  cashier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  paymentStatus: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded'],
    default: 'pending'
  },
  orderStatus: {
    type: String,
    required: true,
    enum: ['submitted', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'],
    default: 'submitted'
  },
  stripePaymentIntentId: {
    type: String,
    required: false
  },
  stripeSessionId: {
    type: String,
    required: false
  },
  subtotal: {
    type: Number,
    required: true
  },
  shippingCost: {
    type: Number,
    required: true,
    default: 0
  },
  tax: {
    type: Number,
    required: true,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  discountCode: {
    type: String,
    default: null
  },
  total: {
    type: Number,
    required: true
  },
  notes: {
    type: String
  },
  trackingNumber: {
    type: String
  },
  shippedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  refundedAt: {
    type: Date
  },
  // Status history to track all status changes
  statusHistory: [{
    status: {
      type: String,
      required: true,
      enum: ['submitted', 'processing', 'shipped', 'completed', 'cancelled', 'refunded']
    },
    changedAt: {
      type: Date,
      required: true,
      default: Date.now
    },
    note: {
      type: String
    }
  }]
}, {
  timestamps: true
});

// --- Indexes: admin listing, notification count, and customer history ---
// `orderNumber` is already indexed via `unique: true` on the field.
// `isPOS` already has `index: true` on the field.
// Admin list default sort + pagination.
orderSchema.index({ createdAt: -1 });
// Sidebar badge + orders page filter: `countDocuments({ orderStatus, createdAt: {$gte} })`.
orderSchema.index({ orderStatus: 1, createdAt: -1 });
// Customer history ("my orders") — common user-scoped query.
orderSchema.index({ user: 1, createdAt: -1 });

orderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await this.constructor.countDocuments();
    const timestamp = Date.now().toString().slice(-6);
    this.orderNumber = `ORD-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

orderSchema.statics.generateOrderNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString().slice(-6);
  return `ORD-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);