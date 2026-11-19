// A new share link on a phone: the share menu opens in the same tap as "Create link"
// (iOS refuses once anything has waited), the link is saved meanwhile, and no link
// that was handed to the share menu is left not working without saying so.
// Also the viewer: a link opened a moment before it's saved, and password links
// whose password was removed or whose key part is missing.
const { chromium, devices } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'firsttap' + Date.now() + '@example.com';
const CREATE = /functions\/share$/;

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 14 Pro'] });
  // A stand-in for the iOS share menu: it opens only if asked in the same turn as the tap
  // (a tap's permission is gone once anything has waited), and records what it was given.
  await ctx.addInitScript(() => {
    window.__shared = []; window.__refused = 0; let inTap = false;
    document.addEventListener('click', () => { inTap = true; setTimeout(() => { inTap = false; }, 0); }, true);
    navigator.share = async data => {
      if (!inTap) { window.__refused++; throw new DOMException('Must be handling a user gesture', 'NotAllowedError'); }
      window.__shared.push({ url: data.url, title: data.title });
    };
  });
  const A = await ctx.newPage(); A.on('pageerror', e => errs.push(e.message));
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  const names = ['one.pdf', 'two.pdf', 'three.pdf', 'four.pdf', 'five.pdf', 'six.pdf', 'seven.pdf'];
  await A.setInputFiles('#fileInput', names.map(name => ({ name, mimeType: 'application/pdf', buffer: crypto.randomBytes(20_000) })));
  await A.waitForFunction(n => document.querySelectorAll('#fileList .file-row').length === n, names.length, { timeout: 60000 }); await sleep(2600);

  const shared = () => A.evaluate(() => window.__shared);
  const reset = () => A.evaluate(() => { window.__shared = []; window.__refused = 0; });
  const openBox = async name => {
    await A.keyboard.press('Escape'); await sleep(200);
    await A.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await A.click('.menu-item:has-text("link")');
    await A.waitForSelector('[data-share-create]'); await sleep(500); await reset();
  };
  // What the receiver sees: the page's title line, after typing a password if asked.
  const receive = async (url, password, wait = 1500) => {
    const v = await (await b.newContext({ ...devices['iPhone 14 Pro'] })).newPage();
    await v.goto(url); await sleep(wait);
    const asked = await v.$('#sharePw') !== null;
    let wrong = '';
    if (asked && password) {
      if (Array.isArray(password)) { await v.fill('#sharePw', password[0]); await v.keyboard.press('Enter'); await sleep(2500); wrong = (await v.textContent('#sharePwError').catch(() => '')) || ''; password = password[1]; }
      await v.fill('#sharePw', password); await v.keyboard.press('Enter'); await sleep(2500);
    }
    const title = ((await v.textContent('.share-title').catch(() => '')) || '').trim();
    await v.context().close(); return { title, asked, wrong };
  };

  // ---- 1. A plain link ----
  await openBox('one.pdf');
  await A.click('[data-share-create]');
  const atOnce = await shared();
  ok('the share menu opens in the same tap as Create link', atOnce.length === 1 && (await A.evaluate(() => window.__refused)) === 0, JSON.stringify(atOnce).slice(0, 80));
  const url1 = atOnce[0]?.url || ''; const token1 = url1.split('/s/')[1]?.split('#')[0] || '';
  ok('…with a whole link: an address the phone picked and the key after #', /^[A-Za-z0-9_-]{24}$/.test(token1) && /#[A-Za-z0-9_-]{40,}$/.test(url1) && atOnce[0].title === 'one.pdf', url1.slice(0, 60));
  await A.waitForSelector('#shareUrlInput', { timeout: 15000 });
  ok('the box then shows that same link', (await A.inputValue('#shareUrlInput')) === url1);
  ok('the receiver opens it', (await receive(url1)).title === 'one.pdf');

  // ---- 2. A link with a password: its slow key work is done while typing ----
  await openBox('two.pdf');
  await A.click('.share-pw-box summary'); await A.fill('#sharePwNew', 'blue-river'); await sleep(4000); await reset();
  await A.click('[data-share-create]');
  const pwAtOnce = await shared(); const url2 = pwAtOnce[0]?.url || '';
  ok('a password link also opens the share menu in the same tap', pwAtOnce.length === 1 && url2.includes('#p.'), url2.slice(0, 70));
  await A.waitForSelector('#shareUrlInput', { timeout: 15000 });
  ok('…and the box shows that same protected link', (await A.inputValue('#shareUrlInput')) === url2 && (await A.textContent('#shareBody')).includes('Password protected'));
  const r2 = await receive(url2, 'blue-river');
  ok('the receiver is asked for the password, and it opens', r2.asked && r2.title === 'two.pdf', JSON.stringify(r2));

  // ---- 3. Tapped before the password's key work is done: the slower way, still a working link ----
  await openBox('three.pdf');
  await A.click('.share-pw-box summary'); await A.fill('#sharePwNew', 'quick-tap-1'); await reset();
  await A.click('[data-share-create]');
  await A.waitForSelector('#shareUrlInput', { timeout: 20000 }); await sleep(400);
  ok('not ready yet: no half-made link goes to the share menu', (await shared()).length === 0);
  await A.click('[data-share-send]'); await sleep(300);
  const url3 = (await shared())[0]?.url || '';
  ok('…Share… then sends it, and it opens with the password', url3.includes('#p.') && (await receive(url3, 'quick-tap-1')).title === 'three.pdf');

  // ---- 4. The save fails twice (no connection), then gets through ----
  await openBox('four.pdf');
  let drops = 2;
  await A.route(CREATE, route => (route.request().method() === 'POST' && drops-- > 0 ? route.abort('internetdisconnected') : route.continue()));
  await A.click('[data-share-create]');
  const url4 = (await shared())[0]?.url || '';
  await A.waitForSelector('#shareUrlInput', { timeout: 30000 });
  await A.unroute(CREATE);
  ok('a save that fails is tried again until it gets through', drops < 0 && (await A.inputValue('#shareUrlInput')) === url4);
  ok('…and the link that was sent opens', (await receive(url4)).title === 'four.pdf');

  // ---- 5. The server saved it but its answer was lost: trying again gives the same link ----
  await openBox('five.pdf');
  let lost = 1;
  await A.route(CREATE, async route => {
    if (route.request().method() === 'POST' && lost-- > 0) { await route.fetch(); return route.abort('internetdisconnected'); }
    return route.continue();
  });
  await A.click('[data-share-create]');
  const url5 = (await shared())[0]?.url || '';
  await A.waitForSelector('#shareUrlInput', { timeout: 30000 });
  await A.unroute(CREATE);
  ok('a lost answer: the second try gets the same link back, not an error', (await A.inputValue('#shareUrlInput')) === url5 && (await A.textContent('#shareBody')).includes('Not opened yet'));
  ok('…and it opens', (await receive(url5)).title === 'five.pdf');

  // ---- 6. The receiver opens it a moment before it's saved ----
  await openBox('six.pdf');
  await A.route(CREATE, async route => { if (route.request().method() === 'POST') await sleep(3500); return route.continue(); });
  await A.click('[data-share-create]');
  const url6 = (await shared())[0]?.url || '';
  const early = await receive(url6, null, 7000);
  await A.waitForSelector('#shareUrlInput', { timeout: 30000 });
  await A.unroute(CREATE);
  ok('a link opened before its save lands waits for it instead of saying it doesn’t work', early.title === 'six.pdf', early.title);

  // ---- 7. The server refuses: the box says the link wasn't saved ----
  await openBox('seven.pdf');
  await A.route(CREATE, route => (route.request().method() === 'POST' ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'That is no longer here to share.' }) }) : route.continue()));
  await A.click('[data-share-create]');
  const url7 = (await shared())[0]?.url || '';
  await A.waitForSelector('#shareNotSaved:not([hidden])', { timeout: 15000 });
  await A.unroute(CREATE);
  ok('refused by the server: a warning that the link wasn’t saved and won’t open', (await A.textContent('#shareNotSaved')).includes('wasn’t saved') && await A.$('[data-share-create]') !== null);
  const api = await A.request.get(`${BASE}/.netlify/functions/share?t=${url7.split('/s/')[1].split('#')[0]}`);
  ok('…(that link really doesn’t exist)', api.status() === 404);
  await A.click('[data-share-create]'); await A.waitForSelector('#shareUrlInput', { timeout: 15000 });
  const url7b = (await shared()).pop().url;
  ok('…and Create link again makes a new one that works', url7b !== url7 && (await receive(url7b)).title === 'seven.pdf');

  // ---- The server checks the address a page picks ----
  const post = body => A.evaluate(async body => { const r = await fetch('/.netlify/functions/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r.status; }, body);
  ok('an address of the wrong shape is refused', (await post({ action: 'create', kind: 'sheet', sheet: 1, days: 7, token: 'too-short' })) === 400);
  ok('an address already used for something else is refused', (await post({ action: 'create', kind: 'sheet', sheet: 1, days: 7, token: token1 })) === 409);
  ok('…and that link still opens', (await receive(url1)).title === 'one.pdf');

  // ---- A link made without a password: one added later, same link ----
  const toast = text => A.waitForFunction(t => document.querySelector('#toast')?.textContent.includes(t), text, { timeout: 20000 });
  const boxFor = async name => {
    await A.keyboard.press('Escape'); await sleep(200);
    await A.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await A.click('.menu-item:has-text("link")');
    await A.waitForSelector('#shareUrlInput'); await sleep(300);
  };
  await boxFor('one.pdf');
  await A.click('[data-share-pw="set"]'); await A.fill('#sharePwEdit', 'later-pass'); await A.click('[data-share-pw="save"]');
  await toast('Password saved'); await sleep(300);
  ok('adding a password later keeps the same link', (await A.inputValue('#shareUrlInput')) === url1);
  const late = await receive(url1, ['nope-nope', 'later-pass']);
  ok('…the link sent before now asks for it, and opens', late.asked && late.wrong.includes('isn’t right') && late.title === 'one.pdf', JSON.stringify(late));
  await A.click('[data-share-pw="remove"]'); await toast('Password removed'); await sleep(300);
  const freed = await receive(url1);
  ok('…and removing it again: same link, no password', (await A.inputValue('#shareUrlInput')) === url1 && !freed.asked && freed.title === 'one.pdf', JSON.stringify(freed));

  // ---- A link made with a password: changed, then removed, same link ----
  await boxFor('two.pdf');
  await A.click('[data-share-pw="set"]'); await A.fill('#sharePwEdit', 'red-canyon'); await A.click('[data-share-pw="save"]');
  await toast('Password saved'); await sleep(300);
  const changed = await receive(url2, ['blue-river', 'red-canyon']);
  ok('changing the password: the link sent before opens with the new one, not the old', (await A.inputValue('#shareUrlInput')) === url2 && changed.wrong.includes('isn’t right') && changed.title === 'two.pdf', JSON.stringify(changed));
  await A.click('[data-share-pw="remove"]'); await toast('Password removed'); await sleep(300);
  const open2 = await receive(url2);
  ok('removing it: the link sent before opens without one', (await A.inputValue('#shareUrlInput')) === url2 && !open2.asked && open2.title === 'two.pdf', JSON.stringify(open2));

  // ---- Viewer: a password removed by a version of the app from before links stopped changing ----
  await boxFor('three.pdf');
  await post({ action: 'password', token: url3.split('/s/')[1].split('#')[0], password: null });
  const old = await receive(url3, ['wrong-one', 'quick-tap-1']);
  ok('a link whose password an older app removed still asks for it instead of “missing its key”', old.asked && old.wrong.includes('isn’t right') && old.title === 'three.pdf', JSON.stringify(old));

  // ---- Viewer: a password link that lost the part after # ----
  const bare = await receive(url4.split('#')[0].replace(url4.split('/s/')[1].split('#')[0], url5.split('/s/')[1].split('#')[0]), 'x');
  await boxFor('five.pdf'); await A.click('[data-share-pw="set"]'); await A.fill('#sharePwEdit', 'five-pass'); await A.click('[data-share-pw="save"]'); await toast('Password saved');
  const bare2 = await receive(url5.split('#')[0], 'five-pass');
  ok('a link without its key part says so', bare.title === 'This link is missing its key.', JSON.stringify(bare));
  ok('…and with a password on it, says so before asking for the password', !bare2.asked && bare2.title === 'This link is missing its key.', JSON.stringify(bare2));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
