// Cost trims: fewer saves while typing (1.5 s after a pause, at least every
// 5 s), the device that saved tells the relay (not the server), the safety-net
// check every 5 minutes while live sync is up, and yearly first on Upgrade.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'trims' + Date.now() + '@example.com';

(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async () => { const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const A = await page();
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' });
  const B = await page();
  await B.goto(BASE); await B.fill('#signinEmail', E); await B.fill('#signinPassword', 'pass-12345'); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state: 'visible' });
  await A.waitForSelector('#status[data-state="live"]', { timeout: 10000 }); await B.waitForSelector('#status[data-state="live"]', { timeout: 10000 });
  await sleep(2000);

  const aReq = []; A.on('request', r => aReq.push({ m: r.method(), u: r.url(), t: Date.now() }));
  const bReq = []; B.on('request', r => bReq.push({ m: r.method(), u: r.url(), t: Date.now() }));
  const saves = () => aReq.filter(r => r.m === 'POST' && /functions\/state\?sheet=\d+$/.test(r.u));

  // ---- Typing word by word with short pauses for ~9 s ----
  await A.click('#scratchpad');
  const words = 'the quick brown fox jumps over the lazy dog and keeps on running far away'.split(' ');
  const t0 = Date.now();
  for (const w of words) { await A.keyboard.type(w + ' ', { delay: 40 }); await sleep(500); }
  const typedFor = (Date.now() - t0) / 1000;
  await A.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  const n = saves().length;
  ok(`typing for ${typedFor.toFixed(0)} s with short pauses: only a few saves`, n >= 2 && n <= 4, `${n} saves (was one per pause: ~${words.length})`);
  const gaps = saves().map((r, i, a) => i ? ((r.t - a[i - 1].t) / 1000).toFixed(1) : null).filter(Boolean);
  ok('…at least one every 5 s while typing goes on', saves()[0].t - t0 <= 5600, `first after ${((saves()[0].t - t0) / 1000).toFixed(1)} s, gaps ${gaps}`);

  // ---- The other device still gets it at once, through the relay ----
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('running far away'), null, { timeout: 5000 })
    .then(() => ok('the other device shows the text', true), () => ok('the other device shows the text', false));
  ok('the device that saved sent the notice to the relay', aReq.some(r => r.m === 'POST' && r.u.startsWith('http://localhost:8787/notify')));

  // A pause then one more word: saved 1.5 s after typing stops
  aReq.length = 0;
  await A.keyboard.type('done'); const tStop = Date.now();
  await A.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  const after = (saves()[0]?.t - tStop) / 1000;
  ok('a save goes out about 1.5 s after typing stops', after >= 1.3 && after <= 2.5, `${after.toFixed(1)} s`);
  // Leaving the page right away still saves what was typed
  await A.keyboard.type(' bye'); await sleep(200);
  await A.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await B.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('done bye'), null, { timeout: 6000 })
    .then(() => ok('switching away right after typing saves it at once', true), () => ok('switching away right after typing saves it at once', false));

  // ---- Safety-net check: none for a while with live sync connected ----
  bReq.length = 0;
  await sleep(75000);
  const checks = bReq.filter(r => r.u.includes('/api/check')).length;
  ok('with live sync connected, no safety-net check for 75 s (was once a minute)', checks === 0, `${checks} checks`);

  // ---- Upgrade card: yearly first ----
  const C = await page(); const EC = 'trimsfree' + Date.now() + '@example.com';
  await C.goto(BASE); await C.click('.auth-create'); await C.fill('#codeEmail', EC); await C.click('#emailForm .auth-submit');
  await C.waitForSelector('#codeForm:not([hidden])'); await C.fill('#codeInput', lastCode(EC)); await C.click('#codeForm .auth-submit');
  await C.waitForSelector('#passwordForm:not([hidden])'); await C.fill('#newPassword', 'pass-12345'); await C.click('#passwordForm .auth-submit');
  await C.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await C.check('#recoverySaved'); await C.click('#recoveryKeyForm .auth-submit');
  await C.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await C.click('#addSheetBtn'); // Free has 1 sheet: the upgrade card
  await C.waitForSelector('#sheetActions .btn');
  const btns = await C.$$eval('#sheetActions .btn', bs => bs.map(b => `${b.className}|${b.textContent}`));
  ok('Upgrade shows yearly first, full width and highlighted', /primary full\|\$9\.99 \/ year · save 16%/.test(btns[0]), btns.join(' ; '));
  ok('…then monthly, then Not now', /\$0\.99 \/ month/.test(btns[1]) && /Not now/.test(btns[2]));
  await sleep(400); await C.screenshot({ path: OUT + 'upgrade-yearly-first.png' });

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
