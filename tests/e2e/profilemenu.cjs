// Profile menu redesign: main view, Account & security, Help & support,
// Files & share links (files across sheets, storage, links), desktop + phone,
// keyboard, and that another account can't see any of it.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';

const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const EMAIL = `maria.lopez${Date.now()}@example.com`;
const OTHER = `other${Date.now()}@example.com`;

async function signUp(page, email) {
  await page.goto(BASE); await page.click('.auth-create'); await page.fill('#codeEmail', email); await page.click('#emailForm .auth-submit');
  await page.waitForSelector('#codeForm:not([hidden])'); await page.fill('#codeInput', lastCode(email)); await page.click('#codeForm .auth-submit');
  await page.waitForSelector('#passwordForm:not([hidden])'); await page.fill('#newPassword', 'pass-12345'); await page.click('#passwordForm .auth-submit');
  await page.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await page.check('#recoverySaved'); await page.click('#recoveryKeyForm .auth-submit');
  await page.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
}
const pfText = p => p.textContent('#profilePanel');

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await signUp(p, EMAIL);

  // Files in two sheets, one renamed, and a share link
  await p.setInputFiles('#fileInput', [{ name: 'Quarterly report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(150000, 1) }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello there') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 20000 });
  await p.locator('.sheet-tab[data-sheet="2"]').click(); await sleep(600);
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); await p.fill('#renameInput', 'Travel'); await p.click('#renameForm button[type=submit]'); await sleep(600);
  await p.setInputFiles('#fileInput', [{ name: 'boarding-pass.png', mimeType: 'image/png', buffer: fs.readFileSync(REPO + '/public/assets/mark-light.png') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 20000 });
  await p.click('#fileList .file-row [data-file-menu]'); await p.click('.menu-item:has-text("Share link")'); await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput'); await p.keyboard.press('Escape');
  await p.locator('.sheet-tab[data-sheet="1"]').click(); await sleep(800);

  // ---- Desktop: popover ----
  await p.click('#accountBtn'); await p.waitForSelector('#profileModal:not([hidden])');
  const rows = await p.$$eval('#profilePanel .pf-main .pf-row', r => r.map(x => x.textContent.trim()));
  ok('main menu order', JSON.stringify(rows) === JSON.stringify(['Files & share links', 'Recently deleted', 'Account & security', 'Help & support']), JSON.stringify(rows));
  ok('header: name, email, Pro badge', (await p.textContent('.pf-name')).startsWith('Maria Lopez') && (await p.textContent('.pf-email')) === EMAIL && (await p.textContent('.pf-badge')) === 'Pro');
  const pop = await p.$eval('#profilePanel', el => { const r = el.getBoundingClientRect(); return { w: r.width, top: r.top, right: innerWidth - r.right }; });
  const btn = await p.$eval('#accountBtn', el => el.getBoundingClientRect().bottom);
  ok('desktop: compact popover under the account button', pop.w <= 330 && pop.top > btn && pop.top < btn + 20, JSON.stringify(pop));
  ok('focus starts on the first row', await p.evaluate(() => document.activeElement.dataset.pf === 'library'));
  await p.screenshot({ path: OUT + 'pm-desktop-main.png' });
  await p.keyboard.press('ArrowDown'); ok('arrow keys move through rows', await p.evaluate(() => document.activeElement.dataset.pf === 'trash'));
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await p.waitForSelector('.pf-subhead');
  ok('Account & security opens with title and Back', (await p.textContent('#pfTitle')) === 'Account & security' && await p.evaluate(() => document.activeElement.dataset.pf === 'back'));
  const sec = await pfText(p);
  ok('groups: Preferences, Security, Your data, Sessions', /Preferences[\s\S]*Appearance[\s\S]*Security[\s\S]*Generate new recovery key[\s\S]*Download my data[\s\S]*Delete account[\s\S]*Sessions[\s\S]*Signed-in devices[\s\S]*Sign out of all devices/.test(sec), sec);
  ok('delete is plain, under Download my data', await p.$eval('[data-pf="delete"]', el => !el.classList.contains('danger') && el.previousElementSibling?.dataset.pf === 'export'));
  ok('sign out is last, in the accent color, after a divider', await p.$eval('[data-pf="signout"]', el => el.classList.contains('accent') && !el.nextElementSibling && el.previousElementSibling.classList.contains('pf-sep')));
  await p.screenshot({ path: OUT + 'pm-desktop-security.png' });
  // ⓘ beside Generate new recovery key: a plain-words explanation over the menu.
  ok('recovery key has an ⓘ button beside it', await p.$eval('[data-pf="recovery-info"]', el => el.previousElementSibling?.dataset.pf === 'recovery' && /recovery key/i.test(el.getAttribute('aria-label'))));
  ok('…right after the title, on its line', await p.evaluate(() => {
    const r = document.createRange(); r.selectNodeContents(document.querySelector('[data-pf="recovery"] .pf-label > span'));
    const t = [...r.getClientRects()].pop();
    const i = document.querySelector('[data-pf="recovery-info"]').getBoundingClientRect();
    const gap = i.left - t.right;
    return gap >= 0 && gap < 12 && Math.abs((i.top + i.height / 2) - (t.top + t.height / 2)) < 3;
  }));
  await p.click('[data-pf="recovery-info"]');
  await p.waitForSelector('#sheetModal:not([hidden])');
  const why = await p.textContent('#sheetModal');
  ok('ⓘ explains recovery keys in plain words', /What’s a recovery key?/.test(why) && /forget your password/.test(why) && /starting over/.test(why), why);
  ok('…with Got it focused, menu still open underneath', await p.evaluate(() => document.activeElement.textContent === 'Got it' && !document.querySelector('#profileModal').hidden));
  await p.screenshot({ path: OUT + 'pm-recovery-info.png' });
  await p.keyboard.press('Escape');
  ok('Escape closes it, back on the ⓘ in the menu', await p.evaluate(() => document.querySelector('#sheetModal').hidden && !document.querySelector('#profileModal').hidden && document.activeElement.dataset.pf === 'recovery-info'));
  // Appearance selector
  await p.click('[data-theme-pick="dark"]');
  ok('Appearance: Dark applies and stays checked', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await p.getAttribute('[data-theme-pick="dark"]', 'aria-checked')) === 'true');
  await p.keyboard.press('ArrowLeft'); ok('arrow keys pick Light', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await p.keyboard.press('ArrowLeft'); ok('…and System', (await p.evaluate(() => window.scratchTheme.get())) === 'system');
  await p.click('[data-theme-pick="light"]');
  await p.keyboard.press('Escape'); await sleep(100);
  ok('Escape goes back to the main view, focus on its row', (await p.$$('.pf-main')).length === 1 && await p.evaluate(() => document.activeElement.dataset.pf === 'security'));
  await p.click('[data-pf="help"]'); await p.waitForSelector('.pf-subhead');
  ok('Help & support: support, privacy, terms', /Contact support[\s\S]*Privacy policy[\s\S]*Terms of service/.test(await pfText(p)));
  await p.screenshot({ path: OUT + 'pm-desktop-help.png' });
  const [popup] = await Promise.all([p.waitForEvent('popup'), p.click('[data-pf="privacy"]')]);
  ok('Privacy policy opens', popup.url().endsWith('/privacy'));
  await popup.close();
  ok('menu closed after an action', await p.isHidden('#profileModal'));
  await p.click('#accountBtn'); await p.keyboard.press('Escape'); await sleep(100);
  ok('Escape closes; focus back on the account button', await p.isHidden('#profileModal') && await p.evaluate(() => document.activeElement.id === 'accountBtn'));
  await p.click('#accountBtn'); await p.mouse.click(200, 600); await sleep(100);
  ok('clicking outside closes it', await p.isHidden('#profileModal'));

  // Recently deleted still opens
  await p.click('#accountBtn'); await p.click('[data-pf="trash"]'); await p.waitForSelector('#trashModal:not([hidden])');
  ok('Recently deleted opens', true); await p.keyboard.press('Escape');

  // ---- Files & share links ----
  await p.click('#accountBtn'); await p.click('[data-pf="library"]'); await p.waitForSelector('#libraryModal:not([hidden])');
  await p.waitForSelector('#libFilesBody .lib-table tbody tr');
  const fileRows = await p.$$eval('#libFilesBody tbody tr', r => r.map(x => [x.querySelector('.lib-name').textContent, ...[...x.querySelectorAll('td')].slice(1, 4).map(td => td.innerText.trim())]));
  const byName = Object.fromEntries(fileRows.map(r => [r[0].split('\n')[0], r]));
  ok('all files across sheets listed', fileRows.length === 3 && byName['Quarterly report.pdf'] && byName['notes.txt'] && byName['boarding-pass.png'], JSON.stringify(fileRows));
  ok('type, size and sheet shown', byName['Quarterly report.pdf']?.[1] === 'PDF' && /146\.5 KB|150|146/.test(byName['Quarterly report.pdf']?.[2]) && byName['boarding-pass.png']?.[1] === 'Image' && byName['boarding-pass.png']?.[3] === 'Travel' && byName['notes.txt']?.[3] !== 'Travel', JSON.stringify(byName));
  const usage = await p.evaluate(() => fetch('/.netlify/functions/state?meta=usage').then(r => r.json()));
  const storageText = await p.textContent('#libStorage');
  const fmt = n => n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
  ok('storage: used vs the account limit, with a bar', storageText.includes(fmt(usage.bytes)) && storageText.includes('5 GB') && await p.isVisible('.lib-bar'), `${storageText} / ${usage.bytes}`);
  const listedBytes = await p.evaluate(() => [...document.querySelectorAll('#libFilesBody tbody tr')].length);
  ok('bar value matches usage', Number(await p.getAttribute('.lib-bar', 'aria-valuenow')) === Math.round(usage.bytes / usage.quota * 100));
  await p.screenshot({ path: OUT + 'pm-desktop-files.png' });
  await p.fill('#libSearch', 'board'); await sleep(100);
  ok('search filters', (await p.$$('#libFilesBody tbody tr')).length === 1);
  await p.fill('#libSearch', 'zzz'); await sleep(100);
  ok('search: clear empty state', (await p.textContent('#libFilesBody')).includes('No files match'));
  await p.fill('#libSearch', '');
  // Shared links tab
  await p.click('#libTabLinks'); await p.waitForSelector('#linksBody tbody tr');
  const link = await p.$eval('#linksBody tbody tr', r => [...r.querySelectorAll('td')].map(td => td.innerText.trim()));
  ok('shared link listed with its file and sheet', link[0].startsWith('boarding-pass.png') && link[1] === 'File' && link[2] === 'Travel' && /Expires|Opened|Not opened/.test(link[3]), JSON.stringify(link));
  await p.screenshot({ path: OUT + 'pm-desktop-links.png' });
  await p.keyboard.press('ArrowLeft'); ok('tabs work with arrow keys', (await p.getAttribute('#libTabFiles', 'aria-selected')) === 'true');
  // Existing file actions from the list
  await p.click('#libFilesBody tbody tr:has-text("notes.txt") [data-lib-menu]');
  const actions = await p.$$eval('.menu .menu-item', m => m.map(x => x.textContent.trim()));
  ok('file actions available', ['Preview', 'Download', 'Share link…', 'Delete file…'].every(a => actions.includes(a)), JSON.stringify(actions));
  await p.click('.menu-item:has-text("Delete file")'); await p.waitForSelector('#sheetModal:not([hidden])');
  ok('delete still asks first, above the list', await p.evaluate(() => getComputedStyle(document.querySelector('#sheetModal')).zIndex > getComputedStyle(document.querySelector('#libraryModal')).zIndex));
  await p.click('#sheetActions .btn:has-text("Delete file")');
  await p.waitForFunction(() => document.querySelectorAll('#libFilesBody tbody tr').length === 2, null, { timeout: 8000 }).then(() => ok('deleted file leaves the list', true), () => ok('deleted file leaves the list', false));
  // Open the containing sheet
  await p.click('#libFilesBody tbody tr:has-text("boarding-pass.png") [data-lib-open]');
  await p.waitForSelector('#libraryModal', { state: 'hidden' });
  await p.waitForFunction(() => document.querySelector('.sheet-tab.active')?.textContent.includes('Travel'), null, { timeout: 5000 }).then(() => ok('Open sheet goes to the file’s sheet', true), () => ok('Open sheet goes to the file’s sheet', false));
  ok('…and the file is in view', await p.isVisible('#fileList .file-row:has-text("boarding-pass.png")'));

  // ---- Phone: bottom sheet, full-screen library, Back ----
  const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage(); m.on('pageerror', e => errs.push('phone: ' + e.message));
  await m.goto(BASE); await m.fill('#signinEmail', EMAIL); await m.fill('#signinPassword', 'pass-12345'); await m.click('#signinForm .auth-submit'); await m.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1200);
  await m.tap('#accountBtn'); await m.waitForSelector('#profileModal:not([hidden])');
  const sheet = await m.$eval('#profilePanel', el => { const r = el.getBoundingClientRect(); return { w: r.width, bottom: innerHeight - r.bottom }; });
  ok('phone: bottom sheet across the screen', sheet.w >= 388 && Math.abs(sheet.bottom) < 2, JSON.stringify(sheet));
  ok('phone: rows are comfortable to tap (≥ 48 px)', (await m.$$eval('.pf-row', r => Math.min(...r.map(x => x.getBoundingClientRect().height)))) >= 48);
  ok('phone: labels never cut off', await m.$$eval('.pf-row .pf-label span:first-child, .pf-name, .pf-email', els => els.every(e => e.scrollWidth <= e.clientWidth + 1)));
  await m.screenshot({ path: OUT + 'pm-phone-main.png' });
  await m.tap('[data-pf="security"]'); await m.waitForSelector('.pf-subhead');
  // The row that lands under the finger must not keep a shade on touch screens.
  await m.hover('[data-pf="signout-all"]'); await sleep(100);
  ok('phone: no stuck shade on the row under the finger', (await m.$eval('[data-pf="signout-all"]', el => getComputedStyle(el).backgroundColor)) === 'rgba(0, 0, 0, 0)');
  ok('recovery action says Generate new recovery key…', (await m.textContent('[data-pf="recovery"] .pf-label span')).trim() === 'Generate new recovery key…');
  await m.screenshot({ path: OUT + 'pm-phone-security.png' });
  await m.tap('[data-pf="back"]'); await m.hover('[data-pf="trash"]'); await sleep(100);
  ok('phone: Back leaves no stuck shade either', (await m.$eval('[data-pf="trash"]', el => getComputedStyle(el).backgroundColor)) === 'rgba(0, 0, 0, 0)');
  await m.tap('[data-pf="security"]'); await m.waitForSelector('.pf-subhead');
  // On a computer, hovering still shades rows.
  await p.click('#accountBtn'); await p.waitForSelector('#profileModal:not([hidden])'); await p.hover('[data-pf="trash"]'); await sleep(150);
  ok('desktop: hover still shades rows', (await p.$eval('[data-pf="trash"]', el => getComputedStyle(el).backgroundColor)) !== 'rgba(0, 0, 0, 0)');
  await p.keyboard.press('Escape');
  await m.tap('[data-pf="back"]'); await m.tap('[data-pf="library"]'); await m.waitForSelector('#libFilesBody tbody tr');
  const full = await m.$eval('.library-modal', el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
  ok('phone: Files & share links is full screen', full[0] >= 389 && full[1] >= 843, JSON.stringify(full));
  ok('phone: compact list (no table header), details under the name', await m.isHidden('.lib-table thead') && (await m.textContent('#libFilesBody .lib-sub')).includes('·'));
  ok('phone: no sideways scroll', await m.evaluate(() => document.querySelector('.library-panel').scrollWidth <= document.querySelector('.library-panel').clientWidth));
  await m.screenshot({ path: OUT + 'pm-phone-files.png' });
  await m.tap('#libTabLinks'); await m.waitForSelector('#linksBody tbody tr'); await m.screenshot({ path: OUT + 'pm-phone-links.png' });
  await m.tap('[data-library-back]'); await m.waitForSelector('#profileModal:not([hidden])');
  ok('phone: Back returns to the menu', await m.isHidden('#libraryModal'));
  await m.tap('[data-pf="security"]'); await m.tap('[data-pf="signout"]');
  await m.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 }).then(() => ok('Sign out works', true), () => ok('Sign out works', false));

  // ---- Another account sees none of it ----
  const o = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await signUp(o, OTHER);
  { const { getStore } = await import(require('url').pathToFileURL(REPO + '/node_modules/@netlify/blobs/dist/main.js').href);
    const auth = getStore({ name: 'scratchpad-auth', siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
    const ek = crypto.createHash('sha256').update(OTHER).digest('hex').slice(0, 32);
    await auth.setJSON(`users/${ek}`, { ...(await auth.get(`users/${ek}`, { type: 'json' })), plan: 'free' });
    await o.reload(); await o.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800); }
  await o.click('#accountBtn');
  ok('Free account: Free badge and Upgrade', (await o.textContent('.pf-badge')) === 'Free' && await o.isVisible('[data-pf="upgrade"]'));
  await o.click('[data-pf="library"]'); await o.waitForSelector('#libFilesBody .lib-empty:not(:has-text("Loading"))');
  ok('other account: no files, its own storage', (await o.textContent('#libFilesBody')).includes('No files yet') && (await o.textContent('#libStorage')).includes('10 MB'), await o.textContent('#libStorage'));
  await o.click('#libTabLinks'); await o.waitForSelector('#linksBody .lib-empty:not(:has-text("Loading"))');
  ok('other account: no links (Pro note on Free)', (await o.textContent('#linksBody')).includes('Share links come with Pro'));
  await o.screenshot({ path: OUT + 'pm-free-links.png' });
  const peek = await o.evaluate(() => Promise.all([fetch('/.netlify/functions/files?sheet=2').then(r => r.json()), fetch('/.netlify/functions/share?mine=1').then(r => r.json())]));
  ok('other account’s API shows none of the first account’s files or links', JSON.stringify(peek).indexOf('boarding') === -1 && (peek[1].shares || []).length === 0, JSON.stringify(peek).slice(0, 200));
  const anon = await (await b.newContext()).newPage(); await anon.goto(BASE);
  const st = await anon.evaluate(() => Promise.all(['/.netlify/functions/state?meta=usage', '/.netlify/functions/files?sheet=1', '/.netlify/functions/share?mine=1'].map(u => fetch(u).then(r => r.status))));
  ok('signed out: usage, files and links refused', st.every(s => s === 401), st.join());

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
