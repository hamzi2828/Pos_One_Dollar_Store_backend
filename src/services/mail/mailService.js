// src/services/mail/mailService.js
// SMTP settings saved from Admin → Settings → Email, and sending mail with them.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailSettings = require('../../models/mailSettings');

const DEFAULT_TEST_TO = 'hamzahashmi640@gmail.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// AES-256-GCM key from SMTP_SECRET (or JWT_SECRET).
function key() {
  const secret = process.env.SMTP_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Server has no SMTP_SECRET / JWT_SECRET to encrypt the password');
  return crypto.createHash('sha256').update(`smtp:${secret}`).digest();
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

async function load() {
  return (await MailSettings.findOne({ key: 'smtp' })) || new MailSettings({ key: 'smtp' });
}

// What the admin page sees: never the password, only whether one is saved.
function view(doc) {
  return {
    enabled: !!doc.enabled,
    host: doc.host || '',
    port: doc.port || 587,
    secure: !!doc.secure,
    user: doc.user || '',
    hasPassword: !!doc.passEnc,
    fromName: doc.fromName || '',
    fromEmail: doc.fromEmail || '',
    testTo: doc.testTo || DEFAULT_TEST_TO,
    lastTest: doc.lastTest && doc.lastTest.at ? doc.lastTest : null,
    updatedAt: doc.updatedAt || null,
  };
}

async function getSettings() {
  return view(await load());
}

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Save. An empty / missing password keeps the saved one; clearPassword removes it.
async function saveSettings(body = {}, userId) {
  const doc = await load();
  if (body.host !== undefined) doc.host = String(body.host).trim();
  if (body.port !== undefined) {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad('Port must be a number like 587 or 465');
    doc.port = p;
  }
  if (body.secure !== undefined) doc.secure = !!body.secure;
  if (body.user !== undefined) doc.user = String(body.user).trim();
  if (body.fromName !== undefined) doc.fromName = String(body.fromName).trim();
  if (body.fromEmail !== undefined) {
    const f = String(body.fromEmail).trim();
    if (f && !EMAIL_RE.test(f)) throw bad('From email is not a valid email');
    doc.fromEmail = f;
  }
  if (body.testTo !== undefined) {
    const t = String(body.testTo).trim();
    if (t && !EMAIL_RE.test(t)) throw bad('Test email is not a valid email');
    doc.testTo = t;
  }
  if (body.enabled !== undefined) doc.enabled = !!body.enabled;
  if (body.clearPassword) doc.passEnc = '';
  // Gmail shows app passwords in groups of 4 with spaces; spaces are dropped.
  else if (typeof body.password === 'string' && body.password.trim()) doc.passEnc = encrypt(body.password.replace(/\s+/g, ''));
  if (doc.enabled && (!doc.host || !doc.user || !doc.passEnc)) throw bad('Fill host, username and password before turning email on');
  if (userId) doc.updatedBy = userId;
  await doc.save();
  return view(doc);
}

function transportFor(doc) {
  return nodemailer.createTransport({
    host: doc.host,
    port: doc.port,
    secure: !!doc.secure,
    auth: { user: doc.user, pass: decrypt(doc.passEnc) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}
function fromOf(doc) {
  const email = doc.fromEmail || doc.user;
  return doc.fromName ? `"${doc.fromName.replace(/"/g, '')}" <${email}>` : email;
}

// Send one email with the saved settings (for other features to use).
async function sendMail({ to, subject, text, html }) {
  const doc = await load();
  if (!doc.enabled) throw bad('Email is turned off in Settings → Email');
  if (!doc.host || !doc.user || !doc.passEnc) throw bad('SMTP settings are not complete');
  return transportFor(doc).sendMail({ from: fromOf(doc), to, subject, text, html });
}

// Test the saved settings: log in and send one email to the test address.
async function sendTest(toInput) {
  const doc = await load();
  if (!doc.host || !doc.user || !doc.passEnc) throw bad('Save host, username and password first');
  const to = String(toInput || doc.testTo || DEFAULT_TEST_TO).trim();
  if (!EMAIL_RE.test(to)) throw bad('Test email is not a valid email');
  let ok = false;
  let message = '';
  try {
    const t = transportFor(doc);
    await t.verify();
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' });
    const info = await t.sendMail({
      from: fromOf(doc),
      to,
      subject: 'DOLLAR & Co POS - test email',
      text: `SMTP is working.\n\nSent from ${doc.host}:${doc.port} as ${doc.user} at ${when} (Pakistan time).`,
    });
    ok = true;
    message = `Sent to ${to}${info && info.messageId ? ` (id ${info.messageId})` : ''}`;
  } catch (err) {
    message = err && err.message ? err.message : String(err);
  }
  doc.lastTest = { at: new Date(), ok, to, message: message.slice(0, 500) };
  await doc.save();
  return { ok, to, message, settings: view(doc) };
}

module.exports = { getSettings, saveSettings, sendTest, sendMail, DEFAULT_TEST_TO, _encrypt: encrypt, _decrypt: decrypt };
