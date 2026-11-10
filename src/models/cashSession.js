// src/models/cashSession.js
// A till (cash drawer) session: a cashier opens a counter with a float of
// change money, sells, then does a BLIND cash count at the end of the shift.
// The expected cash is computed by the server at close and only shown to
// users with `till_verify`, who verify or dispute the session.
//
//   open ──close (blind count)──► closed ──verify──► verified
//                                        └─dispute─► disputed ──verify──► verified
//
// OWNER: Cash & Notifications module (logic in services/tillService.js).
const mongoose = require('mongoose');

// Cash counted by denomination: { denominations: { "5000": 1, "100": 7 }, total }.
const cashCountSchema = new mongoose.Schema(
  {
    denominations: { type: Map, of: Number, default: () => ({}) },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const cashSessionSchema = new mongoose.Schema(
  {
    sessionNo: { type: String, required: true, unique: true }, // TILL-2026-00001
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    counter: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleCounter', default: null },
    counterName: { type: String, default: '' }, // denormalized for lists / CSV
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    cashierName: { type: String, default: '' },
    status: {
      type: String,
      // 'deleted' (owner, 2026-11-08): removed by an admin; hidden everywhere, record kept.
      enum: ['open', 'closed', 'verified', 'disputed', 'deleted'],
      default: 'open',
    },

    openedAt: { type: Date, default: Date.now },
    openingFloat: { type: cashCountSchema, default: () => ({}) },
    openNote: { type: String, default: '' },
    lateOpen: { type: Boolean, default: false },

    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Blind count entered by the cashier (they never see the expected amount).
    closingCount: { type: cashCountSchema, default: null },
    // Day's cash (owner 2026-11-06): after closing, the cashier adds the sales cash
    // taken out of the drawer (handed over). closingCount = drawerCount + dayCash.
    drawerCount: { type: cashCountSchema, default: null }, // what was in the drawer at close
    dayCash: { type: cashCountSchema, default: null },
    dayCashAt: { type: Date, default: null },
    dayCashNote: { type: String, default: '' },
    // Entered by the cashier at close (owner 2026-11-06): POS machine slip total and bank transfers.
    cardTotal: { type: Number, default: null },
    bankTransferTotal: { type: Number, default: null },
    // JazzCash wallet total, its own figure (owner, 2026-11-11).
    jazzcashTotal: { type: Number, default: null },
    closeNote: { type: String, default: '' },
    // Till report saved by the cashier but NOT submitted yet (owner 2026-11-06).
    // The till stays open (sales keep going into it) and the report can be edited
    // until "Submit report", which closes the till with these figures.
    draft: {
      type: new mongoose.Schema(
        {
          denominations: { type: Map, of: Number, default: () => ({}) },
          drawerTotal: { type: Number, default: 0 },
          dayCashTotal: { type: Number, default: 0 },
          dayCashDenominations: { type: Map, of: Number, default: () => ({}) },
          cardTotal: { type: Number, default: null },
          bankTransferTotal: { type: Number, default: null },
          jazzcashTotal: { type: Number, default: null },
          note: { type: String, default: '' },
          savedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    lateClose: { type: Boolean, default: false },

    // Computed by the server at close (see tillService.computeExpected).
    expected: {
      float: { type: Number, default: 0 },
      cashSales: { type: Number, default: 0 },
      cashReceivedOnCredit: { type: Number, default: 0 },
      cashRefunds: { type: Number, default: 0 },
      // All expenses dated the till's day (owner 2026-11-06: taken off the expected cash).
      expenses: { type: Number, default: 0 },
      expectedCash: { type: Number, default: 0 },
      // Not cash: what the system took by POS machine (card), bank transfer (UBL) and JazzCash.
      card: { type: Number, default: 0 },
      bankTransfer: { type: Number, default: 0 },
      jazzcash: { type: Number, default: 0 },
      billCount: { type: Number, default: 0 },
    },
    // Expenses / vendor payments this till took off its cash, saved at close
    // (owner, 2026-11-08): once a till counted one, no other till counts it again.
    // Missing (undefined) on tills closed before this was saved.
    payoutIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    // counted − expected (negative = short, positive = over).
    variance: { type: Number, default: null },

    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    verifyNote: { type: String, default: '' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deleteReason: { type: String, default: '' },

    history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        action: { type: String },
        note: { type: String, default: '' },
      },
    ],
  },
  { timestamps: true }
);

// One open session per cashier and per counter (also safe when two requests race).
cashSessionSchema.index(
  { cashier: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_per_cashier' }
);
cashSessionSchema.index(
  { counter: 1 },
  { unique: true, partialFilterExpression: { status: 'open', counter: { $type: 'objectId' } }, name: 'one_open_per_counter' }
);
// List / report filters.
cashSessionSchema.index({ branch: 1, openedAt: -1 });
cashSessionSchema.index({ status: 1, openedAt: -1 });
cashSessionSchema.index({ cashier: 1, openedAt: -1 });
cashSessionSchema.index({ counter: 1, openedAt: -1 });

module.exports = mongoose.models.CashSession || mongoose.model('CashSession', cashSessionSchema);
