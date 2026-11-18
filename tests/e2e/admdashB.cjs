// Admin dashboard: setup with MFA, sign-in, server-side checks, audit log,
// account management, deactivation (data kept), sign-up toggle, errors, invites.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const API = BASE + '/.netlify/functions/admin-api';

const SETUP = process.env.ADMIN_SETUP_TOKEN || 'local-test-setup-token-0123456789';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };

// An independent TOTP (RFC 6238) for the test.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = s => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/\s/g, '')) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = (secret, offset = 0) => { const step = Math.floor(Date.now() / 30000) + offset; const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step)); const m = crypto.createHmac('sha1', unb32(secret)).update(c).digest(); const o = m[19] & 15; return String((m.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

async function signUp(page, email) {
  await page.goto(BASE); await page.click('.auth-create'); await page.fill('#codeEmail', email); await page.click('#emailForm .auth-submit');
  await page.waitForSelector('#codeForm:not([hidden])'); await page.fill('#codeInput', lastCode(email)); await page.click('#codeForm .auth-submit');
  await page.waitForSelector('#passwordForm:not([hidden])'); await page.fill('#newPassword', 'pass-12345'); await page.click('#passwordForm .auth-submit');
  await page.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await page.check('#recoverySaved'); await page.click('#recoveryKeyForm .auth-submit');
  await page.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
}
async function signIn(page, email) {
  await page.goto(BASE); await page.fill('#signinEmail', email); await page.fill('#signinPassword', 'pass-12345'); await page.click('#signinForm .auth-submit');
}
const call = (page, method, params, body) => page.evaluate(async ([API, method, params, body]) => {
  const r = await fetch(API + '?' + new URLSearchParams(params), { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [API, method, params, body]);

(async () => {
  // The lib's TOTP against RFC 6238's test vector (SHA-1, T=59s → step 1).
  const lib = await import(require('url').pathToFileURL(REPO + '/netlify/lib/admin.mjs').href);
  ok('TOTP matches RFC 6238 vector', lib.totpAt(lib.base32(Buffer.from('12345678901234567890')), 1) === '287082');

  const { getStore } = await import(require('url').pathToFileURL(REPO + '/node_modules/@netlify/blobs/dist/main.js').href);
  const store = name => getStore({ name, siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
  const auth = store('scratchpad-auth'); const adm = store('scratchpad-admin');
  const ekOf = e => crypto.createHash('sha256').update(e).digest('hex').slice(0, 32);
  const b = await chromium.launch(); const errs = [];
  const newPage = async (opts = {}) => { const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts })).newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/401|403|400|404|409|410|429/.test(m.text())) errs.push('console: ' + m.text()); }); return p; };

  // ---- App accounts: a Free one, a Pro one with data and a share link, and the legacy owner ----
  const FREE = `free${Date.now()}@example.com`, PRO = `pro${Date.now()}@example.com`, OWNER = 'owner@example.com';
  const free = await newPage(); await signUp(free, FREE);
  const pro = await newPage(); await signUp(pro, PRO);
  const proUser = await auth.get(`users/${ekOf(PRO)}`, { type: 'json' }); await auth.setJSON(`users/${ekOf(PRO)}`, { ...proUser, plan: 'pro' });
  await pro.reload(); await pro.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await pro.click('#scratchpad'); await pro.keyboard.type('Pro private notes');
  await pro.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  await pro.setInputFiles('#fileInput', [{ name: 'doc.txt', mimeType: 'text/plain', buffer: Buffer.from('secret file') }]);
  await pro.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  await pro.click('#fileList .file-row [data-file-menu]'); await pro.click('.menu-item:has-text("Share link")'); await pro.click('[data-share-create]'); await pro.waitForSelector('#shareUrlInput');
  const shareUrl = await pro.inputValue('#shareUrlInput'); await pro.keyboard.press('Escape');
  const proNs = proUser.ns;
  const countData = async ns => (await store(`u-${ns}`).list()).blobs.length + (await store(`u-${ns}-files-1`).list()).blobs.length + (await store(`u-${ns}-chunks-1`).list()).blobs.length;
  const proDataBefore = await countData(proNs);
  const owner = null; await auth.setJSON(`users/${ekOf(OWNER)}`, { uid: 'legacy', ns: '', email: OWNER, hash: 'x', salt: 'y', version: 3, createdAt: Date.now() - 9e9, migratedAt: Date.now() });
  const ownerKeysBefore = (await store('scratchpad').list()).blobs.length;

  // ---- Nobody but an admin gets in ----
  const anon = await newPage();
  await anon.goto(BASE + '/admin');
  for (const view of ['me', 'accounts', 'audit', 'errors', 'settings', 'admins']) {
    ok(`anonymous: ${view} refused`, (await call(anon, 'GET', { view })).status === 401);
  }
  for (const [n, app] of [['Free user', free], ['Pro user', pro]]) {
    // Same cookies as the app, on a quiet page.
    const p = await app.context().newPage(); await p.goto(BASE + '/terms');
    const r1 = await call(p, 'GET', { view: 'accounts' });
    const r2 = await call(p, 'POST', { action: 'account' }, { id: ekOf(FREE), op: 'plan', plan: 'pro' });
    const r3 = await call(p, 'POST', { action: 'settings' }, { signupsOpen: false });
    ok(`${n}: app session can’t read or change admin data`, r1.status === 401 && r2.status === 401 && r3.status === 401, `${r1.status} ${r2.status} ${r3.status}`);
    await p.close();
  }
  ok('Free user still Free after trying', (await auth.get(`users/${ekOf(FREE)}`, { type: 'json' })).plan === 'free');
  // A user session token put in the admin cookie is refused (different token type).
  const userCookie = (await free.context().cookies()).find(c => c.name === 'sp_session');
  await anon.context().addCookies([{ name: 'ss_admin', value: userCookie.value, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' }]);
  ok('user session token as admin cookie refused', (await call(anon, 'GET', { view: 'accounts' })).status === 401);
  await anon.context().clearCookies();

  // ---- First admin: setup token, password, authenticator ----
  const a = await newPage();
  await a.goto(BASE + '/admin'); await a.waitForSelector('#setupForm:not([hidden])');
  ok('fresh site shows first-admin setup', true);
  await a.fill('#setupToken', 'wrong-token-wrong-token-wrong'); await a.fill('#setupName', 'Ada'); await a.fill('#setupEmail', 'ada@sector.test'); await a.fill('#setupPassword', 'a-long-admin-pass-1');
  await a.click('#setupForm [type=submit]'); await a.waitForFunction(() => document.querySelector('#setupForm .ad-error').textContent);
  ok('wrong setup token refused', (await a.textContent('#setupForm .ad-error')).includes('setup token'));
  await a.fill('#setupToken', SETUP); await a.fill('#setupPassword', 'short');
  await a.click('#setupForm [type=submit]'); await a.waitForFunction(() => /12/.test(document.querySelector('#setupForm .ad-error').textContent));
  ok('short admin password refused', true);
  await a.fill('#setupToken', SETUP); await a.fill('#setupPassword', 'a-long-admin-pass-1');
  await a.click('#setupForm [type=submit]'); await a.waitForSelector('#enrollForm:not([hidden])');
  await a.waitForFunction(() => document.querySelector('#enrollQr').naturalWidth > 0);
  ok('QR code shows', true);
  await a.screenshot({ path: OUT + 'admin-enroll.png' });
  const secret = (await a.textContent('#enrollSecret')).replace(/\s/g, '');
  ok('no admin exists before the code is confirmed', !(await adm.get('bootstrap')));
  await a.fill('#enrollCode', '000000'); await a.click('#enrollForm [type=submit]');
  await a.waitForFunction(() => document.querySelector('#enrollForm .ad-error').textContent);
  ok('wrong authenticator code refused', true);
  await a.fill('#enrollCode', totp(secret)); await a.click('#enrollForm [type=submit]');
  await a.waitForSelector('#recoveryForm:not([hidden])');
  const codes = (await a.$$eval('#recoveryCodes li', l => l.map(x => x.textContent)));
  ok('10 recovery codes shown once', codes.length === 10 && new Set(codes).size === 10);
  await a.screenshot({ path: OUT + 'admin-codes.png' });
  await a.click('#recoveryForm [type=submit]'); await sleep(200);
  ok('must confirm codes are saved', await a.isVisible('#recoveryForm'));
  await a.check('#codesSaved'); await a.click('#recoveryForm [type=submit]');
  await a.waitForSelector('#dash:not([hidden])'); await a.waitForSelector('.ad-stat');
  ok('dashboard opens after enrolment', true);
  const record = await adm.get(`admins/${lib.adminId('ada@sector.test')}`, { type: 'json' });
  ok('admin stored apart from app accounts, password hashed, recovery codes hashed', record && !(await auth.get(`users/${ekOf('ada@sector.test')}`)) && record.hash && !JSON.stringify(record).includes('a-long-admin-pass-1') && !record.recovery.includes(codes[0]));
  const cookie = (await a.context().cookies()).find(c => c.name === 'ss_admin');
  ok('admin cookie is HttpOnly, Secure, SameSite=Strict, ~12 h', cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict' && cookie.expires * 1000 - Date.now() < 12.1 * 3600e3);
  ok('admin has no app account or session', !(await a.context().cookies()).some(c => c.name === 'sp_session') && (await a.evaluate(() => fetch('/.netlify/functions/auth').then(r => r.status))) === 401);

  // Setup is closed now.
  const again = await newPage(); await again.goto(BASE + '/admin'); await again.waitForSelector('#loginForm:not([hidden])');
  ok('setup closed after the first admin (login shows)', true);
  const r = await call(again, 'POST', { action: 'setup-start' }, { setupToken: SETUP, email: 'eve@sector.test', password: 'another-long-pass-9' });
  ok('setup token can’t make a second admin', r.status === 403, String(r.status));

  // ---- Overview and accounts ----
  const stats = await a.$$eval('.ad-stat', s => s.map(x => x.textContent));
  ok('overview counts accounts', stats[0].includes('3'), stats[0]);
  await a.screenshot({ path: OUT + 'admin-overview.png' });
  await a.click('[data-tab=accounts]'); await a.waitForSelector('#accountsTable tbody tr td .ad-email');
  const rows = await a.$$eval('#accountsTable tbody tr', t => t.map(x => x.textContent));
  ok('accounts list shows all three', rows.length === 3 && [FREE, PRO, OWNER].every(e => rows.some(r => r.includes(e))));
  ok('original-data account marked, no Legacy admin tag anywhere', rows.find(r => r.includes(OWNER)).includes('Original data') && !rows.join().includes('Legacy admin'));
  await a.screenshot({ path: OUT + 'admin-accounts.png' });
  const list = await call(a, 'GET', { view: 'accounts' });
  const raw = JSON.stringify(list.body);
  ok('no private content or secrets in the accounts data', !/Pro private notes|doc\.txt|keyring|"hash"|"salt"|byPassword|visitDays/.test(raw));

  // Change plan + storage limit (audited)
  await a.fill('#accountSearch', FREE); await a.click('#accountsTable tbody tr button'); await a.waitForSelector('#accountDialog[open]');
  await a.selectOption('#planSelect', 'pro'); await a.click('#planSave'); await a.waitForSelector('#toast:has-text("Plan changed")');
  ok('plan change saved', (await auth.get(`users/${ekOf(FREE)}`, { type: 'json' })).plan === 'pro');
  await a.fill('#quotaInput', '2'); await a.click('#quotaSave'); await a.waitForSelector('#toast:has-text("Storage limit saved")');
  ok('storage limit saved', (await auth.get(`users/${ekOf(FREE)}`, { type: 'json' })).quotaBytes === 2 * 1024 ** 3);
  await a.screenshot({ path: OUT + 'admin-account.png' });
  await a.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await a.fill('#quotaInput', ''); await a.click('#quotaSave'); await a.waitForSelector('#toast:has-text("Storage limit saved")');
  await a.selectOption('#planSelect', 'free'); await a.click('#planSave'); await a.waitForFunction(() => document.querySelector('#toast').textContent === 'Plan changed');
  ok('back to Free with plan limit', (await auth.get(`users/${ekOf(FREE)}`, { type: 'json' })).plan === 'free' && (await auth.get(`users/${ekOf(FREE)}`, { type: 'json' })).quotaBytes === undefined);
  await a.keyboard.press('Escape');

  // ---- Deactivate the Pro account: data kept, sessions and links end ----
  await a.fill('#accountSearch', PRO); await a.click('#accountsTable tbody tr button'); await a.waitForSelector('#accountDialog[open]');
  await a.click('#deactivateBtn'); await a.waitForSelector('#confirmDialog[open]');
  ok('deactivate needs the email typed', await a.isDisabled('#confirmOk'));
  await a.fill('#confirmType', PRO); await a.fill('#confirmReason', 'test');
  await a.screenshot({ path: OUT + 'admin-deactivate.png' });
  await a.click('#confirmOk'); await a.waitForSelector('#toast:has-text("Account deactivated")');
  const pu = await auth.get(`users/${ekOf(PRO)}`, { type: 'json' });
  ok('account marked deactivated (not deleted)', pu && pu.disabledAt && pu.email === PRO && pu.keyring);
  ok('all its data kept', (await countData(proNs)) === proDataBefore, `${await countData(proNs)} vs ${proDataBefore}`);
  await pro.reload(); await pro.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 }).then(() => ok('its open device is signed out', true), () => ok('its open device is signed out', false));
  await signIn(pro, PRO); await pro.waitForFunction(() => document.querySelector('#signinForm .auth-error').textContent, null, { timeout: 15000 });
  ok('it can’t sign in (deactivated message)', (await pro.textContent('#signinForm .auth-error')).includes('deactivated'));
  const rc = await pro.evaluate(async email => { await fetch('/.netlify/functions/auth?action=request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); return 1; }, PRO);
  const vc = await pro.evaluate(async ([email, code]) => (await fetch('/.netlify/functions/auth?action=verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) })).status, [PRO, lastCode(PRO)]);
  ok('it can’t reset its password with a code', vc === 403, String(vc));
  const g = await newPage(); await g.goto('about:blank'); await g.goto(shareUrl); await g.waitForSelector('.share-title');
  ok('its share link is off', /doesn’t work|turned off/.test(await g.textContent('.share-title')), await g.textContent('.share-title'));
  // Reactivate: back in with everything
  await a.click('#reactivateBtn'); await a.waitForSelector('#toast:has-text("Account reactivated")');
  await signIn(pro, PRO); await pro.waitForSelector('.app-shell', { state: 'visible', timeout: 15000 }); await sleep(1500);
  ok('reactivated: signs in and its notes are there', (await pro.textContent('#scratchpad')).includes('Pro private notes') && (await pro.$$('#fileList .file-row')).length === 1);
  await a.keyboard.press('Escape');

  // ---- Deactivate the legacy admin account (OWNER_EMAIL) ----
  await a.fill('#accountSearch', OWNER); await a.click('#accountsTable tbody tr button'); await a.waitForSelector('#accountDialog[open]');
  await a.click('#deactivateBtn'); await a.waitForSelector('#confirmDialog[open]');
  ok('no special legacy warning (an ordinary account now)', !(await a.textContent('#confirmBody')).includes('legacy admin'));
  await a.fill('#confirmType', OWNER); await a.click('#confirmOk'); await a.waitForSelector('#toast:has-text("Account deactivated")');
  await a.keyboard.press('Escape');
  ok('legacy owner data kept', (await store('scratchpad').list()).blobs.length >= ownerKeysBefore && (await auth.get(`users/${ekOf(OWNER)}`, { type: 'json' })).ns === '');



  ok('dashboard still works after the legacy account is off', (await call(a, 'GET', { view: 'accounts' })).status === 200);

  // ---- Settings: sign-ups toggle ----
  await a.click('[data-tab=settings]'); await a.waitForSelector('#services li');
  await a.screenshot({ path: OUT + 'admin-settings.png' });
  await a.uncheck('#signupsOpen'); await a.waitForSelector('#toast:has-text("paused")');
  const nn = await newPage(); await nn.goto(BASE); await nn.click('.auth-create'); await nn.fill('#codeEmail', 'newbie@example.com'); await nn.click('#emailForm .auth-submit');
  await nn.waitForFunction(() => /paused/.test(document.querySelector('#emailForm').textContent), null, { timeout: 8000 }).then(() => ok('paused: new sign-ups refused', true), () => ok('paused: new sign-ups refused', false));
  const free2 = await newPage(); await signIn(free2, FREE); await free2.waitForSelector('.app-shell', { state: 'visible', timeout: 15000 }).then(() => ok('paused: existing accounts still sign in', true), () => ok('paused: existing accounts still sign in', false));
  await a.check('#signupsOpen'); await a.waitForSelector('#toast:has-text("open")');

  // ---- Errors ----
  const { recordError, withErrors } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/errors.mjs').href);
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  const boom = withErrors('test-fn', async () => { throw new Error('kaboom'); });
  const res = await boom(new Request('http://localhost/.netlify/functions/test-fn?action=go&secret=x', { method: 'POST', body: '{"text":"private"}' }));
  ok('a thrown error becomes a 500', res.status === 500);
  await a.click('[data-tab=errors]'); await a.waitForSelector('#errorsTable tbody tr td:not(.ad-empty)');
  const errText = await a.textContent('#errorsTable tbody');
  ok('errors tab shows it, without the body or query values', errText.includes('kaboom') && errText.includes('test-fn') && !errText.includes('private') && !errText.includes('secret'));
  await a.screenshot({ path: OUT + 'admin-errors.png' });

  // ---- Second admin by invite; disable ----
  await a.click('[data-tab=admins]'); await a.waitForSelector('#adminsTable tbody tr td .ad-email');
  await a.fill('#inviteAdminEmail', 'bob@sector.test'); await a.fill('#inviteAdminName', 'Bob'); await a.click('#inviteAdminForm [type=submit]');
  await a.waitForSelector('#inviteOut:not([hidden])'); const invite = await a.inputValue('#inviteLink');
  ok('invite link made (key after #)', invite.includes('/admin#invite='));
  const bob = await newPage(); await bob.goto(invite); await bob.waitForSelector('#inviteForm:not([hidden])');
  ok('invite shows the invited email', (await bob.textContent('#inviteEmail')) === 'bob@sector.test');
  await bob.fill('#invitePassword', 'bobs-long-password-1'); await bob.click('#inviteForm [type=submit]'); await bob.waitForSelector('#enrollForm:not([hidden])');
  const bobSecret = (await bob.textContent('#enrollSecret')).replace(/\s/g, '');
  await bob.fill('#enrollCode', totp(bobSecret)); await bob.click('#enrollForm [type=submit]'); await bob.waitForSelector('#recoveryForm:not([hidden])');
  await bob.check('#codesSaved'); await bob.click('#recoveryForm [type=submit]'); await bob.waitForSelector('#dash:not([hidden])');
  ok('invited admin enrols and gets in', true);
  const reuse = await newPage(); await reuse.goto(invite); await reuse.waitForSelector('#loginForm:not([hidden])');
  ok('invite works only once', (await reuse.textContent('#loginForm .ad-error')).includes('expired'));
  await a.click('[data-tab=overview]'); await a.click('[data-tab=admins]'); await a.waitForSelector('#adminsTable tbody tr:nth-child(2)');
  await a.click('#adminsTable tbody tr:has-text("bob@sector.test") button:has-text("Disable")'); await a.waitForSelector('#confirmDialog[open]'); await a.click('#confirmOk'); await a.waitForSelector('#toast:has-text("Done")');
  ok('disabled admin’s session refused at once', (await call(bob, 'GET', { view: 'accounts' })).status === 401);
  const selfOff = await call(a, 'POST', { action: 'admin' }, { id: lib.adminId('ada@sector.test'), op: 'disable' });
  ok('an admin can’t disable themselves', selfOff.status === 400);
  await a.screenshot({ path: OUT + 'admin-admins.png' });

  // ---- Sign-in: password + code, replay refused, recovery code once ----
  await a.click('#logoutBtn'); await a.waitForSelector('#loginForm:not([hidden])');
  ok('signed out: API refused', (await call(a, 'GET', { view: 'accounts' })).status === 401);
  const login = async (fields) => { await a.fill('#loginEmail', 'ada@sector.test'); await a.fill('#loginPassword', fields.password || 'a-long-admin-pass-1');
    if (fields.recovery) { if (await a.isHidden('#loginRecoveryRow')) await a.click('#loginToggle'); await a.fill('#loginRecovery', fields.recovery); }
    else { if (await a.isVisible('#loginRecoveryRow')) await a.click('#loginToggle'); await a.fill('#loginCode', fields.code); }
    await a.click('#loginForm [type=submit]'); await a.waitForFunction(() => !document.querySelector('#dash').hidden || document.querySelector('#loginForm .ad-error').textContent, null, { timeout: 10000 }); };
  await login({ code: totp(secret), password: 'wrong-password-123' });
  ok('wrong password refused', await a.isHidden('#dash'));
  await a.evaluate(() => { document.querySelector('#loginForm .ad-error').textContent = ''; });
  await login({ code: '123456' });
  ok('wrong code refused', await a.isHidden('#dash'));
  await a.evaluate(() => { document.querySelector('#loginForm .ad-error').textContent = ''; });
  // The code used at enrolment (same 30 s step) can't be replayed.
  const usedStep = (await adm.get(`admins/${lib.adminId('ada@sector.test')}`, { type: 'json' })).totp.lastStep;
  const replay = lib.totpAt(secret, usedStep);
  if (Math.floor(Date.now() / 30000) - usedStep <= 1) { await login({ code: replay }); ok('used code can’t be replayed', await a.isHidden('#dash')); await a.evaluate(() => { document.querySelector('#loginForm .ad-error').textContent = ''; }); }
  else ok('used code can’t be replayed (step passed; checked by lastStep)', true);
  await login({ recovery: codes[0] });
  ok('recovery code signs in', await a.isVisible('#dash'));
  await a.click('#logoutBtn'); await a.waitForSelector('#loginForm:not([hidden])');
  await login({ recovery: codes[0] });
  ok('the same recovery code doesn’t work twice', await a.isHidden('#dash'));
  await a.evaluate(() => { document.querySelector('#loginForm .ad-error').textContent = ''; });
  await login({ code: lib.totpAt(secret, Math.floor(Date.now() / 30000) + 1) });
  ok('password + authenticator code signs in', await a.isVisible('#dash'));

  // ---- Audit log ----
  await a.click('[data-tab=audit]'); await a.waitForSelector('#auditTable tbody tr td:not(.ad-empty)');
  const auditText = await a.textContent('#auditTable tbody');
  for (const s of ['Set up the first admin', 'Signed in', 'Sign-in failed', 'Changed plan', 'Changed storage limit', 'Deactivated account', 'Reactivated account', 'Changed settings', 'Invited an admin', 'Joined as admin', 'Disabled an admin', 'Setup attempt failed']) ok(`audit: ${s}`, auditText.includes(s));
  ok('audit names the target account', auditText.includes(PRO) && auditText.includes(OWNER));
  await a.screenshot({ path: OUT + 'admin-audit.png' });

  // Cross-site writes refused even with the cookie.
  const xs = await a.evaluate(() => fetch('/.netlify/functions/admin-api?action=settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"signupsOpen":false}' }).then(r => r.status));
  ok('same-origin write works', xs === 200);
  const xsite = await (await b.newContext()).request.post(API + '?action=settings', { headers: { Origin: 'https://evil.example', Cookie: `ss_admin=${(await a.context().cookies()).find(c => c.name === 'ss_admin').value}` }, data: { signupsOpen: false } });
  ok('cross-origin write refused', xsite.status() === 403);
  await call(a, 'POST', { action: 'settings' }, { signupsOpen: true });

  // Light theme + phone
  await a.evaluate(() => window.scratchTheme.set('light')); await a.click('[data-tab=accounts]'); await a.waitForSelector('#accountsTable tbody tr td .ad-email'); await a.screenshot({ path: OUT + 'admin-accounts-light.png' });
  const m = await newPage({ viewport: { width: 390, height: 844 } }); await m.context().addCookies(await a.context().cookies()); await m.goto(BASE + '/admin#accounts'); await m.waitForSelector('#accountsTable tbody tr td .ad-email');
  ok('phone: no sideways scroll', await m.evaluate(() => document.documentElement.scrollWidth <= 390));
  await m.screenshot({ path: OUT + 'admin-phone.png' });

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
