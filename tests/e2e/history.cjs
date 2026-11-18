// Version history and Undo after Clear: earlier text is kept (encrypted),
// listed, previewed and restored; restoring and clearing can be undone; other
// devices follow; versions count toward storage, keep their images, and go
// when the sheet is deleted for good.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'history' + Date.now() + '@example.com';
const FIRST = 'Grocery list\nMilk, eggs, bread, coffee beans, olive oil and lemons';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const { userStore, emailKey, authStore } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/auth.mjs').href);
  const b = await chromium.launch(); const errs = [];
  const A = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); A.on('pageerror', e => errs.push(e.message));
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  const ns = (await authStore().get(`users/${emailKey(E)}`, { type: 'json' })).ns;
  const state = userStore(ns, 'state');
  const synced = p => p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  const text = p => p.evaluate(() => document.querySelector('#scratchpad').innerText);
  const versionsOf = sheet => A.evaluate(async s => (await (await fetch(`/.netlify/functions/state?sheet=${s}&meta=versions`)).json()).versions, sheet);
  const usage = () => A.evaluate(async () => (await (await fetch('/.netlify/functions/state?meta=usage')).json()));

  await A.click('#scratchpad'); await A.keyboard.type(FIRST); await synced(A);
  // A pasted image too (versions keep their images).
  await A.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 60; c.height = 40; c.getContext('2d').fillRect(0, 0, 60, 40);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const range = document.createRange(); range.selectNodeContents(pad); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range);
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'dot.png', { type: 'image/png' }));
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await A.waitForFunction(() => document.querySelector('#scratchpad img'), null, { timeout: 15000 }); await sleep(3000); await synced(A);

  // A second device.
  const B = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); B.on('pageerror', e => errs.push('B ' + e.message));
  await B.goto(BASE); await B.fill('#signinEmail', E); await B.fill('#signinPassword', 'pass-12345'); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);

  // ---- Clear, then Undo ----
  await A.click('#sheetMenuBtn'); await A.click('.menu-item:has-text("Clear sheet text")'); await A.click('#sheetActions button:has-text("Clear text")');
  await sleep(300);
  ok('clearing offers Undo', (await A.innerText('#toast')).includes('Undo'), await A.innerText('#toast'));
  await synced(A);
  const vAfterClear = await versionsOf(1);
  ok('the cleared text was kept as a version', vAfterClear.length >= 1, JSON.stringify(vAfterClear));
  const stored = await state.get(`versions/1/${vAfterClear[0].at}`, { type: 'json' });
  ok('…locked, like the sheet itself', String(stored?.html || '').startsWith('e1:') && !JSON.stringify(stored).includes('Grocery'));
  const vindex = await state.get('vindex/1', { type: 'json' });
  ok('…and its image is listed, so it isn’t cleared away', (vindex?.[0]?.images || []).length === 1);
  ok('versions count toward storage', (await usage()).bytes > 0, JSON.stringify(await usage()));
  await A.click('#toast .toast-action');
  await synced(A); await sleep(500);
  ok('Undo brings the text and image back', (await text(A)).includes('olive oil') && await A.$('#scratchpad img') !== null);
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('olive oil'), null, { timeout: 10000 })
    .then(() => ok('…on the other device too', true), () => ok('…on the other device too', false));

  // ---- Replacing most of the text keeps a version ----
  const before = (await versionsOf(1)).length;
  await A.click('#scratchpad'); await A.keyboard.press('Control+A'); await A.keyboard.type('Just one line now');
  await synced(A);
  ok('replacing most of the text keeps a version', (await versionsOf(1)).length > before, `${before} → ${(await versionsOf(1)).length}`);

  // ---- Version history: list, preview, restore, undo ----
  await A.click('#sheetMenuBtn'); await A.click('.menu-item:has-text("Version history")');
  await A.waitForSelector('#historyModal:not([hidden]) .history-row');
  const rows = await A.$$('#historyModal .history-row');
  ok('Version history lists the earlier versions', rows.length >= 2, `${rows.length} versions`);
  await A.click('#historyModal .history-row >> nth=0 >> [data-history-show]');
  await A.waitForSelector('#historyModal .history-preview');
  const preview = await A.textContent('#historyModal .history-preview');
  ok('Show previews a version (unlocked on the device), with its line breaks and images', preview.includes('Grocery list\nMilk') && preview.includes('1 image'), JSON.stringify(preview.slice(0, 80)));
  await A.screenshot({ path: OUT + 'version-history.png' });
  await A.click('#historyModal .history-actions button');
  await A.waitForSelector('#historyModal', { state: 'hidden' });
  await synced(A); await sleep(500);
  ok('Restore puts that version back', (await text(A)).includes('olive oil') && !(await text(A)).includes('Just one line now'));
  ok('…with Undo offered', (await A.innerText('#toast')).includes('Undo'));
  await A.click('#toast .toast-action'); await synced(A); await sleep(400);
  ok('Undo after restoring goes back to the text from just before', (await text(A)).includes('Just one line now'));
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Just one line now'), null, { timeout: 10000 })
    .then(() => ok('the other device follows', true), () => ok('the other device follows', false));

  // ---- Typing normally doesn't pile up versions ----
  const n0 = (await versionsOf(1)).length;
  await A.click('#scratchpad'); await A.keyboard.press('End');
  for (const w of ['and', 'a', 'few', 'more', 'words']) { await A.keyboard.type(' ' + w); await sleep(1800); }
  await synced(A);
  ok('ordinary typing keeps at most one version per 10 minutes', (await versionsOf(1)).length - n0 <= 1, `${n0} → ${(await versionsOf(1)).length}`);

  // ---- An empty history ----
  await A.click('.sheet-tab >> nth=1'); await sleep(800);
  await A.click('#sheetMenuBtn'); await A.click('.menu-item:has-text("Version history")');
  await A.waitForSelector('#historyModal:not([hidden]) .trash-empty');
  ok('a sheet with no history says so', (await A.textContent('#historyBody')).includes('No earlier versions yet'));
  await A.keyboard.press('Escape');

  // ---- Deleting the sheet for good clears its versions ----
  await A.click('.sheet-tab >> nth=0'); await sleep(800);
  await A.click('#sheetMenuBtn'); await A.click('.menu-item:has-text("Delete sheet")'); await A.click('#sheetActions button:has-text("Delete")');
  await sleep(1500);
  const del = await A.evaluate(async () => (await fetch('/.netlify/functions/state?meta=trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-sheet', sheet: 1 }) })).status);
  const left = (await state.list({ prefix: 'versions/1/' })).blobs.length + ((await state.get('vindex/1', { type: 'json' })) ? 1 : 0);
  ok('deleting the sheet for good clears its versions', del === 200 && left === 0, `${del}, ${left} left`);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
