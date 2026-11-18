// Uploads (and downloads) wait while the page is in the background or offline,
// then carry on from the piece they were on; a request stuck after returning is
// started again; a refusal from the server still ends it at once.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(100); } };
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'resume' + Date.now() + '@example.com';
// A piece upload: to Netlify (?chunk=N), or to R2 through the relay (/files/up?…&i=N).
const CHUNK_PUT = /(?:\/\.netlify\/functions\/files\?.*[?&]chunk=|:8787\/files\/up\?.*[?&]i=)(\d+)/;

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await p.waitForSelector('#status[data-state="live"]', { timeout: 10000 });

  // The page can be "sent to the background" (what a phone does when you switch apps).
  await p.evaluate(() => {
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
  });
  const setVisible = v => p.evaluate(v => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); }, v);
  const meta = () => p.$eval('.transfer-row .transfer-meta', el => el.textContent).catch(() => '');
  const rowCount = () => p.$$eval('#fileList .file-row', r => r.length);

  // Each chunk PUT is slowed down so there's time to switch away mid-upload.
  let mode = 'pass'; let slow = 700; const sent = []; const hung = [];
  await p.route(CHUNK_PUT, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const i = Number(route.request().url().match(CHUNK_PUT)[1]);
    if (mode === 'drop') return route.abort('internetdisconnected');
    if (mode === 'hang') { hung.push(i); return; } // never answers
    if (mode === 'refuse') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"No"}' });
    await sleep(slow);
    const r = await route.fetch().catch(() => null);
    if (!r) return route.abort().catch(() => {});
    if (r.ok()) sent.push(i);
    return route.fulfill({ response: r }).catch(() => {});
  });

  // ---- 1. Switch apps mid-upload: it pauses, then carries on from where it was ----
  const data1 = crypto.randomBytes(30_000_000); // 30 pieces (1 MB in R2)
  slow = 2000;
  await p.setInputFiles('#fileInput', [{ name: 'video-clip.mov', mimeType: 'video/quicktime', buffer: data1 }]);
  await p.waitForSelector('.transfer-row');
  ok('the upload bar says to keep ScrapSheet open', (await p.textContent('.transfer-row .transfer-note')) === 'Keep ScrapSheet open until uploads finish.');
  await until(() => sent.length >= 2, 30000, 'first pieces');
  await setVisible('hidden'); mode = 'drop';
  await sleep(4000);
  ok('in the background: not failed, paused', !(await p.$('.transfer-row.failed')) && /Paused|connection/.test(await meta()), await meta());
  const before = [...sent];
  mode = 'pass'; await setVisible('visible');
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 60000 })
    .then(() => ok('back in front: it finishes by itself (no Retry tap)', true), () => ok('back in front: it finishes by itself (no Retry tap)', false, String(sent)));
  ok('pieces already sent weren’t sent again', before.every(i => sent.filter(x => x === i).length === 1), `before ${before} · all ${sent}`);
  ok('every piece arrived once', Array.from({ length: 30 }, (_, i) => i).every(i => sent.includes(i)) && before.length < 30, String(sent));
  ok('the note goes away when it’s done', !(await p.$('.transfer-row .transfer-note')));
  // The file is whole: download it back
  await sleep(2600);
  const dl = p.waitForEvent('download', { timeout: 30000 });
  await p.tap('#fileList .file-row [data-file-menu]'); await p.tap('.menu-item:has-text("Download")');
  const got = fs.readFileSync(await (await dl).path());
  ok('…and the file is whole (downloaded back, byte for byte)', Buffer.compare(got, data1) === 0, `${got.length} bytes`);

  // ---- 2. Connection drops mid-upload: waits, then carries on ----
  sent.length = 0;
  await p.setInputFiles('#fileInput', [{ name: 'photos.zip', mimeType: 'application/zip', buffer: crypto.randomBytes(14_000_000) }]);
  await until(() => sent.length >= 1, 30000, 'a piece');
  await ctx.setOffline(true);
  await sleep(4000);
  ok('offline: waits for a connection (doesn’t fail)', !(await p.$('.transfer-row.failed')) && (await meta()).includes('Waiting for a connection'), await meta());
  await p.$eval('.transfer-row', el => el.scrollIntoView({ block: 'center' })); await sleep(300);
  { const r = await p.$eval('.transfer-row', el => { const b = el.getBoundingClientRect(); return { x: 0, y: Math.max(0, b.top - 180), width: 390, height: b.height + 220 }; }); await p.screenshot({ path: OUT + 'upload-waiting.png', clip: r }); }
  await ctx.setOffline(false);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 60000 })
    .then(() => ok('back online: finishes by itself', true), () => ok('back online: finishes by itself', false));

  // ---- 3. A request stuck after coming back is started again ----
  sent.length = 0;
  await p.setInputFiles('#fileInput', [{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: crypto.randomBytes(30_000_000) }]);
  await until(() => sent.length >= 1, 30000, 'a piece');
  mode = 'hang'; await setVisible('hidden');
  await until(() => hung.length > 0, 30000, 'a hung piece');
  await sleep(1500);
  mode = 'pass'; await setVisible('visible');
  const t0 = Date.now();
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 3, null, { timeout: 40000 })
    .then(() => ok('a stuck piece is restarted soon after coming back', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`), () => ok('a stuck piece is restarted soon after coming back', false));

  // ---- 4. A refusal from the server still fails at once (no endless waiting) ----
  mode = 'refuse';
  await p.setInputFiles('#fileInput', [{ name: 'refused.bin', mimeType: 'application/octet-stream', buffer: crypto.randomBytes(100_000) }]);
  await p.waitForSelector('.transfer-row.failed', { timeout: 10000 })
    .then(() => ok('a refusal fails straight away, with Retry', true), () => ok('a refusal fails straight away, with Retry', false));
  mode = 'pass';
  await sleep(300);
  ok('nothing half-uploaded shows', (await rowCount()) === 3);

  // ---- 5. Downloads wait in the background too ----
  await p.unroute(CHUNK_PUT);
  let dmode = 'pass';
  await p.route(/\/\.netlify\/functions\/files\?.*[?&]chunk=\d+/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (dmode === 'drop') return route.abort('internetdisconnected');
    await sleep(500); return route.continue();
  });
  await p.evaluate(() => caches?.keys?.().then(k => Promise.all(k.map(n => caches.delete(n)))));
  const dl2 = p.waitForEvent('download', { timeout: 60000 });
  await p.tap('#fileList .file-row:has-text("video-clip.mov") [data-file-menu]'); await p.tap('.menu-item:has-text("Download")');
  await sleep(300); await setVisible('hidden'); dmode = 'drop'; await sleep(3000);
  ok('download in the background: paused, not failed', !(await p.$('.transfer-row.failed:has-text("video-clip.mov")')) && /Paused/.test(await p.textContent('.transfer-row:has-text("video-clip.mov") .transfer-meta')), await p.textContent('.transfer-row:has-text("video-clip.mov") .transfer-meta'));
  dmode = 'pass'; await setVisible('visible');
  const got2 = fs.readFileSync(await (await dl2).path());
  ok('…and finishes whole once back', Buffer.compare(got2, data1) === 0);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
