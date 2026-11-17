import { env } from './auth.mjs';

// Every email ScrapSheet sends uses this one template: a card on warm paper
// with the logo and name, a divider, a heading, a short message, a tinted box
// for the key fact (or a code), a teal button, and the footer
// "Drop it here. Pull it up anywhere. / ScrapSheet by Sector 809 Labs".
// Add new emails by calling sendEmail() with content, never with your own HTML.
//
// Email clients ignore stylesheets and CSS variables, so the colors are the
// app's light-theme tokens (public/styles.css) written out, inline.

const C = {
  page: '#f5f1eb',      // --bg
  card: '#fffdf9',      // --surface
  box: '#ece6de',       // --raised
  line: '#ddd5cc',      // --line
  text: '#1c1c1c',      // --text
  soft: '#4d4640',      // --auth-soft
  muted: '#70655d',     // --muted
  accent: '#1f777b',    // --accent
  onAccent: '#ffffff'   // --on-accent
};
const FONT = "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TAGLINE = 'Drop it here. Pull it up anywhere.';
const BYLINE = 'ScrapSheet by Sector 809 Labs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const paras = value => (Array.isArray(value) ? value : value ? [value] : []);

// content: { preheader, heading, intro, box: { title, body, code }, button: { label, url }, note }
// origin: the site address the email is about (its logo and links come from there).
export function renderEmail(content, origin) {
  const { preheader = '', heading, intro, box, button, note } = content;
  const logo = `${origin}/assets/mark-light.png?v=2`;

  const introHtml = paras(intro).map(p =>
    `<p style="margin:0 0 12px;font-family:${FONT};font-size:17px;line-height:1.5;color:${C.soft};">${esc(p)}</p>`).join('');

  const boxHtml = box ? `
          <tr><td style="padding:12px 0 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${C.box};border-radius:14px;">
              <tr><td style="padding:18px 22px;">
                ${box.title ? `<p style="margin:0 0 4px;font-family:${FONT};font-size:17px;font-weight:700;line-height:1.35;color:${C.text};">${esc(box.title)}</p>` : ''}
                ${box.code ? `<p style="margin:2px 0 2px;font-family:${FONT};font-size:30px;font-weight:700;letter-spacing:2px;line-height:1.25;color:${C.text};">${esc(box.code)}</p>` : ''}
                ${box.body ? `<p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.soft};">${esc(box.body)}</p>` : ''}
              </td></tr>
            </table>
          </td></tr>` : '';

  const buttonHtml = button ? `
          <tr><td style="padding:22px 0 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
              <tr><td bgcolor="${C.accent}" style="border-radius:16px;background:${C.accent};">
                <a href="${esc(button.url)}" style="display:inline-block;padding:16px 34px;font-family:${FONT};font-size:17px;font-weight:600;line-height:1.2;color:${C.onAccent};text-decoration:none;border-radius:16px;">${esc(button.label)}</a>
              </td></tr>
            </table>
          </td></tr>` : '';

  const noteHtml = note ? `
          <tr><td style="padding:10px 0 0;">
            <p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.muted};">${esc(note)}</p>
          </td></tr>` : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(content.subject || heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:32px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;border-collapse:separate;background:${C.card};border:1px solid ${C.line};border-radius:20px;">
      <tr><td style="padding:26px 30px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;padding-right:12px;"><img src="${esc(logo)}" width="40" height="40" alt="" style="display:block;border:0;width:40px;height:40px;"></td>
            <td style="vertical-align:middle;font-family:${FONT};font-size:24px;font-weight:700;letter-spacing:-0.3px;color:${C.text};">ScrapSheet</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:20px 30px 0;"><div style="height:1px;line-height:1px;font-size:1px;background:${C.line};">&nbsp;</div></td></tr>
      <tr><td style="padding:24px 30px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td>
            <h1 style="margin:0 0 12px;font-family:${FONT};font-size:28px;font-weight:700;letter-spacing:-0.4px;line-height:1.2;color:${C.text};">${esc(heading)}</h1>
            ${introHtml}
          </td></tr>${boxHtml}${buttonHtml}${noteHtml}
        </table>
      </td></tr>
      <tr><td style="padding:18px 30px 0;"><div style="height:1px;line-height:1px;font-size:1px;background:${C.line};">&nbsp;</div></td></tr>
      <tr><td style="padding:16px 30px 24px;">
        <p style="margin:0 0 4px;font-family:${FONT};font-size:15px;font-weight:700;color:${C.soft};">${TAGLINE}</p>
        <p style="margin:0;font-family:${FONT};font-size:14px;color:${C.muted};">${BYLINE}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  // The plain-text part, in the same order.
  const text = [
    'ScrapSheet',
    '',
    heading,
    '',
    ...paras(intro).flatMap(p => [p, '']),
    ...(box ? [[box.title, box.code, box.body].filter(Boolean).join('\n'), ''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(note ? [note, ''] : []),
    '—',
    TAGLINE,
    BYLINE
  ].join('\n');

  return { html, text };
}

// Sends one email through Resend (RESEND_API_KEY, MAIL_FROM). Locally, with
// SCRATCHPAD_DEV_MAIL=1, logs it instead (and devLog, if given, for tests).
export async function sendEmail({ to, subject, origin, devLog, ...content }) {
  const { html, text } = renderEmail({ ...content, subject }, origin);
  const key = env('RESEND_API_KEY');
  const from = env('MAIL_FROM');
  if (!key || !from) {
    if (env('SCRATCHPAD_DEV_MAIL') === '1') {
      console.log(devLog || `[dev mail] to ${to}: ${subject}`);
      return { html, text };
    }
    throw new Error('Email is not set up (RESEND_API_KEY and MAIL_FROM)');
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return { html, text };
}
