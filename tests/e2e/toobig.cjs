// Picking a file over 100 MB says so in a box that stays until OK (not a quick toast).
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'toobig' + Date.now() + '@example.com';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  const free = await p.evaluate(() => document.querySelector('.dz-sub').textContent.includes('10 MB per'));
  ok('the drop zone says "Up to 100 MB per file"', (await p.textContent('.dz-sub')) === (free ? 'Up to 10 MB per file' : 'Up to 100 MB per file'), await p.textContent('.dz-sub'));

  // One file too big
  // Big files on disk (sparse: they take no space)
  const DIR = OUT + 'bigfiles/'; fs.mkdirSync(DIR, { recursive: true });
  const make = (name, size) => { const f = DIR + name; fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, size); return f; };
  const MB = 1024 * 1024;
  await p.setInputFiles('#fileInput', [make('IMG_4021.MOV', 212 * MB)]);
  await p.waitForSelector('#sheetModal:not([hidden])', { timeout: 15000 });
  ok('a box says it’s too big', (await p.textContent('#sheetTitle')) === 'This file is too big');
  ok('…with the limit and its size', (await p.textContent('#sheetText')) === (free ? 'Files can be up to 10 MB on Free and 100 MB on Pro, and this one is 212 MB.' : 'Files can be up to 100 MB each, and this one is 212 MB.'), await p.textContent('#sheetText'));
  ok('…and names the file', (await p.textContent('#sheetModal')).includes('IMG_4021.MOV'));
  await sleep(4000);
  ok('it stays until OK (not a quick toast)', await p.isVisible('#sheetModal'));
  await p.screenshot({ path: OUT + 'too-big.png' });
  ok('nothing started uploading', !(await p.$('.transfer-row')));
  await p.tap('#sheetModal button:has-text("OK")'); await sleep(300);
  ok('OK closes it', await p.isHidden('#sheetModal'));

  // Two too big, one fine: the fine one uploads
  fs.writeFileSync(DIR + 'notes.txt', 'fine');
  await p.setInputFiles('#fileInput', [make('long-video.mp4', 212 * MB), DIR + 'notes.txt', make('backup.zip', 101 * MB)]);
  await p.waitForSelector('#sheetModal:not([hidden])', { timeout: 15000 });
  ok('several: "2 files are too big"', (await p.textContent('#sheetTitle')) === '2 files are too big');
  ok('…says the other is uploading', (await p.textContent('#sheetText')) === (free ? 'Files can be up to 10 MB on Free and 100 MB on Pro. Your other file is uploading.' : 'Files can be up to 100 MB each. Your other file is uploading.'), await p.textContent('#sheetText'));
  ok('…lists both with sizes', /long-video\.mp4\s*212 MB/.test(await p.textContent('#sheetItems')) && /backup\.zip\s*101 MB/.test(await p.textContent('#sheetItems')), await p.textContent('#sheetItems'));
  await p.tap('#sheetModal button:has-text("OK")');
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 20000 })
    .then(() => ok('the file that fits uploads', true), () => ok('the file that fits uploads', false));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
