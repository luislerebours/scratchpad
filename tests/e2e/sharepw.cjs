// Password-protected share links: the key in the link is locked with the
// password, and the server serves nothing for the link until the password is
// proved (only a one-way proof reaches it). Add, change, remove; old links and
// passes stop working; wrong tries are limited.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'sharepw' + Date.now() + '@example.com';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const { sharesStore } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/shares.mjs').href);
  const b = await chromium.launch(); const errs = [];
  const A = await (await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] })).newPage(); A.on('pageerror', e => errs.push(e.message));
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  await A.click('#scratchpad'); await A.keyboard.type('Wifi password: lemon-tree-42');
  const data = crypto.randomBytes(1_200_000);
  await A.setInputFiles('#fileInput', [{ name: 'contract.pdf', mimeType: 'application/pdf', buffer: data }]);
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 }); await sleep(2600);

  // ---- Create a file link with a password ----
  await A.click('#fileList .file-row [data-file-menu]'); await A.click('.menu-item:has-text("link")');
  await A.waitForSelector('[data-share-create]');
  const whoBefore = await A.textContent('[data-share-who]');
  await A.click('.share-pw-box summary'); await A.fill('#sharePwNew', 'blue-river');
  ok('typing a password says only people with it can open the link', whoBefore.startsWith('Anyone with the link can') && (await A.textContent('[data-share-who]')).startsWith('Anyone with the link and the password can'), await A.textContent('[data-share-who]'));
  await A.screenshot({ path: OUT + 'share-pw-create.png' });
  await A.click('[data-share-create]');
  await A.waitForSelector('#shareUrlInput');
  const link = await A.inputValue('#shareUrlInput');
  const token = new URL(link).pathname.split('/').pop();
  ok('the link’s key part is locked with the password (p.…)', new URL(link).hash.startsWith('#p.'), new URL(link).hash.slice(0, 12));
  ok('the dialog says it’s password protected', (await A.textContent('#shareBody')).includes('Password protected'));
  await A.screenshot({ path: OUT + 'share-pw-dialog.png' });
  const rec = await sharesStore().get(`shares/${token}`, { type: 'json' });
  ok('the server keeps only a salt, a one-way hash and the owner’s locked copy of the link part', rec.pw?.kdfSalt && rec.pw.hash && !JSON.stringify(rec).includes('blue-river') && String(rec.linkFragment).startsWith('e1:'));
  await A.keyboard.press('Escape');

  // ---- A viewer ----
  const V = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true })).newPage(); V.on('pageerror', e => errs.push('V ' + e.message));
  const raw = await V.request.get(`${BASE}/.netlify/functions/share?t=${token}`);
  const rawBody = await raw.json();
  ok('without the password the server shows nothing (no name, no file list)', raw.status() === 401 && rawBody.reason === 'password' && !('file' in rawBody) && !('name' in rawBody));
  const rawChunk = await V.request.get(`${BASE}/.netlify/functions/share?t=${token}&file=x&chunk=0`);
  ok('…and serves no pieces', rawChunk.status() === 401);
  await V.goto(link); await V.waitForSelector('#sharePwForm');
  ok('the viewer asks for the password', (await V.textContent('.share-title')) === 'This link needs a password');
  await V.screenshot({ path: OUT + 'share-pw-viewer.png' });
  await V.fill('#sharePw', 'wrong-guess'); await V.click('#sharePwForm button');
  await V.waitForFunction(() => document.querySelector('#sharePwError').textContent, null, { timeout: 20000 });
  ok('a wrong password is refused', (await V.textContent('#sharePwError')).includes('isn’t right'));
  await V.fill('#sharePw', 'blue-river'); await V.click('#sharePwForm button');
  await V.waitForSelector('.share-title:has-text("contract.pdf")', { timeout: 20000 })
    .then(() => ok('the right password opens it (name unlocked)', true), () => ok('the right password opens it (name unlocked)', false));
  const dl = V.waitForEvent('download', { timeout: 30000 });
  await V.tap('[data-download], .share-download, button:has-text("Download")');
  ok('…and the file downloads whole', Buffer.compare(fs.readFileSync(await (await dl).path()), data) === 0);

  // ---- The owner reopens the dialog: same link ----
  await A.reload(); await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  await A.click('#fileList .file-row [data-file-menu]'); await A.click('.menu-item:has-text("link")');
  await A.waitForSelector('#shareUrlInput');
  ok('the owner sees the same protected link later', (await A.inputValue('#shareUrlInput')) === link);

  // ---- Change the password: the link changes; old link and old pass stop working ----
  await A.click('[data-share-pw="set"]'); await A.fill('#sharePwEdit', 'green-hill'); await A.click('[data-share-pw="save"]');
  await A.waitForFunction(old => document.querySelector('#shareUrlInput')?.value && document.querySelector('#shareUrlInput').value !== old, link, { timeout: 20000 });
  const link2 = await A.inputValue('#shareUrlInput');
  ok('changing the password gives a new link', link2 !== link && new URL(link2).hash.startsWith('#p.'));
  await V.reload(); await V.waitForSelector('#sharePwForm', { timeout: 15000 })
    .then(() => ok('the old pass no longer works (asks again)', true), () => ok('the old pass no longer works (asks again)', false));
  await V.fill('#sharePw', 'green-hill'); await V.click('#sharePwForm button');
  await V.waitForFunction(() => document.querySelector('#sharePwError').textContent, null, { timeout: 20000 });
  ok('the old link with the new password says it’s out of date', (await V.textContent('#sharePwError')).includes('out of date'));
  await V.goto(link2); await V.waitForSelector('#sharePwForm'); await V.fill('#sharePw', 'green-hill'); await V.click('#sharePwForm button');
  await V.waitForSelector('.share-title:has-text("contract.pdf")', { timeout: 20000 })
    .then(() => ok('the new link with the new password opens', true), () => ok('the new link with the new password opens', false));

  // ---- Remove the password ----
  await A.click('[data-share-pw="remove"]');
  await A.waitForFunction(() => document.querySelector('#shareBody').textContent.includes('No password'), null, { timeout: 15000 });
  const link3 = await A.inputValue('#shareUrlInput');
  const P = await (await b.newContext()).newPage();
  await P.goto(link3); await P.waitForSelector('.share-title:has-text("contract.pdf")', { timeout: 20000 })
    .then(() => ok('removing the password: the plain link opens without one', true), () => ok('removing the password: the plain link opens without one', false));
  await A.keyboard.press('Escape');

  // ---- A sheet link with a password shows its text ----
  await A.click('#sheetMenuBtn'); await A.click('.menu-item:has-text("Share sheet")');
  await A.waitForSelector('[data-share-create]'); await A.click('.share-pw-box summary'); await A.fill('#sharePwNew', 'sheet-pass');
  await A.click('[data-share-create]'); await A.waitForSelector('#shareUrlInput');
  const sheetLink = await A.inputValue('#shareUrlInput');
  const S = await (await b.newContext()).newPage(); S.on('pageerror', e => errs.push('S ' + e.message));
  await S.goto(sheetLink); await S.waitForSelector('#sharePwForm'); await S.fill('#sharePw', 'sheet-pass'); await S.click('#sharePwForm button');
  await S.waitForFunction(() => document.body.innerText.includes('lemon-tree-42'), null, { timeout: 20000 })
    .then(() => ok('a protected sheet link shows its text and files after the password', true), () => ok('a protected sheet link shows its text and files after the password', false));

  // ---- Wrong tries are limited ----
  const sheetToken = new URL(sheetLink).pathname.split('/').pop();
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await S.evaluate(async t => (await fetch(`/.netlify/functions/share?t=${t}&action=unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof: 'x'.repeat(43) }) })).status, sheetToken));
  ok('guessing is limited (too many tries → wait)', last === 429, String(last));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
