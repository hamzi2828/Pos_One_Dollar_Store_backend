// src/models/discountRule.js
// Bill discount rules applied by the server at the POS (services/sales/pricingService.js).
//
//   kind 'overall'   -> every bill gets it ("10% off everything this week")
//   kind 'threshold' -> only bills whose subtotal >= minSubtotal ("spend Rs 5,000, get 10% off")
//   valueType 'percentage' (value = 10 -> 10%) | 'fixed' (value = 500 -> Rs 500 off)
//   maxDiscount      -> cap for percentage rules (null = no cap)
//   stackable false  -> only the best non-stackable rule is used; stackable rules add on top
// Gifts are never part of the subtotal a rule looks at.
const mongoose = require('mongoose');

const discountRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, enum: ['overall', 'threshold'], required: true, default: 'threshold' },
    valueType: { type: String, enum: ['percentage', 'fixed'], required: true, default: 'percentage' },
    value: { type: Number, required: true, min: 0 },
    minSubtotal: { type: Number, min: 0, default: 0 },
    maxDiscount: { type: Number, min: 0, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    priority: { type: Number, default: 0 },
    stackable: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: '', maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Active-rule lookup at checkout + admin list.
discountRuleSchema.index({ isActive: 1, priority: -1 });
discountRuleSchema.index({ createdAt: -1 });

discountRuleSchema.plugin(require('../helper/softDeletePlugin'));

module.exports = mongoose.models.DiscountRule || mongoose.model('DiscountRule', discountRuleSchema);
