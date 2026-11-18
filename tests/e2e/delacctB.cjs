// Delete account: password check, Stripe cancelled, everything erased, other devices out, owner protected.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';

const WHSEC = 'whsec_local_test_only';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'leaver' + Date.now() + '@example.com';
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const stripe = async (method, path, params) => {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && body ? '?' + body : ''}`, { method, headers: { Authorization: 'Bearer proxy-injected', 'Stripe-Version': '2026-04-22.dahlia', ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, body: method === 'GET' ? undefined : body });
  return r.json();
};
const deliver = async event => {
  const payload = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
  return fetch(BASE + '/.netlify/functions/stripe-webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload });
};
async function signUp(page, email) {
  await page.goto(BASE); await page.click('.auth-create'); await page.fill('#codeEmail', email); await page.click('#emailForm .auth-submit');
  await page.waitForSelector('#codeForm:not([hidden])'); await page.fill('#codeInput', lastCode(email)); await page.click('#codeForm .auth-submit');
  await page.waitForSelector('#passwordForm:not([hidden])'); await page.fill('#newPassword', 'pass-12345'); await page.click('#passwordForm .auth-submit');
  await page.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await page.check('#recoverySaved'); await page.click('#recoveryKeyForm .auth-submit');
  await page.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
}

(async () => {
  const { getStore } = await import(REPO + '/node_modules/@netlify/blobs/dist/main.js');
  const store = name => getStore({ name, siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
  const auth = store('scratchpad-auth');
  const ek = crypto.createHash('sha256').update(EMAIL).digest('hex').slice(0, 32);
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await signUp(p, EMAIL);
  const ns = (await auth.get(`users/${ek}`, { type: 'json' })).ns;

  // Make it a paying Pro account (real Stripe sandbox subscription)
  const cust = await stripe('POST', 'customers', { email: EMAIL, 'metadata[ek]': ek });
  await auth.set(`stripe-customers/${cust.id}`, ek);
  const u0 = await auth.get(`users/${ek}`, { type: 'json' }); await auth.setJSON(`users/${ek}`, { ...u0, stripe: { customer: cust.id } });
  const pm = await stripe('POST', 'payment_methods/pm_card_visa/attach', { customer: cust.id });
  await stripe('POST', `customers/${cust.id}`, { 'invoice_settings[default_payment_method]': pm.id });
  const monthly = (await stripe('GET', 'prices', { 'lookup_keys[]': 'scrapsheet_pro_month' })).data[0];
  const sub = await stripe('POST', 'subscriptions', { customer: cust.id, 'items[0][price]': monthly.id, 'metadata[ek]': ek });
  await deliver({ type: 'customer.subscription.created', data: { object: { id: sub.id } } });
  ok('test account is paying Pro', (await auth.get(`users/${ek}`, { type: 'json' })).plan === 'pro' && sub.status === 'active');
  await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);

  // Some data: text, a file, a share link
  await p.click('#scratchpad'); await p.keyboard.type('Private notes');
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  await p.setInputFiles('#fileInput', [{ name: 'doc.txt', mimeType: 'text/plain', buffer: Buffer.from('secret file') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  await p.click('#fileList .file-row [data-file-menu]'); await p.click('.menu-item:has-text("Share link")'); await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
  const shareUrl = await p.inputValue('#shareUrlInput'); await p.keyboard.press('Escape');
  const token = shareUrl.split('/s/')[1].split('#')[0];
  const before = (await store(`u-${ns}`).list()).blobs.length + (await store(`u-${ns}-files-1`).list()).blobs.length + (await store(`u-${ns}-chunks-1`).list()).blobs.length;
  ok('account has data stored', before > 3, String(before));

  // A second device, signed in
  const q = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); q.on('pageerror', e => errs.push('dev2: ' + e.message));
  await q.goto(BASE); await q.fill('#signinEmail', EMAIL); await q.fill('#signinPassword', 'pass-12345'); await q.click('#signinForm .auth-submit');
  await q.waitForSelector('.app-shell', { state: 'visible' });

  // The menu item and the box
  await p.click('#accountBtn'); await p.click('[data-pf="security"]'); await sleep(200);
  ok('Account & security has Delete account…', (await p.textContent('#profilePanel')).includes('Delete account…'));
  await p.click('[data-pf="delete"]'); await p.waitForSelector('#deleteAccountModal:not([hidden])');
  ok('box names the account and the Pro cancellation', (await p.textContent('#deleteAccountEmail')) === EMAIL && await p.isVisible('#deleteAccountPro'));
  await p.screenshot({ path: OUT + 'del-modal.png' });
  await p.keyboard.press('Escape'); await sleep(150);
  ok('Escape closes it, nothing deleted', await p.isHidden('#deleteAccountModal') && Boolean(await auth.get(`users/${ek}`)));
  await p.click('#accountBtn'); await p.click('[data-pf="security"]'); await p.click('[data-pf="delete"]'); await p.waitForSelector('#deleteAccountModal:not([hidden])');
  await p.click('#deleteAccountForm [type=submit]');
  ok('empty password: asks for it', (await p.textContent('#deleteAccountError')) === 'Enter your password.');
  await p.fill('#deleteAccountPassword', 'wrong-pass-9'); await p.click('#deleteAccountForm [type=submit]');
  await p.waitForFunction(() => document.querySelector('#deleteAccountError').textContent.length > 0 && !document.querySelector('#deleteAccountForm [type=submit]').disabled, null, { timeout: 15000 });
  ok('wrong password: refused, nothing deleted, still signed in', (await p.textContent('#deleteAccountError')).includes('isn’t right') && Boolean(await auth.get(`users/${ek}`)) && await p.isVisible('.app-shell'));
  await p.fill('#deleteAccountPassword', 'pass-12345'); await p.click('#deleteAccountForm [type=submit]');
  await p.waitForSelector('text=Your account was deleted.', { timeout: 20000 });
  ok('right password: account deleted', true);
  await p.screenshot({ path: OUT + 'del-done.png' });
  await p.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 });
  ok('back on the sign-in page', true);

  // What's left
  ok('account record gone', !(await auth.get(`users/${ek}`)) && !(await auth.get(`stripe-customers/${cust.id}`)));
  const after = (await store(`u-${ns}`).list()).blobs.length + (await store(`u-${ns}-files-1`).list()).blobs.length + (await store(`u-${ns}-chunks-1`).list()).blobs.length;
  ok('sheets, files and chunks erased', after === 0, String(after));
  ok('share link erased', !(await store('scratchpad-shares').get(`shares/${token}`)));
  const g = await (await b.newContext()).newPage(); await g.goto(shareUrl); await g.waitForSelector('.share-title');
  ok('share link no longer opens', /doesn’t work/.test(await g.textContent('.share-title')), await g.textContent('.share-title'));
  const s2 = await stripe('GET', `subscriptions/${sub.id}`);
  ok('Stripe subscription cancelled', s2.status === 'canceled', s2.status);
  ok('device keys forgotten', (await p.evaluate(() => new Promise(r => { const req = indexedDB.open('scratchpad-keys'); req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains('keys')) return r(0); const t = db.transaction('keys').objectStore('keys').count(); t.onsuccess = () => r(t.result); }; req.onerror = () => r(-1); }))) === 0);
  await q.reload(); await q.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 }).then(() => ok('other device signed out', true), () => ok('other device signed out', false));
  await q.fill('#signinEmail', EMAIL); await q.fill('#signinPassword', 'pass-12345'); await q.click('#signinForm .auth-submit');
  await q.waitForFunction(() => document.querySelector('#signinForm .auth-error').textContent, null, { timeout: 15000 });
  ok('old password no longer signs in', (await q.textContent('#signinForm .auth-error')).includes('Wrong'));
  const fresh = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await signUp(fresh, EMAIL);
  ok('same email can sign up again, empty and Free', (await fresh.textContent('#scratchpad')).trim() === '' && (await auth.get(`users/${ek}`, { type: 'json' })).plan === 'free');

  // No account is special: the OWNER_EMAIL address gets an ordinary Free account that can be deleted.
  const OWNER = 'owner@example.com';
  const o = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await signUp(o, OWNER);
  const ou = await auth.get(`users/${crypto.createHash('sha256').update(OWNER).digest('hex').slice(0, 32)}`, { type: 'json' });
  ok('OWNER_EMAIL gets an ordinary Free account (no original-data claim)', ou.plan === 'free' && ou.ns !== '');
  await o.click('#accountBtn'); await sleep(200);
  const mainMenu = await o.textContent('#profilePanel'); await o.click('[data-pf="security"]');
  const menu = mainMenu + await o.textContent('#profilePanel');
  ok('menu has Delete account and no Admin item', menu.includes('Delete account') && !/Admin/.test(menu));
  await o.keyboard.press('Escape');
  const st = await o.evaluate(() => fetch('/.netlify/functions/admin').then(r => r.status));
  ok('old admin endpoint is gone', st === 404 || st === 500, String(st));
  const me = await o.evaluate(() => fetch('/.netlify/functions/auth').then(r => r.json()));
  ok('signed-in data has no admin flag', !('admin' in me));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
