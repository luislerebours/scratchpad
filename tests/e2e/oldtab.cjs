// A tab opened before R2 (old page code) must still upload: the server sends
// files to R2 only when the page asks for it (direct: 1).
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'oldtab' + Date.now() + '@example.com';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage(); p.on('pageerror', e => errs.push(e.message));
  const reqs = []; p.on('request', r => reqs.push(`${r.method()} ${r.url()}`));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  const download = async name => {
    const dl = p.waitForEvent('download', { timeout: 30000 });
    await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click('.menu-item:has-text("Download")');
    return fs.readFileSync(await (await dl).path());
  };

  // Today's page: straight to R2 through the relay.
  const a = crypto.randomBytes(2_500_000);
  reqs.length = 0;
  await p.setInputFiles('#fileInput', [{ name: 'new-tab.bin', mimeType: 'application/octet-stream', buffer: a }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 });
  ok('a current page uploads to R2 (relay)', reqs.some(r => r.startsWith('PUT http://localhost:8787/files/up')) && !reqs.some(r => /PUT .*functions\/files\?.*chunk=/.test(r)));

  // An old page: its start request has no `direct` flag.
  await p.route(/functions\/files\?.*action=start/, async route => {
    const body = JSON.parse(route.request().postData()); delete body.direct;
    route.continue({ postData: JSON.stringify(body) });
  });
  const old = crypto.randomBytes(9_000_000);
  reqs.length = 0;
  await p.setInputFiles('#fileInput', [{ name: 'old-tab.bin', mimeType: 'application/octet-stream', buffer: old }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 })
    .then(() => ok('a page from before R2 can still upload', true), () => ok('a page from before R2 can still upload', false));
  const puts = reqs.filter(r => /PUT .*functions\/files\?.*chunk=/.test(r));
  ok('…to Netlify, in 4 MB pieces, never to the relay', puts.length === 3 && !reqs.some(r => r.includes(':8787/files/up')), `${puts.length} pieces`);
  ok('…with no failed pieces or deletes', !reqs.some(r => r.startsWith('DELETE')));
  await p.unroute(/functions\/files\?.*action=start/);
  await sleep(2600);
  ok('the old-tab file downloads whole', Buffer.compare(await download('old-tab.bin'), old) === 0);
  ok('the R2 file downloads whole', Buffer.compare(await download('new-tab.bin'), a) === 0);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
