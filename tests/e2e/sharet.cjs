const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const IMG = __dirname + '/imgs/';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'share' + Date.now() + '@example.com';
let fails = 0; const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
(async () => {
  const { getStore } = await import(REPO + '/node_modules/@netlify/blobs/dist/main.js');
  const store = name => getStore({ name, siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:3, acceptDownloads:true, permissions:['clipboard-read','clipboard-write'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', EMAIL); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(EMAIL)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit'); await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state:'visible' }); await sleep(1200);
  const saved = () => p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });

  // A sheet with text, a pasted image and two files (one bigger than a chunk)
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); await p.fill('#renameInput', 'Launch kit'); await p.click('#renameForm button[type=submit]'); await sleep(400);
  await p.click('#scratchpad'); await p.keyboard.type('Press kit for the agency.\nFinal pricing is in the PDF.\n');
  await p.evaluate(async () => {
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const r = document.createRange(); r.selectNodeContents(pad); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
    const c = document.createElement('canvas'); c.width = 800; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#245a88'; x.fillRect(0, 0, 800, 400); x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText('Packaging v2', 200, 220);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type:'image/png' }));
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles:true, cancelable:true }));
  });
  await p.waitForFunction(() => { const i = document.querySelector('#scratchpad img'); return i && !i.dataset.pending && i.naturalWidth > 0; }, null, { timeout: 20000 });
  await saved();
  const big = crypto.randomBytes(9_000_000);
  await p.setInputFiles('#fileInput', [{ name:'pricing-final.pdf', mimeType:'application/pdf', buffer: big }, { name:'sunset-beach.jpg', mimeType:'image/jpeg', buffer: fs.readFileSync(IMG + 'sunset-beach.jpg') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 }); await sleep(800);

  // Share one file
  await p.click('#fileList .file-row:has-text("pricing-final.pdf") [data-file-menu]');
  ok('file menu has Share link…', (await p.$$eval('.menu [role=menuitem]', x => x.map(e => e.textContent))).includes('Share link…'));
  await p.click('.menu-item:has-text("Share link")'); await p.waitForSelector('[data-share-create]');
  await p.screenshot({ path: OUT + 'sh-dialog-new.png' });
  await p.click('.seg [data-days="1"]'); await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
  const fileUrl = await p.inputValue('#shareUrlInput');
  ok('link made and copied', /\/s\/[A-Za-z0-9_-]{24}#[A-Za-z0-9_-]{43}$/.test(fileUrl) && (await p.evaluate(() => navigator.clipboard.readText())) === fileUrl, fileUrl);
  ok('expires in 1 day', (await p.textContent('.share-status b')) === 'Expires in 1 day', await p.textContent('.share-status b'));
  await p.screenshot({ path: OUT + 'sh-dialog-link.png' });
  await p.keyboard.press('Escape'); await sleep(200);
  ok('row marked Shared', Boolean(await p.$('#fileList .file-row:has-text("pricing-final.pdf") .shared-tag')));

  await p.$eval('#filesSection', el => el.scrollIntoView({ block:'center' })); await sleep(300); await p.screenshot({ path: OUT + 'sh-row.png' });
  // Someone without an account opens it
  const guestCtx = await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:3, acceptDownloads:true });
  const g = await guestCtx.newPage(); g.on('pageerror', e => errs.push('guest: ' + e.message));
  await g.goto(fileUrl); await g.waitForSelector('.share-title');
  ok('guest sees the file', (await g.textContent('.share-title')) === 'pricing-final.pdf' && (await g.textContent('.share-kicker')) === 'Shared file');
  ok('page is not indexed', (await g.getAttribute('meta[name=robots]', 'content')) === 'noindex, nofollow');
  await g.screenshot({ path: OUT + 'sh-guest-file.png' });
  const [dl] = await Promise.all([g.waitForEvent('download', { timeout: 30000 }), g.click('.dl-main')]);
  const got = fs.readFileSync(await dl.path());
  ok('guest downloads the exact file (3 chunks)', dl.suggestedFilename() === 'pricing-final.pdf' && got.equals(big), `${got.length} bytes`);
  ok('guest cookies give no access to the account', (await g.evaluate(() => fetch('/.netlify/functions/state?meta=all').then(r => r.status))) === 401);

  // Share the whole sheet
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Share sheet")'); await p.waitForSelector('[data-share-create]');
  await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
  const sheetUrl = await p.inputValue('#shareUrlInput');
  await p.keyboard.press('Escape');
  await g.goto(sheetUrl); await g.waitForSelector('.share-text'); await sleep(1500);
  const sheetView = await g.evaluate(() => ({ text: document.querySelector('.share-text').innerText, img: document.querySelector('.shared-image')?.naturalWidth || 0, files: [...document.querySelectorAll('.share-file-name')].map(e => e.textContent), thumb: [...document.querySelectorAll('.share-file img')].filter(i => i.naturalWidth).length }));
  ok('guest sees the sheet text', sheetView.text.includes('Press kit for the agency.') && sheetView.text.includes('Final pricing'), JSON.stringify(sheetView.text));
  ok('…its pasted image', sheetView.img > 0);
  ok('…and its files, with a thumbnail', sheetView.files.length === 2 && sheetView.thumb === 1, JSON.stringify(sheetView));
  await g.screenshot({ path: OUT + 'sh-guest-sheet.png', fullPage: true });
  const [dl2] = await Promise.all([g.waitForEvent('download'), g.click('.share-file:has-text("sunset-beach.jpg") .dl-row')]);
  ok('guest downloads a file from the sheet', dl2.suggestedFilename() === 'sunset-beach.jpg');

  // A link can't reach other files, other sheets or anything with a guessed token
  const tok = sheetUrl.split('/s/')[1].split('#')[0];
  const fileTok = fileUrl.split('/s/')[1].split('#')[0];
  const sheetFileId = await p.$eval('#fileList .file-row:has-text("sunset-beach.jpg")', r => r.dataset.id);
  ok('file link can’t fetch the sheet’s other files', (await g.evaluate(([t, id]) => fetch(`/.netlify/functions/share?t=${t}&file=${id}&chunk=0`).then(r => r.status), [fileTok, sheetFileId])) === 404);
  ok('made-up link says it doesn’t work', (await g.evaluate(() => fetch('/.netlify/functions/share?t=AAAAAAAAAAAAAAAAAAAAAAAA').then(r => r.status))) === 404);

  // Shared links panel; turn one off
  await p.click('#accountBtn'); await p.click('[data-pf="library"]'); await p.click('#libTabLinks'); await p.waitForSelector('#linksBody tbody tr');
  const listed = await p.$$eval('#linksBody tbody tr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  ok('panel lists both links with views', listed.length === 2 && listed.some(t => t.includes('Opened 1 time')), listed.join(' | '));
  await p.screenshot({ path: OUT + 'sh-links.png' });
  await p.click('#linksBody tbody tr:has-text("Launch kit") [data-link-off]'); await sleep(900);
  ok('turned-off link leaves the active list', (await p.$$('#linksBody tbody tr')).length === 1 && await p.isVisible('[data-links-inactive]'));
  await p.click('[data-links-inactive]');
  ok('See inactive links shows it, with the reason', (await p.innerText('#inactiveLinks')).includes('Turned off by you'), await p.innerText('#linksBody'));
  await p.keyboard.press('Escape');
  await g.goto('about:blank'); await g.goto(sheetUrl); await g.waitForSelector('.share-problem');
  ok('guest is told it was turned off', (await g.textContent('.share-problem .share-title')) === 'This link was turned off.');
  await g.screenshot({ path: OUT + 'sh-guest-off.png' });

  // Expired
  const shares = store('scratchpad-shares');
  const rec = await shares.get(`shares/${fileTok}`, { type:'json' }); rec.expiresAt = Date.now() - 1000; await shares.setJSON(`shares/${fileTok}`, rec);
  await g.goto(fileUrl); await g.waitForSelector('.share-problem');
  ok('expired link says so', (await g.textContent('.share-problem .share-title')) === 'This link has expired.');

  // A new link for the file; then deleting the file ends it
  await p.reload(); await p.waitForSelector('#fileList .file-row'); await sleep(1200);
  ok('expired link no longer marks the row', !(await p.$('#fileList .file-row:has-text("pricing-final.pdf") .shared-tag')));
  await p.click('#fileList .file-row:has-text("pricing-final.pdf") [data-file-menu]'); await p.click('.menu-item:has-text("Share link")'); await p.waitForSelector('[data-share-create]');
  await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput'); const url3 = await p.inputValue('#shareUrlInput'); await p.keyboard.press('Escape');
  await p.click('#fileList .file-row:has-text("pricing-final.pdf") [data-file-menu]'); await p.click('.menu-item:has-text("Delete file")'); await p.click('#sheetActions button:has-text("Delete file")'); await sleep(900);
  await g.goto(url3); await g.waitForSelector('.share-problem');
  ok('deleting the file ends its link', (await g.textContent('.share-problem .share-title')) === 'What was shared here has been deleted.');

  // Desktop look
  const d = await (await b.newContext({ viewport:{ width:1280, height:900 }, deviceScaleFactor:2 })).newPage(); d.on('pageerror', e => errs.push('desk: ' + e.message));
  await d.goto(BASE); await d.fill('#signinEmail', EMAIL); await d.fill('#signinPassword', 'pass-12345'); await d.click('#signinForm .auth-submit');
  await d.waitForSelector('#fileList .file-row'); await sleep(1000);
  await d.click('#sheetMenuBtn'); await d.click('.menu-item:has-text("Share sheet")'); await d.waitForSelector('[data-share-create]'); await d.click('[data-share-create]'); await d.waitForSelector('#shareUrlInput');
  const url4 = await d.inputValue('#shareUrlInput');
  await d.screenshot({ path: OUT + 'sh-desktop-dialog.png' });
  await d.keyboard.press('Escape');
  const gd = await (await b.newContext({ viewport:{ width:1280, height:900 }, deviceScaleFactor:2 })).newPage();
  await gd.goto(url4); await gd.waitForSelector('.share-text'); await sleep(1200);
  await gd.screenshot({ path: OUT + 'sh-desktop-guest.png' });
  console.log('errors:', errs, '| fails:', fails); await b.close();
})();
