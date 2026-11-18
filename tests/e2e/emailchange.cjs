// Change email: a code to the new address, the same password, everything
// still opens; other devices signed out; Google Play and anything keyed by the
// old email follow; the old address gets a notice; the recovery key still works.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const log = () => fs.readFileSync(__dirname + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()?.[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const T = Date.now(); const OLD = `before${T}@example.com`, NEW = `after${T}@example.com`, OTHER = `taken${T}@example.com`, PASS = 'pass-12345';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const { emailKey, authStore } = await import(REPO + '/netlify/lib/auth.mjs');
  const { currentUserKey } = await import(REPO + '/netlify/lib/moves.mjs');
  const { accountForToken } = await import(REPO + '/netlify/lib/play.mjs');
  const b = await chromium.launch(); const errs = [];
  const page = async (vp = { width: 1280, height: 900 }) => { const p = await (await b.newContext({ viewport: vp })).newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const signUp = async (p, email) => {
    await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', email); await p.click('#emailForm .auth-submit');
    await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(email)); await p.click('#codeForm .auth-submit');
    await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', PASS); await p.click('#passwordForm .auth-submit');
    await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 });
    const key = (await p.textContent('#recoveryKeyText')).trim();
    await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
    await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
    return key;
  };
  const signIn = async (p, email) => { await p.goto(BASE); await p.fill('#signinEmail', email); await p.fill('#signinPassword', PASS); await p.click('#signinForm .auth-submit'); };
  // Someone else already uses OTHER.
  const X = await page(); await signUp(X, OTHER); await X.context().close();

  const A = await page();
  const recoveryKey = await signUp(A, OLD);
  await A.click('#scratchpad'); await A.keyboard.type('Everything here must still open');
  await A.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 });
  // Pretend the account has a Google Play subscription (its token links to the account).
  const store = authStore(); const oldEk = emailKey(OLD), newEk = emailKey(NEW);
  await store.setJSON(`users/${oldEk}`, { ...(await store.get(`users/${oldEk}`, { type: 'json' })), play: { token: 'play-token-abc', state: 'SUBSCRIPTION_STATE_ACTIVE' } });
  await store.set(`play-tokens/${require('crypto').createHash('sha256').update('play-token-abc').digest('hex')}`, oldEk);

  const P = await page({ width: 390, height: 844 }); await signIn(P, OLD); await P.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2000);

  // ---- The dialog ----
  await A.click('#accountBtn'); await A.click('[data-pf="security"]');
  ok('Account & security has “Change email…” with the current address', (await A.textContent('[data-pf="email"]')).includes('Change email') && (await A.textContent('[data-pf="email"]')).includes(OLD));
  await A.click('[data-pf="email"]'); await A.waitForSelector('#emailModal:not([hidden])');
  const step = async () => { await A.click('#emailChangeSubmit'); await A.waitForFunction(() => !document.querySelector('#emailChangeSubmit').disabled, null, { timeout: 30000 }); await sleep(200); return A.textContent('#emailChangeError'); };
  await A.fill('#emailChangeNew', NEW); await A.fill('#emailChangePassword', 'wrong-pass-0');
  ok('a wrong password is caught on the device', (await step()).includes('password isn’t right'));
  await A.fill('#emailChangeNew', OTHER); await A.fill('#emailChangePassword', PASS);
  ok('an email that already has an account is refused', (await step()).includes('already has a ScrapSheet account'));
  await A.fill('#emailChangeNew', NEW);
  await step();
  ok('the right password sends a code to the new address', await A.isVisible('#emailChangeCode') && Boolean(lastCode(NEW)) && (await A.textContent('#emailChangeTo')) === NEW);
  await A.screenshot({ path: OUT + 'change-email.png' });
  await A.fill('#emailChangeCode', 'otter0000');
  ok('a wrong code is refused', (await step()).includes('isn’t right'));
  ok('…and nothing changed yet', Boolean(await store.get(`users/${oldEk}`)) && !(await store.get(`users/${newEk}`)));
  await A.fill('#emailChangeCode', lastCode(NEW));
  await A.click('#emailChangeSubmit');
  await A.waitForSelector('#emailModal', { state: 'hidden', timeout: 30000 })
    .then(() => ok('the right code changes it', true), () => ok('the right code changes it', false, A.textContent('#emailChangeError')));
  ok('…with a note saying so', (await A.textContent('#toast')).includes(NEW));
  await sleep(3000);
  ok('this device stays signed in and shows the new email', await A.isVisible('.app-shell') && (await A.getAttribute('#accountBtn', 'title')) === NEW && (await A.textContent('#scratchpad')).includes('Everything here must still open'));
  ok('the other device was signed out', await P.isVisible('#authScreen'));
  ok('the account is stored under the new email only', Boolean(await store.get(`users/${newEk}`)) && !(await store.get(`users/${oldEk}`)));
  ok('anything keyed by the old email finds the account where it moved', (await currentUserKey(oldEk)) === newEk);
  ok('the Google Play subscription follows it', (await accountForToken('play-token-abc')) === newEk);
  ok('the old address got a security notice', log().includes(`to ${OLD}: security email`));

  // ---- Signing in afterwards ----
  const C = await page(); await signIn(C, OLD); await sleep(4000);
  ok('the old email no longer signs in', !(await C.isVisible('.app-shell')));
  await signIn(C, NEW); await C.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(2000);
  ok('the new email with the same password does, and everything opens', (await C.textContent('#scratchpad')).includes('Everything here must still open'));
  await A.reload(); await A.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(1500);
  ok('this device reopens without asking for the password', (await A.textContent('#scratchpad')).includes('Everything here must still open') && !(await A.isVisible('#authScreen')));

  // ---- The recovery key still works, with the new email ----
  const R = await page();
  await R.goto(BASE); await R.click('#signinForm [data-mode="reset"]'); await R.fill('#codeEmail', NEW); await R.click('#emailForm .auth-submit');
  await R.waitForSelector('#codeForm:not([hidden])'); await sleep(500); await R.fill('#codeInput', lastCode(NEW)); await R.click('#codeForm .auth-submit');
  await R.waitForSelector('#recoverForm:not([hidden])', { timeout: 15000 }); await R.fill('#recoverInput', recoveryKey); await R.click('#recoverForm .auth-submit');
  await R.waitForSelector('#passwordForm:not([hidden])', { timeout: 15000 }); await R.fill('#newPassword', 'third-pass-789'); await R.click('#passwordForm .auth-submit');
  await R.waitForSelector('.app-shell', { state: 'visible', timeout: 20000 }); await sleep(2000);
  ok('the recovery key from before resets the password at the new email', (await R.textContent('#scratchpad')).includes('Everything here must still open'));

  // ---- Deleting the account also erases the pointer from the old email ----
  await R.click('#accountBtn'); await R.click('[data-pf="security"]'); await R.click('[data-pf="delete"]'); await R.waitForSelector('#deleteAccountModal:not([hidden])');
  await R.fill('#deleteAccountPassword', 'third-pass-789'); await R.click('#deleteAccountForm [type=submit]');
  await R.waitForFunction(() => document.querySelector('#deleteAccountForm').textContent.includes('was deleted'), null, { timeout: 30000 });
  ok('deleting the account erases the old email’s pointer too', !(await store.get(`email-moves/${oldEk}`)) && !(await store.get(`users/${newEk}`)));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
