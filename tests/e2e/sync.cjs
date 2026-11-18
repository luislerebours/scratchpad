const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async () => { const p = await (await b.newContext({ viewport:{ width:390, height:844 } })).newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept()); return p; };
  const A = await page();
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', 'sync@example.com'); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode('sync@example.com')); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'sync-pass-123'); await A.click('#passwordForm .auth-submit'); await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state:'visible' });
  const B = await page();
  await B.goto(BASE); await B.fill('#signinEmail', 'sync@example.com'); await B.fill('#signinPassword', 'sync-pass-123'); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state:'visible' }); await sleep(2500);

  // Idle request count on B
  const seen = []; B.on('request', r => { if (r.url().includes('/.netlify/functions/')) seen.push(new URL(r.url()).search); });
  await sleep(10000);
  const kinds = seen.reduce((m, q) => (m[q.includes('meta=poll') ? 'check' : 'other: ' + q] = (m[q.includes('meta=poll') ? 'check' : 'other: ' + q] || 0) + 1, m), {});
  console.log('1. idle for 10 s, requests from B:', JSON.stringify(kinds));

  // Changes reach B
  const timeIt = async (label, act, cond) => { const t = Date.now(); await act(); await B.waitForFunction(cond, null, { timeout: 15000 }); console.log(`   ${label}: on B after ${((Date.now() - t) / 1000).toFixed(1)} s`); };
  console.log('2. changes from A reach B:');
  await timeIt('typed text', async () => { await A.click('#scratchpad'); await A.keyboard.type('hello from A'); }, () => document.querySelector('#scratchpad').innerText.includes('hello from A'));
  await timeIt('uploaded file', () => A.setInputFiles('#fileInput', { name:'a.txt', mimeType:'text/plain', buffer: Buffer.from('x') }), () => document.querySelectorAll('#fileList .file-row').length === 1);
  await timeIt('new sheet tab', async () => { await A.click('#addSheetBtn'); await A.fill('#renameInput', 'Synced'); await A.click('#renameForm button[type="submit"]'); }, () => [...document.querySelectorAll('.sheet-tab')].some(t => t.textContent === 'Synced'));
  await B.click('.sheet-tab[data-sheet="1"]'); await sleep(500);
  await timeIt('deleted file', async () => { await A.click('.sheet-tab[data-sheet="1"]'); await sleep(600); await A.click('#fileList [data-file-menu]'); await A.click('.menu-item:has-text("Delete file")'); await A.click('#sheetActions button:has-text("Delete file")'); }, () => document.querySelectorAll('#fileList .file-row').length === 0);

  // Own saves don't trigger a fetch-back
  seen.length = 0; await A.click('#scratchpad'); await A.keyboard.type(' more'); await sleep(5000);
  const aSeen = []; // count on A
  A.on('request', r => { if (r.url().includes('/.netlify/functions/')) aSeen.push(new URL(r.url()).search); });
  await A.keyboard.type('!'); await sleep(5000);
  console.log('3. A after typing (10 s): text fetched back', aSeen.filter(q => /^\?sheet=\d+$/.test(q)).length, 'times |', aSeen.filter(q => q.includes('meta=poll')).length, 'checks');

  // Hidden: no requests
  seen.length = 0;
  await B.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable:true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(8000);
  console.log('4. B hidden for 8 s, requests:', seen.length);
  await A.click('#scratchpad'); await A.keyboard.type(' while hidden'); await sleep(2500);
  seen.length = 0;
  await B.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable:true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('while hidden'), null, { timeout: 5000 });
  console.log('   back on screen: caught up right away, requests:', seen.length);
  console.log('errors:', errs); await b.close();
})();
