// Google Play Billing in the Android app: the page buys through (a stand-in for)
// Google Play; the server checks with (a stand-in for) Google, acknowledges,
// links and sets Pro; Google's notices renew, cancel and expire it; the web
// keeps Stripe; restore on a new install; deleting the account cancels it.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; const MOCK = 'http://localhost:8972'; 
const log = () => fs.readFileSync(__dirname + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const stamp = Date.now();
const A = `playa${stamp}@example.com`, B = `playb${stamp}@example.com`, C = `playc${stamp}@example.com`;
const mock = async (path, body) => (await fetch(MOCK + path, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
const rtdn = (note, key = 'local-rtdn-secret-0123456789') => fetch(`${BASE}/.netlify/functions/play?action=rtdn&key=${key}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.sector809labs.scrapsheet', eventTimeMillis: String(Date.now()), ...note })).toString('base64'), messageId: String(Math.random()) }, subscription: 'projects/x/subscriptions/y' })
});
const subNote = (token, type) => ({ subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } });

// What Chrome gives the Android app: Google Play's Digital Goods service and Payment Request.
function fakePlay(owned) {
  const PLAY = 'https://play.google.com/billing';
  window.__owned = owned || [];
  window.getDigitalGoodsService = async method => {
    if (method !== PLAY) throw new Error('unsupported');
    return {
      getDetails: async ids => ids.map(id => ({ itemId: id, title: id, price: { currency: 'USD', value: id.endsWith('year') ? '9.99' : '0.99' } })),
      listPurchases: async () => window.__owned.map(o => ({ itemId: o.productId, purchaseToken: o.token }))
    };
  };
  const Real = window.PaymentRequest;
  window.PaymentRequest = function (methods, details) {
    if (methods[0].supportedMethods !== PLAY) return new Real(methods, details);
    const sku = methods[0].data.sku;
    return {
      show: async () => {
        window.__shown = sku;
        if (window.__userCancels) throw new DOMException('The user closed the sheet', 'AbortError');
        const r = await fetch('http://localhost:8972/__buy', { method: 'POST', body: JSON.stringify({ productId: sku, pending: Boolean(window.__pending) }) });
        const { token } = await r.json();
        window.__lastToken = token;
        return { details: { purchaseToken: token }, complete: async s => { window.__completed = s; } };
      }
    };
  };
}

async function signUp(p, email, url) {
  await p.goto(url); await p.tap('.auth-create'); await p.fill('#codeEmail', email); await p.tap('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(email)); await p.tap('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.tap('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.tap('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
}
const me = p => p.evaluate(async () => (await (await fetch('/.netlify/functions/auth', { cache: 'no-store' })).json()).plan);
const toast = p => p.textContent('#toast');

(async () => {
  const b = await chromium.launch(); const errs = [];
  const appContext = async (owned) => {
    const ctx = await b.newContext({ ...devices['Pixel 7'] });
    await ctx.addInitScript(fakePlay, owned || []);
    await ctx.route('https://play.google.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Google Play</title>Subscriptions' }));
    return ctx;
  };

  // ---- In the app: buy Pro through Google Play ----
  const ctx = await appContext();
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await signUp(p, A, BASE + '/?source=twa');
  ok('the app’s ?source=twa is tidied from the address', !p.url().includes('source='), p.url());
  ok('starts on Free', (await me(p)).plan === 'free');
  await p.tap('#accountBtn'); await p.tap('[data-pf="upgrade"]');
  await p.waitForSelector('#sheetModal:not([hidden])');
  const text = await p.textContent('#sheetText');
  ok('the offer says Google Play', text.includes('Billed through Google Play'), text);
  const labels = await p.$$eval('#sheetActions button', bs => bs.map(x => x.textContent));
  ok('…with Google’s prices', JSON.stringify(labels) === JSON.stringify(['$0.99 / month', '$9.99 / year · save 16%', 'Not now']), JSON.stringify(labels));
  await p.screenshot({ path: OUT + 'play-upgrade.png' });
  // Closing Google's sheet changes nothing
  await p.evaluate(() => { window.__userCancels = true; });
  await p.tap('#sheetActions button:has-text("/ month")'); await sleep(500);
  ok('closing Google Play’s sheet: "No changes made"', (await toast(p)) === 'No changes made' && (await me(p)).plan === 'free');
  await p.evaluate(() => { window.__userCancels = false; });
  await p.tap('#accountBtn'); await p.tap('[data-pf="upgrade"]'); await p.waitForSelector('#sheetModal:not([hidden])');
  await p.tap('#sheetActions button:has-text("/ month")');
  await p.waitForFunction(() => document.querySelector('#toast').textContent === 'Welcome to Pro', null, { timeout: 15000 })
    .then(() => ok('buying: "Welcome to Pro"', true), () => ok('buying: "Welcome to Pro"', false));
  const token = await p.evaluate(() => window.__lastToken);
  const planA = await me(p);
  ok('the account is Pro, billed through Google Play, monthly', planA.plan === 'pro' && planA.billing?.source === 'play' && planA.billing.interval === 'month' && !planA.billing.cancelsAtEnd, JSON.stringify(planA.billing));
  ok('Google Play was told the purchase completed', (await p.evaluate(() => window.__completed)) === 'success');
  ok('the server acknowledged it with Google (no automatic refund)', (await mock(`/__get?token=${encodeURIComponent(token)}`)).acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
  await p.tap('#accountBtn'); await sleep(300);
  ok('the menu shows Pro with Manage billing', (await p.textContent('.pf-badge')) === 'Pro' && await p.isVisible('[data-pf="billing"]'));
  await p.screenshot({ path: OUT + 'play-pro-menu.png' });
  await Promise.all([p.waitForURL(/play\.google\.com/), p.tap('[data-pf="billing"]')]);
  ok('Manage billing opens the Play Store subscription', p.url() === 'https://play.google.com/store/account/subscriptions?sku=scrapsheet_pro_month&package=com.sector809labs.scrapsheet', p.url());
  // The app stays the app after a reload without ?source=twa
  await p.goto(BASE + '/'); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(500);
  ok('still the app after moving around (kept for the session)', await p.evaluate(() => sessionStorage.getItem('scrapsheet-android-app') === '1'));

  // ---- The same account on the web: Stripe offer, Play billing link ----
  const web = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); web.on('pageerror', e => errs.push(e.message));
  await web.goto(BASE); await web.fill('#signinEmail', A); await web.fill('#signinPassword', 'pass-12345'); await web.click('#signinForm .auth-submit');
  await web.waitForSelector('.app-shell', { state: 'visible' }); await sleep(500);
  ok('on the web the same account is Pro', (await me(web)).plan === 'pro');
  ok('the web isn’t treated as the app', !(await web.evaluate(() => 'getDigitalGoodsService' in window)) && !(await web.evaluate(() => sessionStorage.getItem('scrapsheet-android-app'))));

  // ---- Google's notices ----
  ok('a notice with the wrong key is refused', (await rtdn(subNote(token, 2), 'wrong')).status === 403);
  ok('a notice for another app is ignored', (await (await fetch(`${BASE}/.netlify/functions/play?action=rtdn&key=local-rtdn-secret-0123456789`, { method: 'POST', body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ packageName: 'com.other', subscriptionNotification: { notificationType: 2, purchaseToken: token } })).toString('base64') } }) })).json()).ignored === 'not ours');
  ok('Play Console’s test notice is fine', (await (await rtdn({ testNotification: { version: '1.0' } })).json()).test === true);
  await mock('/__set', { token, subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false, expiresInDays: 12 });
  let r = await (await rtdn(subNote(token, 3))).json();
  let plan = await me(web);
  ok('cancelled in the Play Store: still Pro until the paid time ends', r.plan === 'pro' && plan.plan === 'pro' && plan.billing.cancelsAtEnd === true, JSON.stringify(plan.billing));
  await mock('/__set', { token, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', autoRenew: true, expiresInDays: 30 });
  await rtdn(subNote(token, 7));
  ok('restored in the Play Store: renews again', (await me(web)).billing.cancelsAtEnd === false);
  await mock('/__set', { token, subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' });
  await rtdn(subNote(token, 5));
  ok('payment on hold: back to Free (nothing deleted)', (await me(web)).plan === 'free');
  await mock('/__set', { token, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', expiresInDays: 30 });
  await rtdn(subNote(token, 1));
  ok('recovered: Pro again', (await me(web)).plan === 'pro');
  await mock('/__set', { token, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', autoRenew: false, expiresInDays: -1 });
  await rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: 'GPA.1', productType: 1, refundType: 1 } });
  ok('refunded / expired: Free', (await me(web)).plan === 'free');
  ok('a notice for a purchase no account has yet is kept for later', (await (await rtdn(subNote((await mock('/__buy', { productId: 'scrapsheet_pro_year' })).token, 4))).json()).unknown === true);

  // ---- Another account can't take someone's purchase; a pending payment ----
  const ctxB = await appContext();
  const q = await ctxB.newPage(); q.on('pageerror', e => errs.push(e.message));
  await signUp(q, B, BASE + '/?source=twa');
  const taken = await q.evaluate(async t => { const r = await fetch('/.netlify/functions/play?action=verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) }); return [r.status, (await r.json()).error]; }, token);
  ok('someone else’s purchase is refused for this account', taken[0] === 409 && taken[1].includes('another ScrapSheet account'), JSON.stringify(taken));
  ok('a made-up purchase is refused', (await q.evaluate(async () => (await fetch('/.netlify/functions/play?action=verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'tok.not-a-real-purchase-token' }) })).status)) === 400);
  await q.evaluate(() => { window.__pending = true; });
  await q.tap('#accountBtn'); await q.tap('[data-pf="upgrade"]'); await q.waitForSelector('#sheetModal:not([hidden])');
  await q.tap('#sheetActions button:has-text("/ year")');
  await q.waitForFunction(() => document.querySelector('#toast').textContent.includes('pending'), null, { timeout: 15000 })
    .then(() => ok('a pending payment says so, and stays Free', true), () => ok('a pending payment says so, and stays Free', false));
  ok('…still Free meanwhile', (await me(q)).plan === 'free');
  const pendingToken = await q.evaluate(() => window.__lastToken);
  await mock('/__set', { token: pendingToken, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' });
  r = await (await rtdn(subNote(pendingToken, 4))).json();
  ok('when Google confirms it, the notice switches Pro on (yearly)', r.plan === 'pro' && (await me(q)).billing.interval === 'year', JSON.stringify(r));
  ok('…and it’s acknowledged then', (await mock(`/__get?token=${encodeURIComponent(pendingToken)}`)).acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');

  // ---- New install: a purchase this Google account already has is found ----
  const owned = await mock('/__buy', { productId: 'scrapsheet_pro_month' });
  const ctxC = await appContext([{ productId: 'scrapsheet_pro_month', token: owned.token }]);
  const c = await ctxC.newPage(); c.on('pageerror', e => errs.push(e.message));
  await signUp(c, C, BASE + '/?source=twa');
  await c.waitForFunction(() => document.querySelector('#toast').textContent.includes('you’re on Pro'), null, { timeout: 15000 })
    .then(() => ok('on a new install, an existing Play subscription is found: Pro', true), () => ok('on a new install, an existing Play subscription is found: Pro', false));
  ok('…the account is Pro', (await me(c)).plan === 'pro');

  // ---- Deleting the account stops Google Play charging ----
  await c.tap('#accountBtn'); await c.tap('[data-pf="security"]'); await c.tap('[data-pf="delete"]'); await c.waitForSelector('#deleteAccountModal:not([hidden])');
  await c.fill('#deleteAccountPassword', 'pass-12345'); await c.tap('#deleteAccountForm [type=submit]');
  await c.waitForFunction(() => !document.querySelector('#authScreen').hidden, null, { timeout: 20000 }); await sleep(500);
  const after = await mock(`/__get?token=${encodeURIComponent(owned.token)}`);
  ok('deleting the account cancels the Play subscription', after.lineItems[0].autoRenewingPlan.autoRenewEnabled === false && (await mock('/__log')).log.includes('cancel DEVELOPER_REQUESTED_STOP_PAYMENTS'));
  ok('…and the email says Pro was cancelled', new RegExp(`to ${C.replace(/[.+]/g, '\\$&')}: security deleted \\([^)]*\\) \\+cancelled`).test(log()));

  // ---- The web keeps Stripe ----
  const w2ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await w2ctx.route('https://play.google.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Google Play</title>' }));
  const w2 = await w2ctx.newPage();
  await w2.goto(BASE); await w2.fill('#signinEmail', B); await w2.fill('#signinPassword', 'pass-12345'); await w2.click('#signinForm .auth-submit');
  await w2.waitForSelector('.app-shell', { state: 'visible' }); await sleep(500);
  ok('the web shows B as Pro through Google Play', (await me(w2)).billing.source === 'play');
  await w2.click('#accountBtn'); await sleep(200);
  await Promise.all([w2.waitForURL(/play\.google\.com/).catch(() => null), w2.click('[data-pf="billing"]')]);
  ok('on the web, Manage billing for a Play subscription also goes to Google Play', w2.url().startsWith('https://play.google.com/store/account/subscriptions'), w2.url());

  ok('the server got Google access tokens with its key', (await mock('/__log')).issued >= 1);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
