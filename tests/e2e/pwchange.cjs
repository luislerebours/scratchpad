// Change password (Account & security) and the trash button on file rows.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; 
const log = () => fs.readFileSync(__dirname + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'pwchange' + Date.now() + '@example.com';
const OLD = 'first-pass-123', NEW = 'second-pass-456', THIRD = 'third-pass-789';

(async () => {
  const b = await chromium.launch(); const errs = [];
  const newPage = async opts => { const p = await (await b.newContext({ acceptDownloads: true, ...opts })).newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const signIn = async (p, pass) => { await p.goto(BASE); await p.fill('#signinEmail', E); await p.fill('#signinPassword', pass); await p.click('#signinForm .auth-submit'); };
  const A = await newPage({ viewport: { width: 1280, height: 900 } });
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', OLD); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 });
  const recoveryKey = (await A.textContent('#recoveryKeyText')).trim();
  await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  await A.click('#scratchpad'); await A.keyboard.type('Locked notes that must survive');
  await A.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  const data = crypto.randomBytes(1_500_000);
  await A.setInputFiles('#fileInput', [{ name: 'keep-me.bin', mimeType: 'application/octet-stream', buffer: data }, { name: 'throw-away.txt', mimeType: 'text/plain', buffer: Buffer.from('bye') }]);
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 });

  // A phone signed in too.
  const P = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await signIn(P, OLD); await P.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);

  // ---- Trash button on file rows ----
  const colors = await P.$eval('#fileList .file-row:has-text("throw-away.txt")', row => ({
    trash: getComputedStyle(row.querySelector('[data-delete-file]')).color,
    download: getComputedStyle(row.querySelector('[data-save]')).color
  }));
  ok('each file row has a trash button next to Download, the same color (not red)', colors.trash === colors.download, JSON.stringify(colors));
  await P.$eval('#fileList', el => el.scrollIntoView({ block: 'center' })); await sleep(300);
  { const r = await P.$eval('#fileList', el => { const b = el.getBoundingClientRect(); return { x: 0, y: Math.max(0, b.top - 20), width: 390, height: b.height + 40 }; }); await P.screenshot({ path: OUT + 'file-row-trash.png', clip: r }); }
  await P.tap('#fileList .file-row:has-text("throw-away.txt") [data-delete-file]');
  await P.waitForSelector('#sheetModal:not([hidden])');
  ok('tapping it asks first (the same “Delete this file?”)', (await P.textContent('#sheetModal')).includes('Delete this file?'));
  await P.tap('#sheetActions button:has-text("Delete")');
  await P.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 10000 })
    .then(() => ok('…then the file is deleted', true), () => ok('…then the file is deleted', false));

  // ---- Change password ----
  await A.click('#accountBtn'); await A.click('[data-pf="security"]');
  ok('Account & security has “Change password…”', await A.isVisible('[data-pf="password"]'));
  await A.click('[data-pf="password"]'); await A.waitForSelector('#passwordModal:not([hidden])');
  const tryChange = async (cur, a, c) => {
    await A.fill('#currentPassword', cur); await A.fill('#changedPassword', a); await A.fill('#changedPasswordAgain', c);
    await A.click('#passwordChangeForm [type=submit]');
    await A.waitForFunction(() => !document.querySelector('#passwordChangeForm [type=submit]').disabled, null, { timeout: 30000 });
    await sleep(300);
    return A.textContent('#passwordChangeError');
  };
  ok('new passwords that don’t match are caught', (await tryChange(OLD, NEW, NEW + 'x')).includes('don’t match'));
  ok('a short new password is caught', (await tryChange(OLD, 'short', 'short')).includes('at least 8'));
  ok('a wrong current password is caught (on the device, nothing sent)', (await tryChange('wrong-pass-000', NEW, NEW)).includes('current password isn’t right'));
  await A.fill('#currentPassword', OLD); await A.fill('#changedPassword', NEW); await A.fill('#changedPasswordAgain', NEW);
  await A.screenshot({ path: OUT + 'change-password.png' });
  await A.click('#passwordChangeForm [type=submit]');
  await A.waitForSelector('#passwordModal', { state: 'hidden', timeout: 30000 })
    .then(() => ok('the right current password changes it', true), () => ok('the right current password changes it', false, A.textContent('#passwordChangeError')));
  ok('…with a note that other devices were signed out', (await A.textContent('#toast')).includes('Password changed'));
  await sleep(4000);
  ok('this device stays signed in, its text and file intact', await A.isVisible('.app-shell') && (await A.textContent('#scratchpad')).includes('Locked notes that must survive') && (await A.$$('#fileList .file-row')).length === 1);
  ok('the phone was signed out', await P.isVisible('#authScreen'));
  ok('a security email went out', /security password/.test(log().split(E).slice(-1)[0] || '') || log().includes(`to ${E}: security password`));

  // ---- Signing in afterwards ----
  const C = await newPage({ viewport: { width: 1280, height: 900 } });
  await signIn(C, OLD); await sleep(4000);
  ok('the old password no longer works', !(await C.isVisible('.app-shell')));
  await signIn(C, NEW); await C.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(2500);
  ok('the new one does, and everything opens (same keys)', (await C.textContent('#scratchpad')).includes('Locked notes that must survive'));
  const dl = C.waitForEvent('download', { timeout: 30000 });
  await C.click('#fileList .file-row:has-text("keep-me.bin") [data-file-menu]'); await C.click('.menu-item:has-text("Download")');
  ok('…and the file downloads whole', Buffer.compare(fs.readFileSync(await (await dl).path()), data) === 0);

  // ---- The recovery key still works after the change ----
  const R = await newPage({ viewport: { width: 1280, height: 900 } });
  await R.goto(BASE); await R.click('#signinForm [data-mode="reset"]'); await R.fill('#codeEmail', E); await R.click('#emailForm .auth-submit');
  await R.waitForSelector('#codeForm:not([hidden])'); await sleep(500); await R.fill('#codeInput', lastCode(E)); await R.click('#codeForm .auth-submit');
  await R.waitForSelector('#recoverForm:not([hidden])', { timeout: 15000 }); await R.fill('#recoverInput', recoveryKey); await R.click('#recoverForm .auth-submit');
  await R.waitForSelector('#passwordForm:not([hidden])', { timeout: 15000 }); await R.fill('#newPassword', THIRD); await R.click('#passwordForm .auth-submit');
  await R.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(2500);
  ok('the recovery key from before still resets it, with everything there', (await R.textContent('#scratchpad')).includes('Locked notes that must survive'));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
