// A tab left open picks up a new version (new ETags) and reloads only at a
// quiet moment: not during an upload or with a dialog open; on return to the
// page, or after a while without use.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; const SALT = __dirname + '/deploy-salt.txt';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'autoupd' + Date.now() + '@example.com';
const deploy = v => fs.writeFileSync(SALT, v);

(async () => {
  try { fs.unlinkSync(SALT); } catch {}
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clock.install({ time: Date.now() });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  let loads = 0; p.on('load', () => loads++);
  const heads = []; p.on('request', r => { if (r.method() === 'HEAD') heads.push(r.url()); });
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' });
  await sleep(1500); await p.click('#scratchpad'); await p.keyboard.type('Still here after updates');
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  // Start from a freshly loaded page (the version it notes is this one).
  await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('the page notes its version when it loads (2 tiny HEAD requests)', heads.filter(u => u.endsWith('/app.js')).length >= 1 && heads.some(u => u === BASE + '/'));
  const loadsAt = () => loads;

  // ---- 1. Mid-upload when a new version comes out: waits for it to finish ----
  let release; const held = new Promise(r => { release = r; });
  await p.route(/:8787\/files\/up\?/, async route => { await held; route.continue().catch(() => {}); });
  await p.setInputFiles('#fileInput', [{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: crypto.randomBytes(3_000_000) }]);
  await p.waitForSelector('.transfer-row .transfer-cancel');
  deploy('v2');
  let before = loadsAt();
  await p.clock.fastForward('01:01:00'); // the hourly check runs, and the page has sat idle
  await sleep(3000);
  ok('a new version during an upload: no reload while it runs', loadsAt() === before && await p.$('.transfer-row .transfer-cancel') !== null);
  release(); await p.unroute(/:8787\/files\/up\?/);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 });
  await sleep(3000); // the finished row clears
  await p.clock.fastForward('00:00:31');
  await p.waitForEvent('load', { timeout: 15000 }).then(() => ok('…then it reloads once the upload is done (idle)', true), () => ok('…then it reloads once the upload is done (idle)', false));
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…the upload and the text are all there after the reload', (await p.$$('#fileList .file-row')).length === 1 && (await p.textContent('#scratchpad')).includes('Still here after updates'));

  // ---- 2. Away for a while, then back: reloads right away on return ----
  await p.evaluate(() => {
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
  });
  const setVis = v => p.evaluate(v => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); }, v);
  await setVis('hidden'); await sleep(500);
  deploy('v3');
  await p.clock.fastForward('00:11:00');
  before = loadsAt();
  await setVis('visible');
  await p.waitForEvent('load', { timeout: 15000 }).then(() => ok('back after 11 minutes with a new version out: reloads at once', true), () => ok('back after 11 minutes with a new version out: reloads at once', false));
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);

  // ---- 3. A dialog open: waits until it's closed ----
  await p.click('#accountBtn'); await p.waitForSelector('#profileModal:not([hidden])');
  deploy('v4');
  before = loadsAt();
  await p.clock.fastForward('01:01:00'); await sleep(2500);
  await p.clock.fastForward('00:00:31'); await sleep(2500);
  ok('with a dialog open: no reload', loadsAt() === before && await p.isVisible('#profileModal'));
  await p.keyboard.press('Escape'); await p.waitForSelector('#profileModal', { state: 'hidden' });
  await p.clock.fastForward('00:02:01');
  await p.waitForEvent('load', { timeout: 15000 }).then(() => ok('…closed and left alone 2 minutes: reloads', true), () => ok('…closed and left alone 2 minutes: reloads', false));
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);

  // ---- 4. In use: no reload while someone keeps typing ----
  deploy('v5');
  before = loadsAt();
  await p.click('#scratchpad'); await p.keyboard.press('End');
  for (let i = 0; i < 125; i++) { await p.keyboard.type('.'); await p.clock.fastForward('00:00:30'); } // an hour of steady use
  await sleep(1500);
  ok('typing on and off for an hour with a new version out: no reload', loadsAt() === before);
  await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  await p.clock.fastForward('00:02:31');
  await p.waitForEvent('load', { timeout: 15000 }).then(() => ok('…stops typing for 2 minutes: reloads', true), () => ok('…stops typing for 2 minutes: reloads', false));
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…and what was typed is all there', (await p.textContent('#scratchpad')).includes('Still here after updates' + ' '.repeat(0)) && (await p.textContent('#scratchpad')).includes('.....'));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  try { fs.unlinkSync(SALT); } catch {}
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { try { fs.unlinkSync(SALT); } catch {} console.error(e); process.exit(1); });
