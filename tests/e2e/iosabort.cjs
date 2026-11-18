// What iPhones do on an app switch: the browser itself aborts every upload and
// download in flight (it looks exactly like Cancel). ScrapSheet must treat that
// as a dropped connection: keep the file, wait, carry on from the piece it was
// on. Only a real Cancel tap ends it.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(100); } };
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'iosabort' + Date.now() + '@example.com';
const CHUNK_PUT = /(?:\/\.netlify\/functions\/files\?.*[?&]chunk=|:8787\/files\/up\?.*[?&]i=)(\d+)/;

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  // Track every XHR and fetch; "going to the background" aborts them all, like iOS.
  await ctx.addInitScript(() => {
    window.__live = new Set(); window.__killed = 0;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      window.__live.add(this);
      this.addEventListener('loadend', () => window.__live.delete(this));
      return send.apply(this, a);
    };
    window.__ctrls = new Set();
    const f = window.fetch;
    window.fetch = (input, init = {}) => {
      if (!String(input?.url || input).includes('chunk=') && !String(input?.url || input).includes('/files/get')) return f(input, init);
      const c = new AbortController(); window.__ctrls.add(c);
      init.signal?.addEventListener('abort', () => c.abort(init.signal.reason));
      return f(input, { ...init, signal: c.signal }).finally(() => window.__ctrls.delete(c));
    };
    window.__iosBackground = () => {
      window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
      for (const x of window.__live) { window.__killed++; x.abort(); }
      for (const c of window.__ctrls) { window.__killed++; c.abort(new DOMException('The operation was aborted.', 'AbortError')); }
    };
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
  });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const reqs = []; p.on('request', r => reqs.push(`${r.method()} ${r.url()}`));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await p.waitForSelector('#status[data-state="live"]', { timeout: 10000 });
  const meta = () => p.$eval('.transfer-row .transfer-meta', el => el.textContent).catch(() => '');
  const background = () => p.evaluate(() => window.__iosBackground());
  const foreground = () => p.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });

  // Slow the pieces down so there's always one in flight.
  const sent = []; const hung = []; let hangOnce = false;
  await p.route(CHUNK_PUT, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const i = Number(route.request().url().match(CHUNK_PUT)[1]);
    if (hangOnce) { hangOnce = false; hung.push(i); return; } // the answer never comes
    await sleep(1200);
    const r = await route.fetch().catch(() => null);
    if (!r) return route.abort().catch(() => {});
    if (r.ok()) sent.push(i);
    return route.fulfill({ response: r }).catch(() => {});
  });

  // ---- Upload: two app switches mid-upload (the second one used to reset it to 0) ----
  const data = crypto.randomBytes(30_000_000); // 30 pieces (1 MB each in R2)
  await p.setInputFiles('#fileInput', [{ name: 'beach.mov', mimeType: 'video/quicktime', buffer: data }]);
  await until(() => sent.length >= 2, 30000, 'first pieces');
  for (const round of [1, 2]) {
    const killedBefore = await p.evaluate(() => window.__killed);
    await background();
    ok(`switch ${round}: the browser aborted the piece in flight (like iOS)`, (await p.evaluate(() => window.__killed)) > killedBefore);
    await sleep(2500);
    ok(`switch ${round}: not failed, paused`, !(await p.$('.transfer-row.failed')) && /Paused|connection/.test(await meta()), await meta());
    const at = sent.length;
    await foreground();
    if (round === 1) await until(() => sent.length >= at + 2, 30000, 'more pieces after coming back');
  }
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 60000 })
    .then(() => ok('it finishes by itself after coming back', true), () => ok('it finishes by itself after coming back', false, String(sent)));
  ok('the upload was never thrown away (no DELETE)', !reqs.some(r => r.startsWith('DELETE') && r.includes('/files')), reqs.filter(r => r.startsWith('DELETE')).join(' | '));
  ok('only one upload was started (no restart from 0)', reqs.filter(r => r.includes('action=start')).length === 1);
  ok('every piece arrived', Array.from({ length: 30 }, (_, i) => i).every(i => sent.includes(i)), String(sent));

  // ---- Download: an app switch mid-download carries on too ----
  await sleep(2600);
  await p.route(/(?:chunk=\d+|\/files\/get\?)/, async route => { if (route.request().method() === 'GET') await sleep(600); return route.continue(); });
  const dl = p.waitForEvent('download', { timeout: 60000 });
  await p.tap('#fileList .file-row [data-file-menu]'); await p.tap('.menu-item:has-text("Download")');
  await sleep(1500); await background(); await sleep(2500);
  ok('download in the background: not failed', !(await p.$('.transfer-row.failed')), await meta());
  await foreground();
  const got = fs.readFileSync(await (await dl).path());
  ok('…and the file comes back whole', Buffer.compare(got, data) === 0, `${got.length} bytes`);

  // ---- A piece whose answer never comes (while in front) is sent again ----
  sent.length = 0; hangOnce = true;
  const t0 = Date.now();
  await p.setInputFiles('#fileInput', [{ name: 'stall.bin', mimeType: 'application/octet-stream', buffer: crypto.randomBytes(5_000_000) }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 90000 })
    .then(() => ok('a silently stuck piece is sent again and the upload finishes', hung.length === 1 && sent.includes(hung[0]), `${((Date.now() - t0) / 1000).toFixed(0)} s, hung ${hung}`), () => ok('a silently stuck piece is sent again and the upload finishes', false, String(sent)));

  // ---- A real Cancel tap still cancels ----
  reqs.length = 0;
  await p.setInputFiles('#fileInput', [{ name: 'cancel-me.bin', mimeType: 'application/octet-stream', buffer: crypto.randomBytes(14_000_000) }]);
  await p.waitForSelector('.transfer-row .transfer-cancel', { timeout: 15000 });
  await sleep(1500);
  await p.tap('.transfer-row .transfer-cancel');
  await sleep(2000);
  ok('Cancel still removes the upload', !(await p.$('.transfer-row:has-text("cancel-me.bin"):not(.failed)')) && (await p.$$eval('#fileList .file-row', r => r.length)) === 2);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
