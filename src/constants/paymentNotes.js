// Payment Note Constants — used in POS payment history entries

const PAYMENT_NOTES = {
  INITIAL_PARTIAL: 'Initial partial payment',
  ADDITIONAL: 'Additional payment',
  FULL: 'Full payment',
  PAYMENT: 'Payment',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PARTIAL: 'partial',
  COMPLETED: 'completed',
  FULL: 'full',
};

module.exports = { PAYMENT_NOTES, PAYMENT_STATUS };
