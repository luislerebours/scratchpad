// The account-deletion web page (Google Play asks for one), and deleting an
// account from the admin dashboard for someone who can't sign in.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; const MOCK = 'http://localhost:8972'; 
const SETUP = 'local-test-setup-token-0123456789';
const log = () => fs.readFileSync(__dirname + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = s => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/\s/g, '')) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = secret => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const m = crypto.createHmac('sha1', unb32(secret)).update(c).digest(); const o = m[19] & 15; return String((m.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
const D = 'gone' + Date.now() + '@example.com';

(async () => {
  const b = await chromium.launch(); const errs = [];

  // ---- The page ----
  for (const [name, opts] of [['phone', devices['iPhone 13']], ['desktop', { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }]]) {
    for (const theme of ['light', 'dark']) {
      const p = await (await b.newContext(opts)).newPage(); p.on('pageerror', e => errs.push(e.message));
      const r = await p.goto(BASE + '/delete-account'); await p.evaluate(t => window.scratchTheme.set(t), theme); await p.reload(); await sleep(300);
      if (theme === 'light') {
        ok(`${name}: /delete-account opens`, r.status() === 200 && (await p.title()) === 'Delete your account · ScrapSheet');
        const t = await p.textContent('.legal-doc');
        ok(`${name}: names the app and developer`, t.includes('ScrapSheet, by Sector 809 Labs LLC'));
        ok(`${name}: the steps, in order`, (await p.$$eval('.legal-doc ol li', l => l.length)) === 3 && t.includes('Account & security') && t.includes('Delete account…'));
        ok(`${name}: what’s deleted and what’s kept`, t.includes('What is deleted, right away') && t.includes('What is kept') && t.includes('Payment records'));
        ok(`${name}: a way for people who can’t sign in`, (await p.getAttribute('a[href^="mailto:support@sector809labs.com?subject="]', 'href')).includes('Delete%20my%20ScrapSheet%20account'));
        ok(`${name}: no sideways scrolling`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await p.screenshot({ path: OUT + `delete-page-${name}-${theme}.png`, fullPage: name === 'phone' && theme === 'light' });
      await p.context().close();
    }
  }
  const pol = await (await b.newContext()).newPage();
  for (const path of ['/privacy', '/terms']) {
    await pol.goto(BASE + path);
    ok(`${path} links to it`, (await pol.$$('a[href="/delete-account"]')).length === 1);
  }

  // ---- An account with data and Pro through Google Play ----
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const u = await ctx.newPage(); u.on('pageerror', e => errs.push(e.message));
  await u.goto(BASE); await u.click('.auth-create'); await u.fill('#codeEmail', D); await u.click('#emailForm .auth-submit');
  await u.waitForSelector('#codeForm:not([hidden])'); await u.fill('#codeInput', lastCode(D)); await u.click('#codeForm .auth-submit');
  await u.waitForSelector('#passwordForm:not([hidden])'); await u.fill('#newPassword', 'pass-12345'); await u.click('#passwordForm .auth-submit');
  await u.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await u.check('#recoverySaved'); await u.click('#recoveryKeyForm .auth-submit');
  await u.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await u.click('#scratchpad'); await u.keyboard.type('Private notes');
  await u.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  const { token } = await (await fetch(MOCK + '/__buy', { method: 'POST', body: JSON.stringify({ productId: 'scrapsheet_pro_month' }) })).json();
  const v = await u.evaluate(async t => (await fetch('/.netlify/functions/play?action=verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) })).json(), token);
  ok('(the account is Pro through Google Play)', v.plan?.plan === 'pro' && v.plan.billing.source === 'play');

  // ---- An admin deletes it ----
  const a = await (await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage(); a.on('pageerror', e => errs.push(e.message));
  await a.goto(BASE + '/admin'); await a.waitForSelector('#setupForm:not([hidden])');
  await a.fill('#setupToken', SETUP); await a.fill('#setupName', 'Ada'); await a.fill('#setupEmail', 'ada@sector.test'); await a.fill('#setupPassword', 'a-long-admin-pass-1');
  await a.click('#setupForm [type=submit]'); await a.waitForSelector('#enrollForm:not([hidden])');
  const secret = (await a.textContent('#enrollSecret')).replace(/\s/g, '');
  await a.fill('#enrollCode', totp(secret)); await a.click('#enrollForm [type=submit]');
  await a.waitForSelector('#recoveryForm:not([hidden])'); await a.check('#codesSaved'); await a.click('#recoveryForm [type=submit]');
  await a.waitForSelector('#dash:not([hidden])');
  await a.click('[data-tab=accounts]'); await a.waitForSelector('#accountsTable tbody tr td .ad-email');
  await a.fill('#accountSearch', D); await a.click('#accountsTable tbody tr button'); await a.waitForSelector('#accountDialog[open]');
  ok('the account shows billing through Google Play', (await a.textContent('#accountDialog')).includes('Google Play · active'));
  ok('there’s a Delete account… button', await a.isVisible('#deleteAccountBtn'));
  await a.click('#deleteAccountBtn'); await a.waitForSelector('#confirmDialog[open]');
  ok('it explains it’s permanent and needs the email typed', (await a.textContent('#confirmDialog')).includes('can’t be undone') && await a.isDisabled('#confirmOk'));
  await a.fill('#confirmType', D); await a.fill('#confirmReason', 'Asked by email, can’t sign in');
  await a.screenshot({ path: OUT + 'admin-delete-confirm.png' });
  const refused = await a.evaluate(async email => {
    const { accounts } = await (await fetch('/.netlify/functions/admin-api?view=accounts')).json();
    const id = accounts.find(x => x.email === email).id;
    return (await fetch('/.netlify/functions/admin-api?action=account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, op: 'delete', confirm: 'someone@else.com' }) })).status;
  }, D);
  ok('the server refuses without the right email', refused === 400, String(refused));
  await a.click('#confirmOk');
  await a.waitForSelector('#toast:has-text("Account deleted")', { timeout: 20000 }).then(() => ok('deleted: "Account deleted"', true), async () => ok('deleted: "Account deleted"', false, await a.textContent('#accountError')));
  await sleep(300);
  ok('it’s gone from the list', !(await a.textContent('#accountsTable')).includes(D) && !(await a.evaluate(() => document.querySelector('#accountDialog').open)));
  ok('the Google Play subscription was cancelled first', (await (await fetch(`${MOCK}/__get?token=${encodeURIComponent(token)}`)).json()).lineItems[0].autoRenewingPlan.autoRenewEnabled === false);
  ok('the owner is emailed', new RegExp(`to ${D.replace(/[.+]/g, '\\$&')}: security deleted-by-support .*\\+cancelled`).test(log()));
  await a.click('[data-tab=audit]'); await a.waitForSelector('#auditTable tbody tr td:not(.ad-empty)');
  const auditText = await a.textContent('#auditTable');
  ok('the audit log records who, what and why', auditText.includes('Deleted account') && auditText.includes(D) && auditText.includes('Asked by email'));
  await u.reload(); await u.waitForSelector('#signinForm:not([hidden])', { timeout: 15000 }).then(() => ok('their open device is signed out', true), () => ok('their open device is signed out', false));
  await u.fill('#signinEmail', D); await u.fill('#signinPassword', 'pass-12345'); await u.click('#signinForm .auth-submit');
  await u.waitForFunction(() => document.querySelector('#signinForm .auth-error').textContent, null, { timeout: 15000 });
  ok('it can’t sign in any more', (await u.textContent('#signinForm .auth-error')).length > 0);
  const owner = await a.evaluate(async () => { const r = await fetch('/.netlify/functions/admin-api?view=accounts'); const d = await r.json(); return d.accounts.find(x => x.originalData); });
  if (owner) {
    await a.click('[data-tab=accounts]'); await a.fill('#accountSearch', owner.email); await a.click('#accountsTable tbody tr button'); await a.waitForSelector('#accountDialog[open]');
    ok('the original-data account can’t be deleted here', await a.isHidden('#deleteAccountBtn'));
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
