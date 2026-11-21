// Your name in the account menu: tap it to change it. Enter saves, Escape
// keeps the old one, an empty box goes back to the name made from the email.
// The name is cleaned on the server, shows on the avatar, survives a reload,
// and reaches the other signed-in device.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'jo.smith' + Date.now() + '@example.com'; const PASS = 'pass-12345';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const { emailKey, authStore } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/auth.mjs').href);
  const stored = async () => (await authStore().get(`users/${emailKey(E)}`, { type: 'json' })).name;
  const b = await chromium.launch(); const errs = [];
  const page = async (opts = {}) => { const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts })).newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const nameShown = p => p.$eval('#pfTitle', el => el.textContent.trim());
  const openMenu = async p => { if (await p.$eval('#profileModal', el => el.hidden)) await p.click('#accountBtn'); await p.waitForSelector('#profileModal:not([hidden]) .pf-head'); };
  const closeMenu = async p => { await p.keyboard.press('Escape'); await p.waitForSelector('#profileModal', { state: 'hidden' }); };

  const A = await page();
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', PASS); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);

  // A second device, signed in too.
  const B = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await B.goto(BASE); await B.fill('#signinEmail', E); await B.fill('#signinPassword', PASS); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(2000);

  await openMenu(A);
  ok('before: name made from the email', (await nameShown(A)) === 'Jo Smith', await nameShown(A));
  ok('the name is a button with a pencil', await A.$eval('[data-pf="rename"]', el => el.tagName === 'BUTTON' && !!el.querySelector('svg') && /change your name/i.test(el.getAttribute('aria-label'))));

  // Escape keeps the old name.
  await A.click('[data-pf="rename"]');
  await A.waitForSelector('#pfNameInput');
  ok('tapping it opens a box with focus, the old name as a hint', await A.evaluate(() => document.activeElement.id === 'pfNameInput' && document.activeElement.placeholder === 'Jo Smith'));
  await A.fill('#pfNameInput', 'Nope');
  await A.keyboard.press('Escape');
  ok('Escape keeps the old name, menu still open', (await nameShown(A)) === 'Jo Smith' && !(await A.$eval('#profileModal', el => el.hidden)));
  ok('…nothing saved', (await stored()) === undefined);

  // Enter saves; the server tidies it.
  await A.click('[data-pf="rename"]');
  await A.fill('#pfNameInput', '  Josephine ​  Smith-Lee  ');
  await A.keyboard.press('Enter');
  await A.waitForFunction(() => document.querySelector('.toast, #toast')?.textContent?.includes('Name saved'), null, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  ok('Enter saves it, tidied', (await nameShown(A)) === 'Josephine Smith-Lee', await nameShown(A));
  ok('…stored on the account', (await stored()) === 'Josephine Smith-Lee', String(await stored()));
  ok('…focus back on the name', await A.evaluate(() => document.activeElement.dataset.pf === 'rename'));
  ok('avatars show its first letter', (await A.textContent('#avatar')).trim() === 'J' && (await A.textContent('.pf-avatar')).trim() === 'J');
  await A.screenshot({ path: OUT + 'name-saved.png' });

  // The other device hears about it (relay notice, or its next check).
  let seen = '';
  for (let i = 0; i < 20 && seen !== 'Josephine Smith-Lee'; i++) {
    await sleep(500);
    await openMenu(B);
    seen = await nameShown(B);
    if (seen !== 'Josephine Smith-Lee') { await closeMenu(B); await B.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }
  }
  if (seen !== 'Josephine Smith-Lee') { await B.reload(); await B.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500); await openMenu(B); seen = await nameShown(B); ok('other device: shows the new name (after a reload)', seen === 'Josephine Smith-Lee', seen); }
  else ok('other device shows the new name without reloading', true);
  await B.screenshot({ path: OUT + 'name-phone.png' });
  await closeMenu(B);

  // Too long, with control characters: cut to 40, cleaned.
  await A.click('[data-pf="rename"]');
  await A.evaluate(() => { const i = document.querySelector('#pfNameInput'); i.removeAttribute('maxlength'); });
  const r = await A.evaluate(async () => (await fetch('/.netlify/functions/auth?action=set-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A\u0007B ' + 'x'.repeat(60) }) })).json());
  ok('server cleans and caps the name', r.name === ('AB ' + 'x'.repeat(37)) && r.name.length === 40, JSON.stringify(r));
  await A.keyboard.press('Escape');

  // Survives a reload.
  await A.reload(); await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  await openMenu(A);
  ok('survives a reload', (await nameShown(A)) === 'AB ' + 'x'.repeat(37), await nameShown(A));

  // Clearing it goes back to the name from the email (leaving the box saves too).
  await A.click('[data-pf="rename"]');
  await A.fill('#pfNameInput', '   ');
  await A.click('.pf-email');
  await sleep(1200);
  ok('an empty name goes back to the one from the email', (await nameShown(A)) === 'Jo Smith' && (await stored()) === undefined, await nameShown(A));
  ok('avatar back to the email letter', (await A.textContent('#avatar')).trim() === 'J');

  ok('no page errors', !errs.length, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
