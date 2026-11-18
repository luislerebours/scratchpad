// Security notices: sign out everywhere and delete account each send one email.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const log = () => fs.readFileSync(__dirname + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const notices = email => [...log().matchAll(/\[dev mail\] to (\S+): security (\S+) \(([^)]*)\)/g)].filter(x => x[1] === email).map(x => `${x[2]}|${x[3]}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'notice' + Date.now() + '@example.com';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.tap('.auth-create'); await p.fill('#codeEmail', E); await p.tap('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.tap('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.tap('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.tap('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  ok('a new account gets no security notice', notices(E).length === 0, notices(E).join());

  await p.tap('#accountBtn'); await p.tap('[data-pf="security"]'); await p.tap('[data-pf="signout-all"]');
  await p.tap('#sheetModal button:has-text("Sign out everywhere")');
  await p.waitForSelector('#authScreen:not([hidden])', { timeout: 15000 }); await sleep(500);
  ok('sign out everywhere: one notice, with the device', JSON.stringify(notices(E)) === JSON.stringify(['signout-all|Safari on iPhone']), notices(E).join());

  await p.fill('#signinEmail', E); await p.fill('#signinPassword', 'pass-12345'); await p.tap('#signinForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  ok('signing in again sends nothing', notices(E).length === 1);
  await p.tap('#accountBtn'); await p.tap('[data-pf="security"]'); await p.tap('[data-pf="delete"]'); await p.waitForSelector('#deleteAccountModal:not([hidden])');
  await p.fill('#deleteAccountPassword', 'wrong-pass-9'); await p.tap('#deleteAccountForm [type=submit]'); await sleep(2500);
  ok('a wrong password sends nothing', notices(E).length === 1);
  await p.fill('#deleteAccountPassword', 'pass-12345'); await p.tap('#deleteAccountForm [type=submit]');
  await p.waitForFunction(() => !document.querySelector('#authScreen').hidden, null, { timeout: 20000 }); await sleep(800);
  ok('delete account: one notice', notices(E).at(-1) === 'deleted|Safari on iPhone' && notices(E).length === 2, notices(E).join());

  // What the emails look like
  const { renderEmail } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/email.mjs').href);
  const shots = [];
  for (const [kind, c] of Object.entries({
    password: { heading: 'Your password was changed', intro: 'The password for your ScrapSheet account was just changed, and every other device was signed out.', box: { title: 'When and where', body: 'Nov 17, 2026, 7:42 PM UTC · Safari on iPhone' }, button: { label: 'Open ScrapSheet', url: '#' }, note: 'Wasn’t you? Reset your password right away (“Forgot password?” on the sign-in page) and email support@sector809labs.com.' },
    deleted: { heading: 'Your account was deleted', intro: 'Your ScrapSheet account and everything in it were permanently deleted. Your Pro subscription was cancelled too, so you won’t be charged again.', box: { title: 'When and where', body: 'Nov 17, 2026, 7:45 PM UTC · Chrome on Windows' }, note: 'If you didn’t do this, email support@sector809labs.com right away. Thanks for using ScrapSheet.' }
  })) {
    const { html } = renderEmail({ subject: 's', ...c }, BASE);
    const e = await b.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 2 });
    await e.setContent(html); await sleep(400);
    await e.screenshot({ path: OUT + `notice-${kind}.png`, fullPage: true }); shots.push(kind); await e.close();
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
