// Share to ScrapSheet: what Android's Share menu sends (a form POST to
// /share-target) is caught by the service worker, kept on the device, offered
// for the open sheet, then locked and uploaded (files) or added (text).
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'sharein' + Date.now() + '@example.com';

// What the phone does when ScrapSheet is picked in the Share menu.
async function shareFromAnotherApp(p, { files = [], title = '', text = '', url = '' }) {
  await p.evaluate(({ title, text, url }) => {
    const f = document.createElement('form');
    f.method = 'post'; f.enctype = 'multipart/form-data'; f.action = '/share-target'; f.id = 'osShare';
    for (const [k, v] of Object.entries({ title, text, url })) { const i = document.createElement('textarea'); i.name = k; i.value = v; f.append(i); }
    const fi = document.createElement('input'); fi.type = 'file'; fi.name = 'files'; fi.multiple = true; fi.id = 'osShareFiles'; f.append(fi);
    document.body.append(f);
  }, { title, text, url });
  if (files.length) await p.setInputFiles('#osShareFiles', files);
  await Promise.all([p.waitForURL(u => u.pathname === '/', { timeout: 15000 }), p.evaluate(() => document.querySelector('#osShare').submit())]);
}

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.tap('.auth-create'); await p.fill('#codeEmail', E); await p.tap('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.tap('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.tap('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.tap('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await p.tap('#scratchpad'); await p.keyboard.type('Trip notes');
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });

  ok('the service worker is running', await p.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)));
  const manifest = await (await p.request.get(BASE + '/manifest.webmanifest')).json();
  ok('the manifest puts ScrapSheet in the Share menu (files and text)', manifest.share_target?.action === '/share-target' && manifest.share_target.method === 'POST' && manifest.share_target.params.files[0].name === 'files' && manifest.share_target.params.text === 'text');

  // ---- Share a photo, a PDF and a link ----
  const photo = crypto.randomBytes(300_000); const pdf = crypto.randomBytes(1_200_000);
  await shareFromAnotherApp(p, {
    files: [{ name: 'boarding-pass.jpg', mimeType: 'image/jpeg', buffer: photo }, { name: 'itinerary.pdf', mimeType: 'application/pdf', buffer: pdf }],
    title: 'Hotel', text: 'Check-in after 3 PM\nConfirmation 7F2K', url: 'https://example.com/booking'
  });
  await p.waitForSelector('#sheetModal:not([hidden])', { timeout: 20000 });
  ok('ScrapSheet opens and offers what was shared', (await p.textContent('#sheetTitle')) === 'Add what you shared');
  const st = await p.textContent('#sheetText');
  ok('…says what and where', st.startsWith('Adds 2 files and text to Sheet 1.') && st.includes('Check-in after 3 PM'), st);
  ok('…lists the files with sizes', /boarding-pass\.jpg\s*293 KB/.test(await p.textContent('#sheetItems')) && /itinerary\.pdf\s*1\.1 MB/.test(await p.textContent('#sheetItems')), await p.textContent('#sheetItems'));
  ok('the address is tidied (no ?shared=1 left)', new URL(p.url()).search === '');
  await p.screenshot({ path: OUT + 'share-in-phone.png' });
  await p.tap('#sheetModal button:has-text("Add to Sheet 1")');
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 })
    .then(() => ok('both files upload to the open sheet', true), () => ok('both files upload to the open sheet', false));
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  const padText = await p.$eval('#scratchpad', el => el.innerText);
  ok('the text is added after what was there, line by line', /Trip notes\s*\n+Hotel\nCheck-in after 3 PM\nConfirmation 7F2K\nhttps:\/\/example\.com\/booking/.test(padText), JSON.stringify(padText));

  // Seen from another device: the files are whole, the text saved
  const d = await (await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
  await d.goto(BASE); await d.fill('#signinEmail', E); await d.fill('#signinPassword', 'pass-12345'); await d.click('#signinForm .auth-submit');
  await d.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('another device sees the text', (await d.textContent('#scratchpad')).includes('Confirmation 7F2K'));
  const dl = d.waitForEvent('download', { timeout: 30000 });
  await d.click('#fileList .file-row:has-text("itinerary.pdf") [data-file-menu]'); await d.click('.menu-item:has-text("Download")');
  ok('…and the PDF comes back byte for byte', Buffer.compare(fs.readFileSync(await (await dl).path()), pdf) === 0);
  // Nothing readable on the server: the stored chunk isn't the PDF
  const leaked = execFileSync('bash', ['-c', `grep -rlaF -e "Confirmation 7F2K" -e "boarding-pass" -e "itinerary" blobdata 2>/dev/null | head -1 || true`]).toString().trim();
  ok('(the store was searched)', fs.existsSync('blobdata'));
  ok('nothing shared is stored unlocked on the server', leaked === '', leaked);

  // ---- Discard ----
  await shareFromAnotherApp(p, { text: 'Throw this away' });
  await p.waitForSelector('#sheetModal:not([hidden])', { timeout: 20000 });
  ok('text only: "Adds text to Sheet 1."', (await p.textContent('#sheetText')).startsWith('Adds text to Sheet 1.'));
  await p.tap('#sheetModal button:has-text("Discard")'); await sleep(500);
  ok('Discard adds nothing', !(await p.textContent('#scratchpad')).includes('Throw this away'));
  await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…and it doesn’t come back', await p.isHidden('#sheetModal'));

  // ---- Shared while signed out: kept until signed in ----
  const c2 = await b.newContext({ ...devices['Pixel 7'] });
  const q = await c2.newPage(); q.on('pageerror', e => errs.push(e.message));
  await q.goto(BASE); await q.evaluate(() => navigator.serviceWorker.ready);
  await shareFromAnotherApp(q, { files: [{ name: 'receipt.png', mimeType: 'image/png', buffer: crypto.randomBytes(5000) }] });
  await q.waitForSelector('#signinForm:not([hidden])'); await sleep(500);
  ok('signed out: the sign-in page shows (nothing lost)', await q.isHidden('#sheetModal'));
  await q.fill('#signinEmail', E); await q.fill('#signinPassword', 'pass-12345'); await q.tap('#signinForm .auth-submit');
  await q.waitForSelector('#sheetModal:not([hidden])', { timeout: 20000 });
  ok('…after signing in, it’s offered', (await q.textContent('#sheetText')).startsWith('Adds 1 file to Sheet 1.'));
  await q.tap('#sheetModal button:has-text("Add to Sheet 1")');
  await q.waitForFunction(() => [...document.querySelectorAll('#fileList .file-row')].some(r => r.textContent.includes('receipt.png')), null, { timeout: 30000 })
    .then(() => ok('…and uploads', true), () => ok('…and uploads', false));

  // ---- Without the service worker, /share-target just opens ScrapSheet ----
  const toml = fs.readFileSync(REPO + '/netlify.toml', 'utf8');
  ok('a share that reaches the site without the worker redirects home (netlify.toml)', /\[\[redirects\]\]\s*from = "\/share-target"\s*to = "\/"\s*status = 303\s*force = true/.test(toml));
  // Other requests aren't touched by the worker (nothing cached)
  ok('the worker doesn’t cache anything', await p.evaluate(async () => (await caches.keys()).length === 0));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
