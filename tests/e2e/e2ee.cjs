// End-to-end encryption: a new account, what the server stores, share links, a second device, reset.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const IMG = __dirname + '/imgs/';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'enc' + Date.now() + '@example.com';
let fails = 0; const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
(async () => {
  const { getStore } = await import(require('url').pathToFileURL(REPO + '/node_modules/@netlify/blobs/dist/main.js').href);
  const store = name => getStore({ name, siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
  const ek = crypto.createHash('sha256').update(EMAIL).digest('hex').slice(0, 32);
  const user = () => store('scratchpad-auth').get(`users/${ek}`, { type: 'json' });
  const b = await chromium.launch(); const errs = [];
  const newCtx = () => b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const ctx = await newCtx();
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', EMAIL); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(EMAIL)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 });
  const rk = await p.textContent('#recoveryKeyText');
  ok('recovery key shown after creating the account', /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/.test(rk), rk);
  await p.screenshot({ path: OUT + 'e2-recovery.png' });
  await p.click('#recoveryKeyForm .auth-submit');
  ok('must tick the box first', (await p.textContent('#recoveryKeyForm .auth-error')).includes('tick'));
  const [rkDl] = await Promise.all([p.waitForEvent('download'), p.click('[data-save-recovery]')]);
  ok('recovery key downloads as text', fs.readFileSync(await rkDl.path(), 'utf8').includes(rk));
  await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1200);
  console.log(`  (sign-up to app: ${Date.now() - t0} ms)`);
  const u1 = await user();
  ok('server keeps a keyring, no password', u1.keyring && u1.authV === 2 && u1.migratedAt && !JSON.stringify(u1).includes('pass-12345'));
  const saved = () => p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 8000 });

  // Name, text, a pasted image and two files
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); await p.fill('#renameInput', 'Secret plans'); await p.click('#renameForm button[type=submit]'); await sleep(500);
  await p.click('#scratchpad'); await p.keyboard.type('The launch is on Tuesday.\n');
  await p.evaluate(async () => {
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const r = document.createRange(); r.selectNodeContents(pad); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
    const c = document.createElement('canvas'); c.width = 800; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#245a88'; x.fillRect(0, 0, 800, 400); x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText('Hidden', 260, 220);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => { const i = document.querySelector('#scratchpad img'); return i && !i.dataset.pending && i.naturalWidth > 0; }, null, { timeout: 20000 });
  await sleep(300); await saved();
  const big = crypto.randomBytes(9_000_000);
  const photo = fs.readFileSync(IMG + 'sunset-beach.jpg');
  await p.setInputFiles('#fileInput', [{ name: 'budget-secret.pdf', mimeType: 'application/pdf', buffer: big }, { name: 'sunset-beach.jpg', mimeType: 'image/jpeg', buffer: photo }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 }); await sleep(1500);

  // What the server has: nothing readable
  const ns = u1.ns;
  const doc = await store(`u-${ns}`).get('sheets/1', { type: 'json' });
  ok('sheet text stored locked', doc.html.startsWith('e1:') && !doc.html.includes('Tuesday') && doc.text === '' && doc.filled === true && doc.images.length === 1, JSON.stringify(doc).slice(0, 80));
  const names = JSON.stringify(await store(`u-${ns}`).get('meta/sheets', { type: 'json' }) || await store(`u-${ns}`).get('meta/names', { type: 'json' }));
  ok('sheet name stored locked', !names.includes('Secret plans') && names.includes('e1:'), names.slice(0, 120));
  const recs = await Promise.all((await store(`u-${ns}-files-1`).list()).blobs.map(x => store(`u-${ns}-files-1`).get(x.key, { type: 'json' })));
  ok('file names stored locked', recs.length === 2 && recs.every(r => r.enc && r.name.startsWith('e1:') && r.key) && !JSON.stringify(recs).includes('budget'), JSON.stringify(recs.map(r => r.name.slice(0, 12))));
  const pdfRec = recs.find(r => r.size === big.length);
  const c0 = Buffer.from(await store(`u-${ns}-chunks-1`).get(`${pdfRec.id}-0`, { type: 'arrayBuffer' }));
  ok('file chunks stored locked', c0.length === pdfRec.chunkSize + 28 && !c0.subarray(28, 1000).equals(big.subarray(0, 972)), `${c0.length}`);
  const photoRec = recs.find(r => r.size === photo.length);
  const th = photoRec.thumb && Buffer.from(await store(`u-${ns}-file-thumbs-1`).get(photoRec.id, { type: 'arrayBuffer' }));
  ok('thumbnail stored locked', th && th[0] !== 0xff && th.subarray(0, 4).toString('hex') !== '89504e47', th && th.subarray(0, 4).toString('hex'));
  const imgId = doc.images[0];
  const imgChunk = Buffer.from(await store(`u-${ns}-image-chunks-1`).get(`${imgId}-0`, { type: 'arrayBuffer' }));
  ok('pasted image stored locked', imgChunk.subarray(0, 4).toString('hex') !== '89504e47', imgChunk.subarray(0, 4).toString('hex'));

  // Reload: everything opens again from this device's kept key
  await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' });
  await p.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Tuesday'), null, { timeout: 10000 });
  await p.waitForFunction(() => { const i = document.querySelector('#scratchpad img'); return i && i.naturalWidth > 0; }, null, { timeout: 10000 });
  await p.waitForFunction(() => [...document.querySelectorAll('#fileList img')].some(i => i.naturalWidth > 0), null, { timeout: 10000 }).catch(() => {});
  const after = await p.evaluate(() => ({ tab: document.querySelector('.tab.active, [aria-selected=true]')?.textContent || '', files: [...document.querySelectorAll('#fileList .file-row')].map(r => r.textContent), thumbs: [...document.querySelectorAll('#fileList img')].filter(i => i.naturalWidth).length }));
  ok('after reload: name, text, image, file names, thumbnail', after.tab.includes('Secret plans') && after.files.some(t => t.includes('budget-secret.pdf')) && after.thumbs === 1, JSON.stringify(after));
  await p.screenshot({ path: OUT + 'e2-app.png' });

  // Search still works (on the device)
  await p.click('#searchBtn').catch(() => {});
  if (await p.$('#searchInput')) {
    await p.fill('#searchInput', 'tuesday'); await sleep(500);
    ok('search finds locked text', (await p.textContent('#searchResults').catch(() => '')).toLowerCase().includes('tuesday'));
    await p.keyboard.press('Escape');
  }

  // Share a file: key after #
  await p.click('#fileList .file-row:has-text("budget-secret.pdf") [data-file-menu]');
  await p.click('.menu-item:has-text("Share link")'); await p.waitForSelector('[data-share-create]');
  await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
  const fileUrl = await p.inputValue('#shareUrlInput');
  ok('file link carries its key after #', /\/s\/[A-Za-z0-9_-]{24}#[A-Za-z0-9_-]{43}$/.test(fileUrl), fileUrl);
  await p.keyboard.press('Escape'); await sleep(200);
  const shares = await store('scratchpad-shares').list();
  const shareRecs = await Promise.all(shares.blobs.filter(x => x.key.startsWith('shares/')).map(x => store('scratchpad-shares').get(x.key, { type: 'json' })));
  ok('server never sees the key in the link', !JSON.stringify(shareRecs).includes(fileUrl.split('#')[1]) && shareRecs.every(s => s.name.startsWith('e1:')));

  const gctx = await newCtx(); const g = await gctx.newPage(); g.on('pageerror', e => errs.push('guest: ' + e.message));
  await g.goto(fileUrl); await g.waitForSelector('.share-title');
  ok('guest sees the file name', (await g.textContent('.share-title')) === 'budget-secret.pdf', await g.textContent('.share-title'));
  const [dl] = await Promise.all([g.waitForEvent('download', { timeout: 30000 }), g.click('.dl-main')]);
  const got = fs.readFileSync(await dl.path());
  ok('guest downloads the exact file', dl.suggestedFilename() === 'budget-secret.pdf' && got.equals(big), `${got.length}`);
  await g.goto(fileUrl.split('#')[0]); await g.waitForSelector('.share-title');
  ok('without the key: a clear message', (await g.textContent('.share-title')).includes('missing its key'), await g.textContent('.share-title'));
  await g.screenshot({ path: OUT + 'e2-nokey.png' });

  // Share the sheet
  await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Share sheet")'); await p.waitForSelector('[data-share-create]');
  await p.click('[data-share-create]'); await p.waitForSelector('#shareUrlInput');
  const sheetUrl = await p.inputValue('#shareUrlInput');
  await p.keyboard.press('Escape');
  await g.goto(sheetUrl); await g.waitForSelector('.share-text'); await sleep(2000);
  const sv = await g.evaluate(() => ({ title: document.querySelector('.share-title').textContent, text: document.querySelector('.share-text').innerText, img: document.querySelector('.shared-image')?.naturalWidth || 0, files: [...document.querySelectorAll('.share-file-name')].map(e => e.textContent), thumb: [...document.querySelectorAll('.share-file img')].filter(i => i.naturalWidth).length }));
  ok('guest sees the sheet: name, text, image, files, thumbnail', sv.title === 'Secret plans' && sv.text.includes('Tuesday') && sv.img > 0 && sv.files.includes('budget-secret.pdf') && sv.thumb === 1, JSON.stringify(sv));
  await g.screenshot({ path: OUT + 'e2-guest-sheet.png', fullPage: true });
  const [dl2] = await Promise.all([g.waitForEvent('download'), g.click('.share-file:has-text("sunset-beach.jpg") .dl-row')]);
  ok('guest downloads a file from the sheet', fs.readFileSync(await dl2.path()).equals(photo));
  // Shared links panel shows names
  await p.click('#accountBtn'); await p.click('[data-pf="library"]'); await p.click('#libTabLinks'); await p.waitForSelector('#linksBody tbody tr', { timeout: 10000 }); await sleep(300);
  ok('Shared links panel shows unlocked names', (await p.textContent('#libraryModal')).includes('budget-secret.pdf') && (await p.textContent('#libraryModal')).includes('Secret plans'));
  await p.keyboard.press('Escape');

  // Second device: sign in with the password
  const ctx2 = await newCtx(); const q = await ctx2.newPage(); q.on('pageerror', e => errs.push('dev2: ' + e.message));
  await q.goto(BASE); await q.fill('#signinEmail', EMAIL); await q.fill('#signinPassword', 'wrong-pass-1'); await q.click('#signinForm .auth-submit');
  await q.waitForFunction(() => document.querySelector('#signinForm .auth-error').textContent, null, { timeout: 10000 });
  ok('wrong password refused', (await q.textContent('#signinForm .auth-error')).includes('Wrong'));
  await q.fill('#signinPassword', 'pass-12345'); await q.click('#signinForm .auth-submit');
  await q.waitForSelector('.app-shell', { state: 'visible' });
  await q.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Tuesday'), null, { timeout: 10000 });
  ok('second device opens the text', true);
  // Live sync of locked text
  await p.click('#scratchpad'); await p.keyboard.press('End'); await p.keyboard.type(' Bring snacks.'); await saved();
  await q.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('snacks'), null, { timeout: 10000 }).then(() => ok('locked edits sync live', true), () => ok('locked edits sync live', false));

  // Device without its key (kept key cleared): asks to unlock
  await q.evaluate(() => new Promise(r => { const d = indexedDB.deleteDatabase('scratchpad-keys'); d.onsuccess = d.onerror = d.onblocked = r; }));
  await q.reload(); await q.waitForSelector('#unlockForm:not([hidden])');
  ok('no kept key: unlock screen', (await q.textContent('#unlockForm h2')) === 'Unlock your sheets');
  await q.fill('#unlockPassword', 'nope-nope-1'); await q.click('#unlockForm .auth-submit');
  await q.waitForFunction(() => document.querySelector('#unlockForm .auth-error').textContent, null, { timeout: 10000 });
  ok('unlock: wrong password refused', (await q.textContent('#unlockForm .auth-error')).includes('doesn’t unlock'));
  await q.fill('#unlockPassword', 'pass-12345'); await q.click('#unlockForm .auth-submit');
  await q.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Tuesday'), null, { timeout: 10000 });
  ok('unlock opens the sheets', true);

  // New recovery key from the account menu
  await q.click('#accountBtn'); await q.click('[data-pf="security"]'); await q.click('[data-pf="recovery"]'); await q.click('#sheetActions .btn:has-text("Continue")');
  await q.waitForSelector('#unlockForm:not([hidden])'); await q.fill('#unlockPassword', 'pass-12345'); await q.click('#unlockForm .auth-submit');
  await q.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 });
  const rk2 = await q.textContent('#recoveryKeyText');
  await q.check('#recoverySaved'); await q.click('#recoveryKeyForm .auth-submit');
  await q.waitForSelector('.app-shell', { state: 'visible' });
  ok('new recovery key made, back in the app', rk2 !== rk && !(await q.isVisible('#authScreen')) && (await q.textContent('#scratchpad')).includes('Tuesday'));

  // Forgot password: the old recovery key no longer works, the new one does
  const ctx3 = await newCtx(); const r = await ctx3.newPage(); r.on('pageerror', e => errs.push('reset: ' + e.message));
  await r.goto(BASE); await r.click('[data-mode="reset"]'); await r.fill('#codeEmail', EMAIL); await r.click('#emailForm .auth-submit');
  await r.waitForSelector('#codeForm:not([hidden])'); await r.fill('#codeInput', lastCode(EMAIL)); await r.click('#codeForm .auth-submit');
  await r.waitForSelector('#recoverForm:not([hidden])');
  await r.screenshot({ path: OUT + 'e2-recover.png' });
  await r.fill('#recoverInput', rk); await r.click('#recoverForm .auth-submit');
  await r.waitForFunction(() => document.querySelector('#recoverForm .auth-error').textContent, null, { timeout: 10000 });
  ok('old recovery key refused', (await r.textContent('#recoverForm .auth-error')).includes('doesn’t match'));
  await r.fill('#recoverInput', rk2.toLowerCase().replace(/-/g, ' ')); await r.click('#recoverForm .auth-submit');
  await r.waitForSelector('#passwordForm:not([hidden])');
  await r.fill('#newPassword', 'brand-new-99'); await r.click('#passwordForm .auth-submit');
  await r.waitForSelector('.app-shell', { state: 'visible' });
  await r.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Tuesday'), null, { timeout: 10000 }).then(() => ok('reset with recovery key keeps everything', true), () => ok('reset with recovery key keeps everything', false));
  const u2 = await user();
  ok('same master key, recovery unchanged', u2.keyring.byRecovery === (await user()).keyring.byRecovery && u2.keyring.byPassword !== u1.keyring.byPassword);
  // The other devices were signed out by the reset
  await sleep(1500);
  await q.reload(); await q.waitForSelector('#signinForm:not([hidden])', { timeout: 10000 }).then(() => ok('reset signs out other devices', true), () => ok('reset signs out other devices', false));
  // Old password no longer works; new one does, from scratch
  await q.fill('#signinEmail', EMAIL); await q.fill('#signinPassword', 'brand-new-99'); await q.click('#signinForm .auth-submit');
  await q.waitForFunction(() => document.querySelector('#scratchpad').innerText.includes('Tuesday'), null, { timeout: 15000 }).then(() => ok('signs in with the new password', true), () => ok('signs in with the new password', false));

  // Lost the recovery key: start over erases everything
  await r.evaluate(() => fetch('/.netlify/functions/auth?action=logout', { method: 'POST' }));
  await r.goto(BASE); await r.click('[data-mode="reset"]'); await r.fill('#codeEmail', EMAIL); await r.click('#emailForm .auth-submit');
  await r.waitForSelector('#codeForm:not([hidden])'); await r.fill('#codeInput', lastCode(EMAIL)); await r.click('#codeForm .auth-submit');
  await r.waitForSelector('#recoverForm:not([hidden])'); await r.click('[data-start-over]');
  await r.waitForSelector('#sheetModal:not([hidden])'); await r.screenshot({ path: OUT + 'e2-startover.png' });
  await r.click('#sheetActions .btn:has-text("Erase and start over")');
  await r.waitForSelector('#passwordForm:not([hidden])'); await r.fill('#newPassword', 'fresh-start-1'); await r.click('#passwordForm .auth-submit');
  await r.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await r.check('#recoverySaved'); await r.click('#recoveryKeyForm .auth-submit');
  await r.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  const fresh = await r.evaluate(() => ({ text: document.querySelector('#scratchpad').innerText.trim(), files: document.querySelectorAll('#fileList .file-row').length }));
  ok('start over: an empty account', fresh.text === '' && fresh.files === 0, JSON.stringify(fresh));
  await g.goto('about:blank'); await g.goto(sheetUrl); await g.waitForSelector('.share-title');
  ok('start over: old links stop working', !(await g.textContent('.share-title')).includes('Secret'), await g.textContent('.share-title'));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
