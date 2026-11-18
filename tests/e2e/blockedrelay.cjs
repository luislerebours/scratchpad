// A network that blocks the relay (a workplace filter): R2 files download
// through Netlify, new files are stored on Netlify, and edits still reach the
// other devices right away. Share links work there too.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'blocked' + Date.now() + '@example.com';

(async () => {
  const b = await chromium.launch(); const errs = [];
  // The work PC: anything to the relay (port 8787) fails, WebSocket included.
  // (A browser that can't resolve the relay's host; the app is on 127.0.0.1.)
  const work = await chromium.launch({ args: ['--host-resolver-rules=MAP localhost ~NOTFOUND'] });
  const WORK = 'http://127.0.0.1:8970';
  // Phone: normal network.
  const A = await (await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })).newPage(); A.on('pageerror', e => errs.push('A ' + e.message));
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);
  const aReq = []; A.on('request', r => aReq.push(`${r.method()} ${r.url()}`));
  const fromPhone = crypto.randomBytes(2_500_000);
  await A.setInputFiles('#fileInput', [{ name: 'from-phone.bin', mimeType: 'application/octet-stream', buffer: fromPhone }]);
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 });
  ok('the phone (normal network) uploads to R2', aReq.some(r => r.startsWith('PUT http://localhost:8787/files/up')));

  const workCtx = await work.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const B = await workCtx.newPage(); B.on('pageerror', e => errs.push('B ' + e.message));
  const bReq = []; B.on('request', r => bReq.push(`${r.method()} ${r.url()}`));
  await B.goto(WORK); await B.fill('#signinEmail', E); await B.fill('#signinPassword', 'pass-12345'); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);
  const download = async (p, name) => {
    const dl = p.waitForEvent('download', { timeout: 40000 });
    await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click('.menu-item:has-text("Download")');
    return fs.readFileSync(await (await dl).path());
  };

  // ---- Downloading an R2 file at work ----
  bReq.length = 0;
  ok('at work: the phone’s R2 file downloads whole', Buffer.compare(await download(B, 'from-phone.bin'), fromPhone) === 0);
  ok('…through Netlify (via=netlify)', bReq.some(r => /functions\/files\?.*chunk=\d+.*via=netlify/.test(r)), bReq.filter(r => r.includes('chunk=')).length + ' piece requests');
  ok('…and no failed “waiting for a connection”', !(await B.$('.transfer-row.failed')));

  // ---- Uploading at work: stored on Netlify ----
  bReq.length = 0;
  const fromWork = crypto.randomBytes(5_000_000);
  await B.setInputFiles('#fileInput', [{ name: 'from-work.bin', mimeType: 'application/octet-stream', buffer: fromWork }]);
  await B.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 })
    .then(() => ok('at work: uploading works', true), () => ok('at work: uploading works', false));
  ok('…stored on Netlify (no relay attempts)', bReq.some(r => /PUT .*functions\/files\?.*chunk=/.test(r)) && !bReq.some(r => r.includes(':8787/files/up')));
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 15000 }).catch(() => {});
  await sleep(2600);
  ok('the phone gets the work file whole', Buffer.compare(await download(A, 'from-work.bin'), fromWork) === 0);

  // ---- Typing at work reaches the phone right away ----
  const bSaves = []; B.on('request', r => { if (r.method() === 'POST' && /functions\/state\?sheet=\d+$/.test(r.url())) bSaves.push(JSON.parse(r.postData() || '{}')); });
  await B.click('#scratchpad'); await B.keyboard.type('typed at the office');
  const t0 = Date.now();
  await A.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('typed at the office'), null, { timeout: 8000 })
    .then(() => ok('typing at work shows on the phone within seconds', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`), () => ok('typing at work shows on the phone within seconds', false));
  ok('…the work PC asked the server to tell the phone (notify)', bSaves.some(d => d.notify === 1));
  // ---- And the phone's edits reach the work PC (its 2-second check) ----
  await A.click('#scratchpad'); await A.keyboard.press('End'); await A.keyboard.type(' and from the phone');
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('and from the phone'), null, { timeout: 10000 })
    .then(() => ok('the phone’s edits show at work', true), () => ok('the phone’s edits show at work', false));

  // ---- A share link opened at work ----
  await A.click('#fileList .file-row:has-text("from-phone.bin") [data-file-menu]'); await A.click('.menu-item:has-text("link")');
  await A.waitForSelector('[data-share-create], #shareUrlInput');
  if (await A.isVisible('[data-share-create]')) await A.click('[data-share-create]');
  await A.waitForSelector('#shareUrlInput'); const link = await A.inputValue('#shareUrlInput'); await A.keyboard.press('Escape');
  const gctx = await work.newContext({ acceptDownloads: true });
  const G = await gctx.newPage(); const gReq = []; G.on('request', r => gReq.push(r.url()));
  await G.goto(link.replace(BASE, WORK)); await G.waitForSelector('[data-download], .share-download, button:has-text("Download")', { timeout: 20000 });
  const gdl = G.waitForEvent('download', { timeout: 40000 });
  await G.click('[data-download], .share-download, button:has-text("Download")');
  ok('a share link opened at work downloads whole', Buffer.compare(fs.readFileSync(await (await gdl).path()), fromPhone) === 0);
  ok('…through Netlify', gReq.some(u => u.includes('via=netlify')));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await work.close(); await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
