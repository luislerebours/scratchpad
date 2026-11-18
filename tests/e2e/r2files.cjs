// Files in Cloudflare R2 (through the relay): a file from before stays on
// Netlify and still works; new uploads go straight to R2; downloads (yours and
// share links) come from R2; passes can't be misused; deleting clears R2.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const BASE = 'http://localhost:8970'; const RELAY = 'http://localhost:8787';
const DIR = __dirname;
const log = () => fs.readFileSync(DIR + '/server.log', 'utf8');
const lastCode = email => [...log().matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'r2files' + Date.now() + '@example.com';
const restart = r2 => execFileSync('bash', [DIR + '/restart-server.sh'], { env: { ...process.env, FILES_R2: r2, NEW_ACCOUNT_PLAN: 'pro' } }).toString().trim();

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  process.env.SYNC_URL = RELAY; process.env.FILES_R2 = '1';
  const { userStore, emailKey, authStore } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/auth.mjs').href);
  const r2 = await import(require('url').pathToFileURL(REPO + '/netlify/lib/r2.mjs').href);

  ok('(server restarted with R2 off)', restart('0') === 'restarted');
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const reqs = []; p.on('request', r => reqs.push(`${r.method()} ${r.url()}`));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', E); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(E)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  const ns = (await authStore().get(`users/${emailKey(E)}`, { type: 'json' })).ns;
  const records = async () => { const s = userStore(ns, 'files', 1); const { blobs } = await s.list(); return Promise.all(blobs.map(x => s.get(x.key, { type: 'json' }))); };

  // ---- A file from before (R2 off): on Netlify ----
  const old = crypto.randomBytes(5_000_000);
  await p.setInputFiles('#fileInput', [{ name: 'old-report.pdf', mimeType: 'application/pdf', buffer: old }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 });
  ok('with R2 off, a file is stored on Netlify', (await records())[0].store === undefined);

  // ---- R2 on: new uploads go straight to R2 ----
  ok('(server restarted with R2 on)', restart('1') === 'restarted');
  await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  reqs.length = 0;
  const big = crypto.randomBytes(9_500_000); // 10 pieces of 1 MB
  await p.setInputFiles('#fileInput', [{ name: 'trip-video.mp4', mimeType: 'video/mp4', buffer: big }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 });
  const puts = reqs.filter(r => r.startsWith('PUT'));
  ok('its pieces go to the relay (R2), not Netlify', puts.length === 10 && puts.every(r => r.startsWith(`PUT ${RELAY}/files/up?`)), puts.map(r => r.slice(0, 50)).join(' | '));
  const rec = (await records()).find(r => r.store === 'r2');
  ok('the file’s record says R2', Boolean(rec) && rec.chunks === 10 && rec.chunkSize === 1_000_000 && rec.complete);
  const sizes = await r2.pieceSizes(ns, 1, rec);
  ok('R2 holds 10 pieces of 1 MB, each 28 bytes bigger than the plain data (encrypted)', JSON.stringify(sizes) === JSON.stringify([...Array(9).fill(1_000_028), 500_028]), JSON.stringify(sizes));
  const stored = await (await fetch(await r2.pieceUrl(ns, 1, rec, 0))).arrayBuffer();
  ok('what R2 holds isn’t the file (it’s ciphertext)', !Buffer.from(stored).subarray(0, 64).equals(big.subarray(0, 64)));

  // ---- Downloads: both come back byte for byte ----
  const download = async name => {
    reqs.length = 0;
    const dl = p.waitForEvent('download', { timeout: 30000 });
    await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click('.menu-item:has-text("Download")');
    return fs.readFileSync(await (await dl).path());
  };
  ok('the R2 file downloads whole', Buffer.compare(await download('trip-video.mp4'), big) === 0);
  ok('…its pieces come from R2', reqs.filter(r => r.startsWith(`GET ${RELAY}/files/get?`)).length === 10, String(reqs.filter(r => r.includes('/files/get')).length));
  ok('the older Netlify file still downloads whole', Buffer.compare(await download('old-report.pdf'), old) === 0);
  ok('…from Netlify', !reqs.some(r => r.includes(RELAY)));

  // ---- Passes can't be misused ----
  const putUrl = (await r2.uploadTarget(ns, 1, rec, 1_000_028)).url;
  // Edit the pass's signed content (claim another account's folder), keep the old signature.
  const tok = decodeURIComponent(new URL(putUrl).searchParams.get('t'));
  const [body, sig] = tok.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: 'files/someone-else/1/x' })).toString('base64url');
  const tamper = `${RELAY}/files/up?t=${encodeURIComponent(edited + '.' + sig)}`;
  ok('a made-up pass is refused', (await fetch(`${RELAY}/files/get?t=nope.nope&i=0`)).status === 401);
  ok('an edited pass is refused', (await fetch(`${tamper}&i=0`, { method: 'PUT', body: Buffer.alloc(10) })).status === 401);
  ok('a pass can’t be used for something else (upload pass to download)', (await fetch(putUrl.replace('/files/up?', '/files/get?') + '&i=0')).status === 401);
  ok('a piece number outside the file is refused', (await fetch(`${putUrl}&i=10`, { method: 'PUT', body: Buffer.alloc(10) })).status === 400);
  ok('a piece bigger than allowed is refused', (await fetch(`${putUrl}&i=0`, { method: 'PUT', body: Buffer.alloc(1_000_100) })).status === 413);
  const over = await fetch(`${putUrl}&i=0`, { method: 'PUT', body: Buffer.alloc(1_000_028) });
  ok('a finished file’s piece can’t be overwritten (same size: kept as it was)', over.status === 200 && (await over.json()).kept === true);
  ok('…and a different size is refused', (await fetch(`${putUrl}&i=0`, { method: 'PUT', body: Buffer.alloc(10) })).status === 409);
  ok('…so the stored piece is unchanged', Buffer.compare(Buffer.from(await (await fetch(await r2.pieceUrl(ns, 1, rec, 0))).arrayBuffer()), Buffer.from(stored)) === 0);
  const netlifyPut = await p.evaluate(async ([id]) => (await fetch(`/.netlify/functions/files?sheet=1&id=${id}&chunk=0`, { method: 'PUT', body: new Uint8Array(10) })).status, [rec.id]);
  ok('Netlify won’t take pieces of a finished R2 file', netlifyPut === 409, String(netlifyPut));

  // ---- Share link: counted on Netlify, downloaded from R2 ----
  await p.click('#fileList .file-row:has-text("trip-video.mp4") [data-file-menu]'); await p.click('.menu-item:has-text("link")');
  await p.waitForSelector('[data-share-create], #shareUrlInput');
  if (await p.isVisible('[data-share-create]')) await p.click('[data-share-create]');
  await p.waitForSelector('#shareUrlInput'); const link = await p.inputValue('#shareUrlInput'); await p.keyboard.press('Escape');
  const g = await (await b.newContext({ acceptDownloads: true })).newPage(); const greqs = []; g.on('request', r => greqs.push(r.url()));
  await g.goto(link); await g.waitForSelector('[data-download], .share-download, button:has-text("Download")', { timeout: 20000 });
  const gdl = g.waitForEvent('download', { timeout: 30000 });
  await g.click('[data-download], .share-download, button:has-text("Download")');
  ok('a share link’s download comes back whole', Buffer.compare(fs.readFileSync(await (await gdl).path()), big) === 0);
  ok('…from R2, after Netlify counted it', greqs.filter(u => u.startsWith(`${RELAY}/files/get?`)).length === 10 && greqs.filter(u => u.includes('/.netlify/functions/share?') && u.includes('chunk=')).length === 10);

  // ---- Deleting clears R2 ----
  await p.click('#fileList .file-row:has-text("trip-video.mp4") [data-file-menu]'); await p.click('.menu-item:has-text("Delete file")');
  await p.click('#sheetActions button:has-text("Delete")'); await sleep(6000);
  ok('in Recently Deleted, the pieces are kept (it can be restored)', (await r2.pieceSizes(ns, 1, rec)).every(s => s !== null));
  const purged = await p.evaluate(async ([id]) => (await fetch('/.netlify/functions/state?meta=trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-file', sheet: 1, id }) })).status, [rec.id]);
  ok('deleting it for good clears its pieces from R2', purged === 200 && (await r2.pieceSizes(ns, 1, rec)).every(s => s === null), String(purged));
  const third = crypto.randomBytes(2_000_000);
  await p.setInputFiles('#fileInput', [{ name: 'last.bin', mimeType: 'application/octet-stream', buffer: third }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 });
  const rec3 = (await records()).find(r => r.store === 'r2' && r.id !== rec.id);
  await p.click('#accountBtn'); await p.click('[data-pf="security"]'); await p.click('[data-pf="delete"]'); await p.waitForSelector('#deleteAccountModal:not([hidden])');
  await p.fill('#deleteAccountPassword', 'pass-12345'); await p.click('#deleteAccountForm [type=submit]');
  await p.waitForFunction(() => !document.querySelector('#authScreen').hidden, null, { timeout: 30000 });
  ok('deleting the account clears its files from R2', (await r2.pieceSizes(ns, 1, rec3)).every(s => s === null));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
