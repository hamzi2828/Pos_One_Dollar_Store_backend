// Mongoose plugin that gives a schema soft-delete behavior.
//
// - Adds `isDeleted`, `deletedAt`, `deletedBy` fields (indexed).
// - Pre-hooks on read/update queries inject `isDeleted: false` automatically,
//   so controllers don't need to be rewritten to add filters manually.
// - Pre-aggregate hook prepends a `$match` stage for the same reason.
// - Callers can opt back in to deleted rows with `.setOptions({ withDeleted: true })`
//   on queries or `{ withDeleted: true }` on aggregate options.
// - Provides `doc.softDelete(userId)` and `Model.softDeleteById(id, userId)`.

const mongoose = require('mongoose');

module.exports = function softDeletePlugin(schema) {
  // Skip if already applied (idempotent — some schemas declare these fields themselves).
  if (schema.path('isDeleted')) {
    // Still attach helpers/hooks if missing.
  } else {
    schema.add({
      isDeleted: { type: Boolean, default: false, index: true },
      deletedAt: { type: Date, default: null },
      deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    });
  }

  const queryOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'count',
    'countDocuments',
    'updateOne',
    'updateMany',
    'distinct',
  ];

  queryOps.forEach((op) => {
    schema.pre(op, function autoFilterDeleted() {
      if (this.getOptions && this.getOptions().withDeleted) return;
      const filter = this.getFilter ? this.getFilter() : this._conditions || {};
      // If the caller already scoped on isDeleted explicitly, respect it.
      if (filter && Object.prototype.hasOwnProperty.call(filter, 'isDeleted')) return;
      this.where({ isDeleted: { $ne: true } });
    });
  });

  // Aggregation — prepend a $match when isDeleted isn't already scoped.
  schema.pre('aggregate', function autoFilterDeletedAggregate() {
    if (this.options && this.options.withDeleted) return;
    const pipeline = this.pipeline();
    const first = pipeline[0];
    const alreadyScoped =
      first && first.$match && Object.prototype.hasOwnProperty.call(first.$match, 'isDeleted');
    if (alreadyScoped) return;
    pipeline.unshift({ $match: { isDeleted: { $ne: true } } });
  });

  // Instance helper
  schema.methods.softDelete = async function softDelete(userId = null) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = userId || null;
    return this.save();
  };

  // Static helper — returns the updated doc (null if not found / already deleted)
  schema.statics.softDeleteById = async function softDeleteById(id, userId = null) {
    return this.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId || null } },
      { new: true }
    );
  };

  // Restore helper
  schema.statics.restoreById = async function restoreById(id) {
    return this.findOneAndUpdate(
      { _id: id },
      { $set: { isDeleted: false, deletedAt: null, deletedBy: null } },
      { new: true, withDeleted: true }
    );
  };
};
