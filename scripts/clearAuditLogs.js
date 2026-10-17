// Script to clear all audit logs
// Run with: node scripts/clearAuditLogs.js

require('dotenv').config();
const mongoose = require('mongoose');
const AuditLog = require('../src/models/auditLog');

async function clearAuditLogs() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('MongoDB URI not found in environment variables');
      process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected!\n');

    const countBefore = await AuditLog.countDocuments();
    console.log(`Audit logs found: ${countBefore}`);

    if (countBefore === 0) {
      console.log('Nothing to delete.');
      await mongoose.disconnect();
      return;
    }

    console.log('Deleting all audit logs...');
    const result = await AuditLog.deleteMany({});
    console.log(`Deleted ${result.deletedCount} audit log(s).`);

    const countAfter = await AuditLog.countDocuments();
    console.log(`Remaining audit logs: ${countAfter}`);

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

clearAuditLogs();
