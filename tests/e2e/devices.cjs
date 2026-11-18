// Signed-in devices: each sign-in is listed with its kind of device and last
// use; one can be signed out on its own; a cookie from before ids keeps working
// and gets listed; signing out, signing out everywhere and a password change
// keep the list right.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'devices' + Date.now() + '@example.com'; const PASS = 'pass-12345';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const { emailKey, authStore, sign } = await import(REPO + '/netlify/lib/auth.mjs');
  const b = await chromium.launch(); const errs = [];
  const page = async (opts = {}) => { const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts })).newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const signIn = async (p, pass = PASS) => { await p.goto(BASE); await p.fill('#signinEmail', E); await p.fill('#signinPassword', pass); await p.click('#signinForm .auth-submit'); await p.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(1500); };
  const sessionsOf = async () => (await authStore().get(`users/${emailKey(E)}`, { type: 'json' })).sessions || [];

  const A = await page({ userAgent: WINDOWS });
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', PASS); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('signing up lists this device', (await sessionsOf()).length === 1 && (await sessionsOf())[0].device === 'Chrome on Windows');

  const P = await page({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await signIn(P);
  ok('signing in on a phone adds it', (await sessionsOf()).map(s => s.device).sort().join() === 'Chrome on Windows,Safari on iPhone');

  // A device signed in before there were ids: its cookie has none.
  const user = await authStore().get(`users/${emailKey(E)}`, { type: 'json' });
  const now = Date.now();
  const oldToken = await sign({ t: 's', ek: emailKey(E), v: user.version, iat: now, exp: now + 86400000 });
  const O = await page({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' });
  await O.context().addCookies([{ name: 'sp_session', value: oldToken, url: BASE }]);
  // Its keys stay on that device; here we unlock with the password.
  await O.goto(BASE); await sleep(2500);
  if (await O.isVisible('#unlockForm:not([hidden])')) { await O.fill('#unlockPassword', PASS); await O.click('#unlockForm .auth-submit'); }
  await O.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }).catch(() => {});
  await sleep(1500);
  ok('a cookie from before ids still works, and the device gets listed', await O.isVisible('.app-shell') && (await sessionsOf()).some(s => s.device === 'Safari on Mac'), (await sessionsOf()).map(s => s.device).join());

  // ---- The list ----
  await A.click('#accountBtn'); await A.click('[data-pf="security"]');
  ok('Account & security has “Signed-in devices…”', await A.isVisible('[data-pf="devices"]'));
  await A.click('[data-pf="devices"]'); await A.waitForSelector('#devicesModal:not([hidden]) .device-row');
  const listed = await A.$$eval('#devicesModal .device-row', rows => rows.map(r => r.innerText.replace(/\s+/g, ' ')));
  ok('it lists all three, this one marked “This device”', listed.length === 3 && listed.filter(t => t.includes('This device')).length >= 1 && listed.some(t => t.startsWith('Chrome on Windows') && t.includes('This device')), listed.join(' | '));
  ok('…the others with when they were last active and a Sign out button', (await A.$$('#devicesModal [data-signout-device]')).length === 2 && listed.some(t => t.includes('Active now')));
  await A.screenshot({ path: OUT + 'devices.png' });

  // ---- Sign one out ----
  await A.click('#devicesModal .device-row:has-text("Safari on iPhone") [data-signout-device]');
  await A.waitForFunction(() => document.querySelectorAll('#devicesModal .device-row').length === 2, null, { timeout: 10000 })
    .then(() => ok('signing one out takes it off the list', true), () => ok('signing one out takes it off the list', false));
  await P.waitForSelector('#authScreen:not([hidden])', { timeout: 15000 })
    .then(() => ok('…and that phone is signed out right away', true), () => ok('…and that phone is signed out right away', false));
  ok('…while the others stay signed in', await A.isVisible('.app-shell') && await O.isVisible('.app-shell'));
  const check = await P.evaluate(async () => (await fetch('/api/check?sheet=1')).status);
  ok('…its old cookie is refused by the quick check too', check === 401, String(check));
  await A.keyboard.press('Escape');

  // ---- Sign out on a device removes it ----
  await signIn(P);
  ok('signing back in lists it again', (await sessionsOf()).length === 3);
  await P.click('#accountBtn'); await P.click('[data-pf="security"]'); await P.click('[data-pf="signout"]');
  await P.waitForSelector('#authScreen:not([hidden])', { timeout: 15000 }); await sleep(800);
  ok('Sign out on that device removes its entry', (await sessionsOf()).length === 2 && !(await sessionsOf()).some(s => s.device === 'Safari on iPhone'));

  // ---- Change password: only this device left ----
  await A.click('#accountBtn'); await A.click('[data-pf="security"]'); await A.click('[data-pf="password"]');
  await A.fill('#currentPassword', PASS); await A.fill('#changedPassword', 'second-pass-456'); await A.fill('#changedPasswordAgain', 'second-pass-456');
  await A.click('#passwordChangeForm [type=submit]'); await A.waitForSelector('#passwordModal', { state: 'hidden', timeout: 30000 }); await sleep(1500);
  ok('after a password change only this device is listed', (await sessionsOf()).length === 1 && (await sessionsOf())[0].device === 'Chrome on Windows');
  ok('…and it is still signed in', await A.isVisible('.app-shell') && (await A.evaluate(async () => (await fetch('/.netlify/functions/auth?action=devices')).status)) === 200);

  // ---- Sign out everywhere clears it ----
  await signIn(P, 'second-pass-456');
  await A.click('#accountBtn'); await A.click('[data-pf="security"]'); await A.click('[data-pf="signout-all"]'); await A.click('#sheetActions button:has-text("Sign out everywhere")');
  await A.waitForSelector('#authScreen:not([hidden])', { timeout: 15000 }); await sleep(800);
  ok('Sign out everywhere empties the list', (await sessionsOf()).length === 0);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
