// Instant open: the kept encrypted copy is drawn before any request, read-only
// until the server is checked; newer changes come in; sign-out clears it.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'instant' + Date.now() + '@example.com';
const SECRET = 'Quarterly plan: ship the Android app';

async function signUp(page, email) {
  await page.goto(BASE); await page.click('.auth-create'); await page.fill('#codeEmail', email); await page.click('#emailForm .auth-submit');
  await page.waitForSelector('#codeForm:not([hidden])'); await page.fill('#codeInput', lastCode(email)); await page.click('#codeForm .auth-submit');
  await page.waitForSelector('#passwordForm:not([hidden])'); await page.fill('#newPassword', 'pass-12345'); await page.click('#passwordForm .auth-submit');
  await page.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await page.check('#recoverySaved'); await page.click('#recoveryKeyForm .auth-submit');
  await page.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
}
// Holds every API request back, to see what shows before the server answers.
const slowApi = async (page, ms) => page.route(/\/(\.netlify\/functions|api)\//, async route => { await sleep(ms); route.continue().catch(() => {}); });
const readKept = page => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('scratchpad-keys');
  req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains('keys')) return resolve(null); const g = db.transaction('keys').objectStore('keys').get('snapshot'); g.onsuccess = () => resolve(g.result || null); g.onerror = () => resolve(null); };
  req.onerror = () => resolve(null);
}));

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await signUp(p, E);

  // Sheet 1: a file. "Travel" (sheet 2): text. Leave Travel open.
  await p.setInputFiles('#fileInput', [{ name: 'itinerary.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3000, 2) }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  await p.locator('.sheet-tab[data-sheet="2"]').click(); await sleep(500);
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); await p.fill('#renameInput', 'Travel'); await p.click('#renameForm button[type=submit]'); await sleep(500);
  await p.click('#scratchpad'); await p.keyboard.type(SECRET);
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  await p.setInputFiles('#fileInput', [{ name: 'boarding.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2000, 3) }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  await sleep(2500); // the copy is kept a moment after changes

  const kept = await readKept(p);
  ok('a copy is kept on the device', Boolean(kept?.data));
  ok('…encrypted: no text, names or file names readable', kept && !JSON.stringify(kept).includes('Quarterly') && !JSON.stringify(kept).includes('Travel') && !JSON.stringify(kept).includes('boarding'));

  // ---- Reopen with the server slow: everything is there at once ----
  await p.close();
  const q = await ctx.newPage(); q.on('pageerror', e => errs.push('reopen: ' + e.message));
  await slowApi(q, 3000);
  const t0 = Date.now();
  await q.goto(BASE, { waitUntil: 'domcontentloaded' });
  await q.waitForFunction(t => document.querySelector('#scratchpad')?.textContent.includes(t), SECRET, { timeout: 2500 });
  const shownAfter = Date.now() - t0;
  ok('the sheet’s text shows before the server answers', shownAfter < 2500, `${shownAfter} ms (server held for 3000 ms)`);
  ok('tabs show with their names, the kept sheet open', (await q.textContent('.sheet-tab.active')).includes('Travel') && (await q.$$('.sheet-tab')).length >= 5);
  ok('its files show', (await q.textContent('#fileList')).includes('boarding.pdf'));
  ok('no "No files" or sign-in flash', await q.isHidden('#emptyFiles') && await q.isHidden('#authScreen'));
  ok('read-only until checked', (await q.getAttribute('#scratchpad', 'contenteditable')) === 'false');
  ok('the account button and plan are there', (await q.textContent('#avatar')).trim() === E[0].toUpperCase());
  await q.screenshot({ path: OUT + 'io-instant.png' });
  await q.waitForFunction(() => document.querySelector('#scratchpad').getAttribute('contenteditable') === 'true', null, { timeout: 15000 });
  ok('editable once the server is checked', true);
  await q.waitForSelector('#status[data-state="live"]', { timeout: 10000 }).then(() => ok('dot goes green after the check', true), () => ok('dot goes green after the check', false));
  ok('text unchanged (no flash)', (await q.textContent('#scratchpad')).includes(SECRET));
  await q.unroute(/\/(\.netlify\/functions|api)\//);

  // ---- Another device changed it: the old copy shows, then the new text replaces it ----
  const other = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await other.goto(BASE); await other.fill('#signinEmail', E); await other.fill('#signinPassword', 'pass-12345'); await other.click('#signinForm .auth-submit');
  await other.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await other.locator('.sheet-tab:has-text("Travel")').click(); await sleep(800);
  await other.click('#scratchpad'); await other.keyboard.press('End'); await other.keyboard.type(' (updated elsewhere)');
  await other.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  await q.close();
  const r = await ctx.newPage(); r.on('pageerror', e => errs.push('newer: ' + e.message));
  await slowApi(r, 1500);
  await r.goto(BASE, { waitUntil: 'domcontentloaded' });
  await r.waitForFunction(t => document.querySelector('#scratchpad')?.textContent.includes(t), SECRET, { timeout: 2500 });
  ok('kept copy first', !(await r.textContent('#scratchpad')).includes('updated elsewhere'));
  await r.waitForFunction(() => document.querySelector('#scratchpad').textContent.includes('updated elsewhere'), null, { timeout: 15000 })
    .then(() => ok('then the newer text from the other device', true), () => ok('then the newer text from the other device', false));
  await r.unroute(/\/(\.netlify\/functions|api)\//);
  await sleep(2500);

  // ---- Offline: the copy stays, read-only, marked Offline; then it catches up ----
  await r.close();
  const o = await ctx.newPage(); o.on('pageerror', e => errs.push('offline: ' + e.message));
  let offline = true;
  await o.route(/\/(\.netlify\/functions|api)\//, route => (offline ? route.abort('internetdisconnected') : route.continue()));
  await o.goto(BASE, { waitUntil: 'domcontentloaded' });
  await o.waitForFunction(() => document.querySelector('#scratchpad')?.textContent.includes('updated elsewhere'), null, { timeout: 3000 })
    .then(() => ok('offline: the kept copy shows', true), () => ok('offline: the kept copy shows', false));
  await sleep(1500);
  ok('offline: not signed out, marked Offline, read-only', await o.isHidden('#authScreen') && (await o.getAttribute('#status', 'data-state')) === 'offline' && (await o.getAttribute('#scratchpad', 'contenteditable')) === 'false');
  ok('offline: keys and copy kept', Boolean(await readKept(o)));
  offline = false;
  await o.waitForFunction(() => document.querySelector('#scratchpad').getAttribute('contenteditable') === 'true', null, { timeout: 20000 })
    .then(() => ok('back online: carries on by itself', true), () => ok('back online: carries on by itself', false));
  await o.close();

  // ---- Signed out from another device: the copy is drawn, then cleared, then sign-in ----
  await other.evaluate(() => fetch('/.netlify/functions/auth?action=logout-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  const s = await ctx.newPage(); s.on('pageerror', e => errs.push('signedout: ' + e.message));
  await s.goto(BASE);
  await s.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 }).then(() => ok('signed out elsewhere: ends on sign-in', true), () => ok('signed out elsewhere: ends on sign-in', false));
  ok('…with the text gone from the page', !(await s.textContent('#scratchpad')).includes('Quarterly'));
  await sleep(300);
  ok('…and the kept copy deleted', !(await readKept(s)));

  // ---- Sign out here clears it too; next open shows sign-in, never the sheet ----
  await s.fill('#signinEmail', E); await s.fill('#signinPassword', 'pass-12345'); await s.click('#signinForm .auth-submit');
  await s.waitForSelector('.app-shell', { state: 'visible' }); await sleep(3500);
  ok('signed in again: a new copy is kept', Boolean(await readKept(s)));
  await s.click('#accountBtn'); await s.click('[data-pf="security"]'); await s.click('[data-pf="signout"]');
  await s.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 });
  ok('sign out deletes the copy', !(await readKept(s)));
  const n = await ctx.newPage();
  let sawText = false;
  n.on('domcontentloaded', async () => { try { sawText = sawText || (await n.textContent('#scratchpad')).includes('Quarterly'); } catch {} });
  await n.goto(BASE); await n.waitForSelector('#signinForm:not([hidden])');
  ok('after sign-out the sheet never shows', !sawText && !(await n.textContent('#scratchpad')).includes('Quarterly'));

  // ---- First open on a new device: placeholders, not empty boxes ----
  const fresh = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await fresh.goto(BASE); await fresh.fill('#signinEmail', E); await fresh.fill('#signinPassword', 'pass-12345');
  await slowApi(fresh, 1500);
  await fresh.click('#signinForm .auth-submit');
  await fresh.waitForSelector('.app-shell', { state: 'visible', timeout: 15000 });
  await sleep(200);
  await fresh.screenshot({ path: OUT + 'io-first-open.png' });
  ok('first open: placeholders while loading, no "No files" message', await fresh.isHidden('#emptyFiles'));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
