// Seeder/seedAdmin.js — create (or repair) the super admin login.
//
//   ADMIN_EMAIL=owner@example.com ADMIN_NAME="Shop Owner" ADMIN_PASSWORD='...' npm run seed:admin
//
// - ADMIN_EMAIL is required; ADMIN_NAME defaults to "Super Admin".
// - No ADMIN_PASSWORD: a strong random password is generated and printed ONCE.
// - Safe to re-run: an existing account with that e-mail is made an active
//   super admin; its password only changes when ADMIN_PASSWORD is given (or
//   when it has none yet).
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../src/models/user');
const { assertEmail, assertPassword, hashPassword, normalizeEmail } = require('../src/services/staffService');

const generatePassword = () => crypto.randomBytes(15).toString('base64url'); // 20 characters

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Super', lastName: 'Admin' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Create / update the super admin. Uses the current mongoose connection.
 * Returns { created, email, password } — `password` is set only when one was generated.
 */
async function seedAdmin({ email, password, name } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('ADMIN_EMAIL is required');
  assertEmail(cleanEmail);
  if (password) assertPassword(password);

  const { firstName, lastName } = splitName(name || 'Super Admin');
  const existing = await User.findOne({ email: cleanEmail }).setOptions({ withDeleted: true });
  const generated = !password && !(existing && existing.password) ? generatePassword() : null;
  const newPassword = password || generated;

  const user = existing || new User({ email: cleanEmail, firstName, lastName });
  if (existing && name) Object.assign(user, { firstName, lastName });
  Object.assign(user, {
    role: 'admin',
    isSuperAdmin: true,
    isActive: true,
    staffRole: null,
    branch: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
  });
  if (newPassword) user.password = await hashPassword(newPassword);
  await user.save();

  return { created: !existing, email: cleanEmail, password: generated };
}

async function main() {
  require('dotenv').config();
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (see .env.example)');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await seedAdmin({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      name: process.env.ADMIN_NAME,
    });
    console.log(`Super admin ${result.created ? 'created' : 'updated'}: ${result.email}`);
    if (result.password) {
      console.log('Generated password (shown once — store it safely, then change it after signing in):');
      console.log(`  ${result.password}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('seed:admin failed:', err.message);
    process.exit(1);
  });
}

module.exports = { seedAdmin };
