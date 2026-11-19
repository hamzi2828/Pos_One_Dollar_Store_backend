// src/services/hr/portalLoginService.js
// Employee Portal sign-in without a password: the employee types the email
// saved on their employee record, gets a 6-digit code by email, types it, and
// gets a portal-only token. No staff login (User) is needed.
//
//   requestCode(email)        send a code (POST /api/portal/login/request-code)
//   verifyCode(email, code)   check it, return { token, employee } (POST /api/portal/login/verify)
//
// The token ({ kind: 'portal', emp }) opens ONLY /api/me/portal/... —
// loadAccess (middleware/access.js) refuses it everywhere else.
// Only employees with status "active" can sign in.
// Rules: code works 10 minutes and once; 5 wrong tries kill the code;
// 60 s between codes; at most 5 codes per email per hour.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Employee = require('../../models/employee');
const PortalOtp = require('../../models/portalOtp');
const mail = require('../mail/mailService');
const { portalOtpEmail } = require('../mail/templates/portalOtpEmail');
const { httpError } = require('./util');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_PER_HOUR = 5;
const TOKEN_LIFE = '7d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PORTAL_STATUS = 'active';
const DEFAULT_SITE = 'https://pos.dollarandco.org';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw httpError(500, 'Server misconfiguration: missing JWT secret');
  return s;
}

const hashCode = (email, code) =>
  crypto.createHmac('sha256', `portal-otp:${secret()}`).update(`${email}:${code}`).digest('hex');

function cleanEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  if (!email) throw httpError(400, 'Enter your email.');
  if (!EMAIL_RE.test(email) || email.length > 200) throw httpError(400, 'This email is not valid.');
  return email;
}

// Link in the code email. Set PORTAL_URL=https://employee.dollarandco.org once that
// address works, so staff land on their own portal site.
function portalUrl() {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL;
  const site = String(process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .find((s) => s.startsWith('https://'));
  return `${site || DEFAULT_SITE}/authentication?next=/portal`;
}

/** The one active employee with this email (clear message otherwise). */
async function employeeByEmail(email) {
  const list = await Employee.find({ email, isDeleted: { $ne: true } })
    .select('firstName lastName email status isActive')
    .limit(5)
    .lean();
  // Only status "active" (Admin -> HR -> Employees) can sign in; on leave, resigned
  // and terminated staff cannot (owner 2026-11-18).
  const active = list.filter((e) => e.status === PORTAL_STATUS);
  if (!active.length) {
    if (list.length) throw httpError(403, 'Your employee status is not Active, so the portal is closed. Ask the shop admin.', 'NOT_ACTIVE');
    throw httpError(404, 'No employee uses this email. Check it, or ask the shop admin to add it to your record.', 'NO_EMPLOYEE');
  }
  if (active.length > 1) throw httpError(409, 'More than one employee uses this email. Ask the shop admin to fix it.', 'DUPLICATE_EMAIL');
  return active[0];
}

const nameOf = (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim();

async function requestCode(emailInput, { now = new Date() } = {}) {
  const email = cleanEmail(emailInput);
  const emp = await employeeByEmail(email);

  let otp = await PortalOtp.findOne({ email });
  if (otp && otp.sentAt) {
    const wait = Math.ceil((otp.sentAt.getTime() + RESEND_SECONDS * 1000 - now.getTime()) / 1000);
    if (wait > 0) {
      const err = httpError(429, `Please wait ${wait} seconds before asking for a new code.`, 'WAIT');
      err.available = wait;
      throw err;
    }
  }
  if (!otp) otp = new PortalOtp({ email, employee: emp._id });
  const inWindow = otp.windowStart && now.getTime() - otp.windowStart.getTime() < 60 * 60 * 1000;
  if (inWindow && otp.windowCount >= MAX_PER_HOUR) {
    throw httpError(429, 'Too many codes asked for this email. Try again in an hour.', 'TOO_MANY');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const message = portalOtpEmail({ name: nameOf(emp), code, minutes: CODE_MINUTES, portalUrl: portalUrl() });
  try {
    await mail.sendMail({ to: email, ...message });
  } catch (err) {
    console.error('[portal-otp] send failed:', err && err.message);
    const e = httpError(503, 'Could not send the email right now. Please try again, or tell the shop admin.', 'MAIL_FAILED');
    e.expose = true; // show this to the employee instead of "Something went wrong"
    throw e;
  }

  // Saved only after the email went out, so a failed send does not burn the wait.
  otp.employee = emp._id;
  otp.codeHash = hashCode(email, code);
  otp.expiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000);
  otp.attempts = 0;
  otp.sentAt = now;
  if (inWindow) otp.windowCount += 1;
  else {
    otp.windowStart = now;
    otp.windowCount = 1;
  }
  await otp.save();

  return { email, minutes: CODE_MINUTES, resendSeconds: RESEND_SECONDS };
}

async function verifyCode(emailInput, codeInput, { now = new Date() } = {}) {
  const email = cleanEmail(emailInput);
  const code = String(codeInput || '').replace(/\D/g, '');
  if (code.length !== 6) throw httpError(400, 'Enter the 6-digit code from the email.');

  const otp = await PortalOtp.findOne({ email });
  if (!otp || !otp.codeHash || otp.expiresAt.getTime() <= now.getTime()) {
    throw httpError(400, 'This code has expired. Ask for a new code.', 'EXPIRED');
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw httpError(429, 'Too many wrong codes. Ask for a new code.', 'TOO_MANY_TRIES');
  }

  const expected = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hashCode(email, code), 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    const after = await PortalOtp.findOneAndUpdate({ _id: otp._id }, { $inc: { attempts: 1 } }, { new: true }).lean();
    const left = MAX_ATTEMPTS - ((after && after.attempts) || MAX_ATTEMPTS);
    throw httpError(
      400,
      left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask for a new code.',
      left > 0 ? 'WRONG_CODE' : 'TOO_MANY_TRIES'
    );
  }

  // Used once: clear the code (the send counters stay). Atomic, so two quick
  // submits of the same code cannot both sign in.
  const used = await PortalOtp.findOneAndUpdate(
    { _id: otp._id, codeHash: otp.codeHash, attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { codeHash: '', attempts: 0 } }
  );
  if (!used) throw httpError(400, 'This code has expired. Ask for a new code.', 'EXPIRED');

  // Still the same, still active employee?
  const emp = await employeeByEmail(email);
  if (String(emp._id) !== String(otp.employee)) throw httpError(400, 'This code has expired. Ask for a new code.', 'EXPIRED');

  const name = nameOf(emp);
  const token = jwt.sign(
    // id + email: the frontend's token check needs both. kind/emp: what the server uses.
    { kind: 'portal', emp: String(emp._id), id: String(emp._id), email, firstName: emp.firstName || '', lastName: emp.lastName || '' },
    secret(),
    { expiresIn: TOKEN_LIFE }
  );
  return { token, employee: { _id: String(emp._id), name, email } };
}

module.exports = { requestCode, verifyCode, PORTAL_STATUS, CODE_MINUTES, MAX_ATTEMPTS, RESEND_SECONDS, MAX_PER_HOUR };
