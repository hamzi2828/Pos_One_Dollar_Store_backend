// src/services/mail/templates/portalOtpEmail.js
// Email with the Employee Portal sign-in code. Table layout + inline styles so
// it looks the same in Gmail, Outlook and phone mail apps. Colours = the shop
// sign: yellow "DOLLAR", green "&", white "Co" on black.
//
//   portalOtpEmail({ name, code, minutes, portalUrl }) -> { subject, text, html }

const YELLOW = '#FFD60A';
const GREEN = '#22C55E';
const INK = '#0A0A0A';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function portalOtpEmail({ name, code, minutes = 10, portalUrl = '' } = {}) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const digits = String(code);
  const when = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const subject = `${digits} is your DOLLAR & Co Employee Portal code`;

  const text = [
    `Hi ${first},`,
    '',
    'Use this code to sign in to the DOLLAR & Co Employee Portal:',
    '',
    `    ${digits}`,
    '',
    `The code works for ${minutes} minutes and only once.`,
    portalUrl ? `Portal: ${portalUrl}` : '',
    '',
    'Did not ask for this code? Ignore this email. Nobody can sign in without the code.',
    'Never share this code with anyone, not even shop staff.',
    '',
    `Requested ${when} (Pakistan time).`,
    'DOLLAR & Co',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');

  const digitCells = digits
    .split('')
    .map(
      (d) =>
        `<td style="padding:0 4px;"><div style="width:44px;height:56px;line-height:56px;border-radius:10px;background:#FFFCEB;border:2px solid ${YELLOW};font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;color:${INK};text-align:center;">${esc(d)}</div></td>`
    )
    .join('');

  const button = portalUrl
    ? `<tr><td align="center" style="padding:4px 32px 28px;">
          <a href="${esc(portalUrl)}" style="display:inline-block;background:${INK};color:${YELLOW};text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:8px;">Open the Employee Portal</a>
        </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your sign-in code is ${esc(digits)}. It works for ${minutes} minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <tr><td align="center" style="background:${INK};padding:26px 24px 20px;">
          <div style="font-size:30px;font-weight:900;letter-spacing:-0.5px;line-height:1;">
            <span style="color:${YELLOW};">DOLLAR</span>&nbsp;<span style="color:${GREEN};">&amp;</span>&nbsp;<span style="color:#FFFFFF;">Co</span>
          </div>
          <div style="margin-top:10px;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${YELLOW};">Employee Portal</div>
        </td></tr>
        <tr><td style="height:4px;background:${YELLOW};line-height:4px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px 32px 8px;">
          <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${INK};">Hi ${esc(first)},</p>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">Use this code to sign in to the Employee Portal and see your attendance, salary and payslips.</p>
        </td></tr>
        <tr><td align="center" style="padding:22px 24px 10px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${digitCells}</tr></table>
        </td></tr>
        <tr><td align="center" style="padding:6px 32px 22px;">
          <p style="margin:0;font-size:13px;color:#6B7280;">This code works for <b style="color:${INK};">${minutes} minutes</b> and only once.</p>
        </td></tr>
        ${button}
        <tr><td style="padding:0 32px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:12.5px;line-height:1.6;color:#4B5563;">
              <b style="color:${INK};">Keep this code private.</b> Never share it with anyone, not even shop staff.
              If you did not ask for this code, you can ignore this email. Nobody can sign in without it.
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="background:#FAFAFA;border-top:1px solid #F0F0F0;padding:16px 24px;font-size:11.5px;line-height:1.6;color:#9CA3AF;">
          Requested ${esc(when)} (Pakistan time)<br>
          DOLLAR &amp; Co &middot; This is an automatic email, please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

module.exports = { portalOtpEmail };
