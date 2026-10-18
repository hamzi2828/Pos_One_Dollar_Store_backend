// Held Order Controller
const HeldOrder = require('../models/heldOrder');
const { resolveWriteBranch } = require('../middleware/access');

// Parked POS carts of the shop.

const heldOrderController = {
  getAllHeldOrders: async (req, res) => {
    try {
      const heldOrders = await HeldOrder.find({ isDeleted: { $ne: true } })
        .populate('heldBy', 'firstName lastName email')
        .populate('customer', 'firstName lastName phone')
        .sort({ createdAt: -1 });
      return res.status(200).json({ success: true, message: 'Held orders fetched successfully', data: heldOrders });
    } catch (error) {
      console.error('Error fetching held orders:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch held orders', error: error.message });
    }
  },

  getMyHeldOrders: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const heldOrders = await HeldOrder.find({ heldBy: userId, isDeleted: { $ne: true } })
        .populate('customer', 'firstName lastName phone')
        .sort({ createdAt: -1 });
      return res.status(200).json({ success: true, message: 'Held orders fetched successfully', data: heldOrders });
    } catch (error) {
      console.error('Error fetching held orders:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch held orders', error: error.message });
    }
  },

  getHeldOrderById: async (req, res) => {
    try {
      const heldOrder = await HeldOrder.findOne({
        _id: req.params.id,
        isDeleted: { $ne: true },
      })
        .populate('heldBy', 'firstName lastName email')
        .populate('customer', 'firstName lastName phone');
      if (!heldOrder) return res.status(404).json({ success: false, message: 'Held order not found' });
      return res.status(200).json({ success: true, message: 'Held order fetched successfully', data: heldOrder });
    } catch (error) {
      console.error('Error fetching held order:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch held order', error: error.message });
    }
  },

  createHeldOrder: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const userName = req.user?.firstName
        ? `${req.user.firstName} ${req.user.lastName || ''}`.trim()
        : 'Unknown User';

      const { cart, customerName, notes } = req.body;
      if (!cart || !cart.items || cart.items.length === 0) {
        return res.status(400).json({ success: false, message: 'Cart is empty or invalid' });
      }

      const branch = await resolveWriteBranch(req);

      const items = cart.items.map((item) => ({
        product: item.product?._id || null,
        productName: item.product?.name || 'Unknown Product',
        productThumbnail: item.product?.thumbnailUrl || null,
        costPrice: item.costPrice,
        variantId: item.variantId,
        sku: item.variant?.sku || item.product?.sku || '',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        originalPrice: item.originalPrice,
        discount: item.discount || 0,
        subtotal: item.subtotal,
        size: item.size || item.variant?.size,
        color: item.color || item.variant?.color,
        isGift: !!item.isGift,
        giftReason: item.isGift ? item.giftReason || '' : undefined,
        priceOverride: !!item.priceOverride,
      }));

      const heldOrder = await HeldOrder.create({
        branch,
        customer: cart.customer?._id || null,
        customerInfo: cart.customer
          ? {
              _id: cart.customer._id,
              firstName: cart.customer.firstName,
              lastName: cart.customer.lastName,
              phone: cart.customer.phone,
              customerType: cart.customer.customerType,
              source: cart.customer.source,
            }
          : null,
        customerName:
          customerName ||
          (cart.customer ? `${cart.customer.firstName} ${cart.customer.lastName || ''}`.trim() : ''),
        items,
        subtotal: cart.subtotal,
        tax: cart.tax,
        taxRate: cart.taxRate,
        appliedTaxes: cart.appliedTaxes || [],
        discount: cart.discount,
        discountType: cart.discountType,
        discountReason: cart.discountReason,
        total: cart.total,
        heldBy: userId,
        heldByName: userName,
        notes: notes || '',
      });

      return res.status(201).json({ success: true, message: 'Order held successfully', data: heldOrder });
    } catch (error) {
      console.error('Error creating held order:', error);
      return res.status(500).json({ success: false, message: 'Failed to hold order', error: error.message });
    }
  },

  retrieveHeldOrder: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const heldOrder = await HeldOrder.findOne({
        _id: req.params.id,
        isDeleted: { $ne: true },
      });
      if (!heldOrder) return res.status(404).json({ success: false, message: 'Held order not found' });
      heldOrder.isDeleted = true;
      heldOrder.deletedAt = new Date();
      heldOrder.deletedBy = userId;
      await heldOrder.save();
      return res.status(200).json({ success: true, message: 'Held order retrieved successfully', data: heldOrder });
    } catch (error) {
      console.error('Error retrieving held order:', error);
      return res.status(500).json({ success: false, message: 'Failed to retrieve held order', error: error.message });
    }
  },

  deleteHeldOrder: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const heldOrder = await HeldOrder.findOne({
        _id: req.params.id,
        isDeleted: { $ne: true },
      });
      if (!heldOrder) return res.status(404).json({ success: false, message: 'Held order not found' });
      heldOrder.isDeleted = true;
      heldOrder.deletedAt = new Date();
      heldOrder.deletedBy = userId;
      await heldOrder.save();
      return res.status(200).json({ success: true, message: 'Held order deleted successfully', data: heldOrder });
    } catch (error) {
      console.error('Error deleting held order:', error);
      return res.status(500).json({ success: false, message: 'Failed to delete held order', error: error.message });
    }
  },

  clearAllHeldOrders: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const result = await HeldOrder.updateMany(
        { heldBy: userId, isDeleted: { $ne: true } },
        { isDeleted: true, deletedAt: new Date(), deletedBy: userId }
      );
      return res.status(200).json({
        success: true,
        message: `${result.modifiedCount} held orders cleared successfully`,
        data: { clearedCount: result.modifiedCount },
      });
    } catch (error) {
      console.error('Error clearing held orders:', error);
      return res.status(500).json({ success: false, message: 'Failed to clear held orders', error: error.message });
    }
  },
};

module.exports = heldOrderController;
