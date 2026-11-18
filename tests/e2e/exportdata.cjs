// Download my data: every sheet (page + text), its images and files, unlocked, in one .zip.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'export' + Date.now() + '@example.com';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
  const saved = () => p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });
  const rename = async name => { if (!(await p.isVisible('#renameModal'))) { await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); } await p.fill('#renameInput', name); await p.click('#renameForm button[type=submit]'); await sleep(600); };

  // Sheet 1: text, a pasted image, three files (two with the same name), one deleted
  await rename('Trip plans');
  await p.click('#scratchpad'); await p.keyboard.type('Flights on Friday.\nPack the charger.\n');
  await p.evaluate(async () => {
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const r = document.createRange(); r.selectNodeContents(pad); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
    const c = document.createElement('canvas'); c.width = 600; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#1f787c'; x.fillRect(0, 0, 600, 300);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => { const i = document.querySelector('#scratchpad img'); return i && !i.dataset.pending && i.naturalWidth > 0; }, null, { timeout: 20000 });
  await p.keyboard.type('After the photo.'); await sleep(300); await saved();
  const big = crypto.randomBytes(9_000_000);
  await p.setInputFiles('#fileInput', [{ name: 'budget.pdf', mimeType: 'application/pdf', buffer: big }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first notes') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 }); await sleep(800);
  await p.setInputFiles('#fileInput', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('second notes') }, { name: 'old.txt', mimeType: 'text/plain', buffer: Buffer.from('gone') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 4, null, { timeout: 30000 }); await sleep(800);
  await p.click('#fileList .file-row:has-text("old.txt") [data-file-menu]'); await p.click('.menu-item:has-text("Delete file")');
  await p.click('#sheetModal button:has-text("Delete")'); await sleep(6500);
  // Sheet 2: a name with a slash, text and a file
  await p.click('#addSheetBtn'); await sleep(1200);
  await rename('Work/Ideas');
  await p.click('#scratchpad'); await p.keyboard.type('Ship the logo. 🎉'); await saved();
  await p.setInputFiles('#fileInput', [{ name: 'deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 deck') }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 }); await sleep(800);

  // The menu row
  await p.click('#accountBtn'); await p.click('[data-pf="security"]'); await sleep(300);
  ok('Account & security has "Download my data…"', await p.isVisible('[data-pf="export"]:has-text("Download my data…")'));
  await p.screenshot({ path: OUT + 'export-menu.png', clip: { x: 760, y: 0, width: 520, height: 640 } });
  await p.click('[data-pf="export"]'); await sleep(300);
  ok('asks first, says what’s in it', (await p.textContent('#sheetModal')).includes('Recently deleted items aren’t included'));
  await p.screenshot({ path: OUT + 'export-confirm.png' });
  const dl = p.waitForEvent('download', { timeout: 60000 });
  await p.click('#sheetModal button:has-text("Download .zip")');
  const d = await dl;
  ok('downloads "ScrapSheet data <date>.zip"', /^ScrapSheet data \d{4}-\d{2}-\d{2}\.zip$/.test(d.suggestedFilename()), d.suggestedFilename());
  const zipPath = OUT + 'export-test.zip'; await d.saveAs(zipPath);
  await sleep(300); await p.screenshot({ path: OUT + 'export-progress.png', clip: { x: 0, y: 0, width: 1280, height: 860 } });

  // What's inside (checked with Python's zipfile: every CRC, names, contents)
  const info = JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys, hashlib
z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); names = z.namelist()
r = lambda n: z.read(n)
out = {'bad': bad, 'names': names}
for n in names:
    if n.endswith(('.html', '.txt', '.json')): out[n] = r(n).decode('utf-8')
    else: out[n] = {'sha': hashlib.sha256(r(n)).hexdigest(), 'head': r(n)[:8].hex(), 'size': len(r(n))}
print(json.dumps(out))`, zipPath]).toString());
  const names = info.names;
  console.log('   ' + names.join('\n   '));
  ok('every entry checks out (CRC)', info.bad === null);
  const want = ['README.txt', 'account.json', '01 Trip plans/Trip plans.html', '01 Trip plans/Trip plans.txt', '01 Trip plans/images/image-1.png', '01 Trip plans/files/budget.pdf', '01 Trip plans/files/notes.txt', '01 Trip plans/files/notes (2).txt', '06 Work-Ideas/Work-Ideas.html', '06 Work-Ideas/Work-Ideas.txt', '06 Work-Ideas/files/deck.pdf'];
  ok('folders per sheet, images and files inside', want.every(n => names.includes(n)), want.filter(n => !names.includes(n)).join(', '));
  ok('empty sheets get no folder', !names.some(n => /^0[2-5] Sheet/.test(n)));
  ok('a deleted file isn’t included', !names.some(n => n.includes('old.txt')));
  ok('files come out unlocked, byte for byte', info['01 Trip plans/files/budget.pdf'].sha === crypto.createHash('sha256').update(big).digest('hex'));
  const notes = [info['01 Trip plans/files/notes.txt'], info['01 Trip plans/files/notes (2).txt']].map(x => Buffer.from(x, 'utf8').toString()).sort();
  ok('same-name files both kept', JSON.stringify(notes) === JSON.stringify(['first notes', 'second notes']), JSON.stringify(notes));
  ok('the pasted image is a real PNG', info['01 Trip plans/images/image-1.png'].head.startsWith('89504e47'));
  const html = info['01 Trip plans/Trip plans.html'];
  ok('sheet page: its text, and the image from the folder', html.includes('Flights on Friday.') && html.includes('src="images/image-1.png"') && !html.includes('netlify/functions') && html.includes('<title>Trip plans</title>'));
  const txt = info['01 Trip plans/Trip plans.txt'];
  ok('plain text keeps the lines', txt.includes('Flights on Friday.\nPack the charger.') && txt.includes('\n[image: images/image-1.png]\nAfter the photo.'), JSON.stringify(txt));
  ok('emoji survive', info['06 Work-Ideas/Work-Ideas.txt'].includes('Ship the logo. 🎉'));
  const acct = JSON.parse(info['account.json']);
  ok('account.json: email, plan, sheets and files', acct.account.email === E && acct.account.plan === 'pro' && acct.sheets.length === 6 && acct.sheets[0].files.length === 3 && acct.sheets[5].name === 'Work/Ideas' && acct.sheets[1].empty === true);
  ok('README explains the folders', info['README.txt'].includes('Recently Deleted are not included'));
  ok('nothing on the server changed (still 6 sheets)', (await p.$$('.sheet-tab')).length === 6);

  // Offline: says why, does nothing
  await ctx.setOffline(true); await sleep(400);
  const rows = await p.$$eval('.transfer-row', r => r.length);
  await p.evaluate(() => document.querySelector('#toast').textContent = '');
  await p.click('#accountBtn'); await p.click('[data-pf="security"]'); await p.click('[data-pf="export"]'); await sleep(300);
  if (await p.isVisible('#sheetModal button:has-text("Download .zip")')) await p.click('#sheetModal button:has-text("Download .zip")');
  await sleep(400);
  ok('offline: explains and starts nothing', (await p.textContent('#toast')).includes('Reconnect to download your data') && (await p.$$eval('.transfer-row', r => r.length)) <= rows);
  await ctx.setOffline(false);

  // Phone: the row in the bottom sheet
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); m.on('pageerror', e => errs.push(e.message));
  await m.goto(BASE); await m.fill('#signinEmail', E); await m.fill('#signinPassword', 'pass-12345'); await m.click('#signinForm .auth-submit');
  await m.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await m.tap('#accountBtn'); await m.tap('[data-pf="security"]'); await sleep(400);
  await m.screenshot({ path: OUT + 'export-phone.png' });
  ok('phone: row visible', await m.isVisible('[data-pf="export"]'));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
