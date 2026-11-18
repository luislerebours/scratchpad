// Inactive links: hidden until "See inactive links", each with why it ended.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'reasons' + Date.now() + '@example.com';
(async () => {
  const { getStore } = await import(REPO + '/node_modules/@netlify/blobs/dist/main.js');
  const shares = getStore({ name: 'scratchpad-shares', siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await p.setInputFiles('#fileInput', ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(n => ({ name: n, mimeType: 'text/plain', buffer: Buffer.from(n) })));
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 4, null, { timeout: 20000 });
  const share = async name => {
    await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click('.menu-item:has-text("Share link")');
    await p.waitForSelector('[data-share-create]'); await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
    const u = await p.inputValue('#shareUrlInput'); await p.keyboard.press('Escape'); await sleep(400);
    return u.split('/s/')[1].split('#')[0];
  };
  await share('a.txt');
  // A second link for the same file (as another device might make): the first is replaced.
  const aId = await p.getAttribute('#fileList .file-row:has-text("a.txt")', 'data-id');
  const made = await p.evaluate(id => fetch('/.netlify/functions/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', kind: 'file', sheet: 1, file: id, days: 7 }) }).then(r => r.status), aId);
  ok('second link for the same file made', made === 200, String(made));
  await share('b.txt');                       // turned off by you, below
  const tc = await share('c.txt');            // expired
  const td = await share('d.txt');            // account deactivated
  const rc = await shares.get(`shares/${tc}`, { type: 'json' }); await shares.setJSON(`shares/${tc}`, { ...rc, expiresAt: Date.now() - 1000 });
  const rd = await shares.get(`shares/${td}`, { type: 'json' }); await shares.setJSON(`shares/${td}`, { ...rd, revoked: true, revokedAt: Date.now(), revokedBy: 'admin' });
  await p.click('#accountBtn'); await p.click('[data-pf="library"]'); await p.click('#libTabLinks'); await p.waitForSelector('#linksBody tbody tr');
  await p.click('#linksBody tbody tr:has-text("b.txt") [data-link-off]'); await sleep(900);
  const active = await p.$$eval('#linksBody tbody tr', r => r.map(x => x.querySelector('.lib-name').textContent));
  ok('only active links show at first', JSON.stringify(active) === '["a.txt"]', JSON.stringify(active));
  ok('a "See inactive links (4)" button', (await p.textContent('[data-links-inactive]')).trim() === 'See inactive links (4)' && (await p.getAttribute('[data-links-inactive]', 'aria-expanded')) === 'false');
  await p.screenshot({ path: OUT + 'lr-active.png' });
  await p.click('[data-links-inactive]');
  const why = Object.fromEntries(await p.$$eval('#inactiveLinks tbody tr', r => r.map(x => [x.querySelector('.lib-name').textContent, x.querySelectorAll('td')[3].innerText.trim()])));
  ok('replaced', /^Replaced by a newer link · /.test(why['a.txt'] || ''), JSON.stringify(why));
  ok('turned off by you', /^Turned off by you · /.test(why['b.txt'] || ''));
  ok('expired', /^Expired · /.test(why['c.txt'] || ''));
  ok('account deactivated', /^Turned off when the account was deactivated/.test(why['d.txt'] || ''));
  ok('inactive rows have no actions', (await p.$$('#inactiveLinks [data-link-copy], #inactiveLinks [data-link-off]')).length === 0);
  ok('button now says Hide', (await p.textContent('[data-links-inactive]')).startsWith('Hide') && (await p.getAttribute('[data-links-inactive]', 'aria-expanded')) === 'true');
  ok('focus stays on the button', await p.evaluate(() => document.activeElement?.dataset.linksInactive !== undefined));
  await p.screenshot({ path: OUT + 'lr-inactive.png' });
  await p.click('[data-links-inactive]');
  ok('Hide hides them again', !(await p.$('#inactiveLinks')));
  // Phone
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); m.on('pageerror', e => errs.push('phone: ' + e.message));
  await m.goto(BASE); await m.fill('#signinEmail', E); await m.fill('#signinPassword', 'pass-12345'); await m.click('#signinForm .auth-submit');
  await m.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  await m.click('#accountBtn'); await m.click('[data-pf="library"]'); await m.click('#libTabLinks'); await m.waitForSelector('#linksBody tbody tr');
  await m.click('[data-links-inactive]'); await sleep(200);
  ok('phone: reasons shown under each name', (await m.innerText('#inactiveLinks')).includes('Replaced by a newer link'));
  await m.screenshot({ path: OUT + 'lr-phone.png' });
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
