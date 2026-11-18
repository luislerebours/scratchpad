// Offline = view only: no edits without the server; blips don't lock; words
// typed just before a drop are saved on return; other devices' changes come in.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'offline' + Date.now() + '@example.com';
const API = /\/(\.netlify\/functions|api)\//;

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await p.click('#scratchpad'); await p.keyboard.type('Packing list');
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  await p.setInputFiles('#fileInput', [{ name: 'tickets.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2000, 1) }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  await p.waitForSelector('#status[data-state="live"]', { timeout: 10000 });
  const editable = () => p.getAttribute('#scratchpad', 'contenteditable');
  const toast = () => p.textContent('#toast');

  // ---- The device goes offline: view only at once ----
  await ctx.setOffline(true); await sleep(300);
  ok('offline: the text can’t be edited', (await editable()) === 'false');
  ok('offline: says "Offline · view only"', (await p.textContent('#status .conn-label')).trim() === 'Offline · view only' && await p.isVisible('#status .conn-label'));
  ok('offline: notes still readable at full strength', (await p.textContent('#scratchpad')).includes('Packing list') && (await p.$eval('#scratchpad', el => getComputedStyle(el).opacity)) === '1');
  const shown = () => p.evaluate(() => document.querySelector('#toast').classList.contains('show'));
  ok('going offline: the notice shows once', (await toast()) === 'You’re offline. Reconnect to edit.' && await shown());
  await sleep(3000);
  ok('…then fades out', !(await shown()));
  await p.dispatchEvent('#scratchpad', 'pointerdown'); await sleep(300);
  ok('scrolling or touching to read doesn’t bring it back', !(await shown()));
  await p.keyboard.type('Q'); await sleep(200);
  ok('trying to type brings it back', await shown() && (await toast()) === 'You’re offline. Reconnect to edit.');
  await sleep(3000);
  await p.tap('#scratchpad'); await sleep(200);
  ok('tapping the text to type explains why', (await toast()).includes('You’re offline. Reconnect to edit.'));
  await p.keyboard.type('XYZ'); await sleep(200);
  ok('typing does nothing', !(await p.textContent('#scratchpad')).includes('XYZ'));
  let chooser = false; p.once('filechooser', () => { chooser = true; });
  await p.evaluate(() => document.querySelector('#toast').textContent = '');
  await p.tap('#uploadBtn'); await sleep(300);
  ok('upload: no file picker, explains', !chooser && (await toast()).includes('You’re offline. Reconnect to edit.'));
  const tabs = (await p.$$('.sheet-tab')).length;
  await p.evaluate(() => document.querySelector('#toast').textContent = '');
  await p.tap('#addSheetBtn'); await sleep(300);
  ok('new sheet blocked', (await p.$$('.sheet-tab')).length === tabs && (await toast()).includes('You’re offline. Reconnect to edit.'));
  await p.evaluate(() => document.querySelector('#toast').textContent = '');
  await p.tap('#fileList .file-row [data-file-menu]'); await p.tap('.menu-item:has-text("Delete file")'); await sleep(300);
  ok('delete file blocked (no confirm sheet)', await p.isHidden('#sheetModal') && (await toast()).includes('You’re offline. Reconnect to edit.'));
  await p.evaluate(() => document.querySelector('#toast').textContent = '');
  await p.tap('#sheetMenuBtn'); await p.tap('.menu-item:has-text("Rename sheet")'); await sleep(300);
  ok('rename blocked', await p.isHidden('#renameModal'));
  await p.tap('#searchBtn'); await p.fill('#searchInput', 'packing'); await sleep(300);
  ok('search still works', (await p.textContent('#searchResults')).toLowerCase().includes('packing'));
  await p.keyboard.press('Escape');
  await p.screenshot({ path: OUT + 'ov-offline.png' });

  // ---- Back online: editable again by itself ----
  await ctx.setOffline(false);
  await p.waitForFunction(() => document.querySelector('#scratchpad').getAttribute('contenteditable') === 'true', null, { timeout: 15000 })
    .then(() => ok('back online: editable again by itself', true), () => ok('back online: editable again by itself', false));
  ok('…and the label is gone', (await p.getAttribute('#status', 'data-state')) === 'live' && !(await p.evaluate(() => document.body.classList.contains('view-only'))));

  // ---- A blip (server unreachable ~1 s) doesn't lock anything ----
  await p.route(API, r => r.abort('internetdisconnected'));
  await p.evaluate(() => fetch('/api/check?sheet=1').catch(() => {})); // fails → marked offline
  await sleep(1000);
  await p.unroute(API);
  await sleep(3500);
  ok('a short blip never switches to view only', (await editable()) === 'true' && !(await p.evaluate(() => document.body.classList.contains('view-only'))));

  // ---- Typing as the server becomes unreachable: words kept, saved on return ----
  await p.click('#scratchpad'); await p.keyboard.press('End');
  await p.route(API, r => r.abort('internetdisconnected'));
  await p.keyboard.type(' + charger');
  await p.waitForFunction(() => document.body.classList.contains('view-only'), null, { timeout: 15000 })
    .then(() => ok('unreachable server: view only after the grace period', true), () => ok('unreachable server: view only after the grace period', false));
  ok('the words typed just before stay on screen', (await p.textContent('#scratchpad')).includes('Packing list + charger'));
  await p.unroute(API);
  await p.waitForFunction(() => document.querySelector('#scratchpad').getAttribute('contenteditable') === 'true', null, { timeout: 20000 });
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 15000 });
  const other = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await other.goto(BASE); await other.fill('#signinEmail', E); await other.fill('#signinPassword', 'pass-12345'); await other.click('#signinForm .auth-submit');
  await other.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…and are saved once back (seen on another device)', (await other.textContent('#scratchpad')).includes('Packing list + charger'));

  // ---- Changes made elsewhere while this device was offline come in on return ----
  await ctx.setOffline(true); await sleep(300);
  await other.click('#scratchpad'); await other.keyboard.press('End'); await other.keyboard.type(' + passport');
  await other.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  ok('while offline, this device still shows the older text', !(await p.textContent('#scratchpad')).includes('passport'));
  await ctx.setOffline(false);
  await p.waitForFunction(() => document.querySelector('#scratchpad').textContent.includes('passport'), null, { timeout: 20000 })
    .then(() => ok('back online: the other device’s change appears', true), () => ok('back online: the other device’s change appears', false));
  ok('nothing was overwritten', (await other.textContent('#scratchpad')).includes('passport'));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
