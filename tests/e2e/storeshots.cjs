// Raw screenshots for the Play Store listing: a demo account (made-up content),
// taken at phone, 7" and 10" tablet sizes, light and dark.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970';
const RAW = OUT + 'store/raw/';
const IMGS = __dirname + '/imgs/';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(RAW, { recursive: true });
const EMAIL = 'maya.lee@example.com';
const PASS = 'demo-pass-12345';
const SIZES = {
  phone: { viewport: { width: 412, height: 860 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  tablet7: { viewport: { width: 600, height: 960 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet10: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
};
const fakePdf = (n) => Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(n)]);

async function saved(p) { await p.waitForFunction(() => document.querySelector('#saveStatusText').textContent.startsWith('Synced'), null, { timeout: 10000 }); }
async function rename(p, name) {
  if (!(await p.isVisible('#renameModal'))) { await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); }
  await p.fill('#renameInput', name); await p.click('#renameForm button[type=submit]'); await sleep(700);
}
async function pasteImage(p, file) {
  const b64 = fs.readFileSync(IMGS + file).toString('base64');
  await p.evaluate(async ([b64, type]) => {
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const r = document.createRange(); r.selectNodeContents(pad); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
    const blob = await (await fetch(`data:${type};base64,${b64}`)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'photo', { type }));
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [b64, file.endsWith('.png') ? 'image/png' : 'image/jpeg']);
  await p.waitForFunction(() => [...document.querySelectorAll('#scratchpad img')].every(i => !i.dataset.pending && i.naturalWidth > 0), null, { timeout: 20000 });
}
async function upload(p, files, count) {
  await p.setInputFiles('#fileInput', files);
  await p.waitForFunction(n => document.querySelectorAll('#fileList .file-row').length === n, count, { timeout: 30000 });
  await sleep(800);
}

(async () => {
  const b = await chromium.launch();
  // ---- The demo account ----
  if (!process.env.SKIP_DATA) {
    const p = await (await b.newContext(SIZES.phone)).newPage();
    await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', EMAIL); await p.click('#emailForm .auth-submit');
    await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(EMAIL)); await p.click('#codeForm .auth-submit');
    await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', PASS); await p.click('#passwordForm .auth-submit');
    await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
    await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1000);
    // Five sheets to start: keep three, named
    for (const n of [5, 4]) {
      await p.click(`.sheet-tab >> nth=${n - 1}`); await sleep(500);
      await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Delete sheet")');
      await p.click('#sheetActions button:has-text("Delete")'); await sleep(900);
    }
    await p.click('.sheet-tab >> nth=2'); await sleep(500); await rename(p, 'Recipes');
    await p.click('#scratchpad'); await p.keyboard.type('Lemon pasta for 4\n- 400 g spaghetti\n- 2 lemons, zest and juice\n- Parmesan, black pepper, basil');
    await saved(p);
    await p.click('.sheet-tab >> nth=1'); await sleep(500); await rename(p, 'Work');
    await p.click('#scratchpad'); await p.keyboard.type('Q3 launch\n- Final deck to Priya by Thursday\n- Pricing page copy\n- Book the room for the demo');
    await saved(p);
    await upload(p, [{ name: 'launch-deck.pdf', mimeType: 'application/pdf', buffer: fakePdf(2_400_000) }, { name: 'budget-2027.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: crypto.randomBytes(180_000) }], 2);
    await p.click('.sheet-tab >> nth=0'); await sleep(500); await rename(p, 'Lisbon trip');
    await p.click('#scratchpad');
    await p.keyboard.type('Flight TP 202 · Fri 8:40 AM · Gate B12\nHotel: Casa do Largo, check-in after 3 PM\n\nTo do\n- Pastéis de Belém on Saturday morning\n- Tram 28 from Martim Moniz\n- Sunset at Miradouro da Senhora do Monte\n');
    await pasteImage(p, 'lisbon-miradouro.jpg');
    await saved(p);
    await upload(p, [
      { name: 'boarding-pass.pdf', mimeType: 'application/pdf', buffer: fakePdf(240_000) },
      { name: 'hotel-booking.pdf', mimeType: 'application/pdf', buffer: fakePdf(410_000) },
      { name: 'miradouro.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(IMGS + 'lisbon-miradouro.jpg') },
      { name: 'castelo-sao-jorge.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(IMGS + 'lisbon-castelo.jpg') }
    ], 4);
    await sleep(2500);
    await p.context().close();
  }

  // ---- Screenshots at each size ----
  for (const [size, opts] of Object.entries(SIZES).filter(([k]) => !process.env.ONLY || process.env.ONLY.split(',').includes(k))) {
    const ctx = await b.newContext(opts);
    const p = await ctx.newPage();
    await p.goto(BASE); await p.evaluate(() => window.scratchTheme.set('light'));
    await p.fill('#signinEmail', EMAIL); await p.fill('#signinPassword', PASS); await p.click('#signinForm .auth-submit');
    await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
    const shot = async name => { await p.evaluate(() => { document.querySelector('#toast')?.classList.remove('show'); }); await sleep(300); await p.screenshot({ path: RAW + `${size}-${name}.png` }); };
    const top = async () => { await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300); };
    const blurAll = () => p.evaluate(() => { document.activeElement?.blur(); getSelection().removeAllRanges(); });

    await p.click('.sheet-tab >> nth=0'); await sleep(600); await blurAll(); await top();
    await shot('editor');
    await p.evaluate(() => document.querySelector('#filesSection').scrollIntoView({ block: 'start' })); await sleep(500);
    await shot('files');
    // Search
    await top(); await p.click('#searchBtn'); await p.fill('#searchInput', 'tram'); await sleep(600);
    await shot('search'); await p.keyboard.press('Escape'); await sleep(300);
    // Share a file
    await p.evaluate(() => document.querySelector('#filesSection').scrollIntoView({ block: 'start' })); await sleep(300);
    await p.click('#fileList .file-row:has-text("boarding-pass.pdf") [data-file-menu]'); await p.click('.menu-item:has-text("link")');
    await p.waitForSelector('[data-share-create], #shareUrlInput');
    if (await p.isVisible('[data-share-create]')) await p.click('[data-share-create]');
    await p.waitForSelector('#shareUrlInput'); await sleep(500);
    // The address people will see (these shots come from a local test server).
    await p.evaluate(() => { const i = document.querySelector('#shareUrlInput'); i.value = i.value.replace(/^http:\/\/localhost:\d+/, 'https://scrap.sector809labs.com'); i.blur(); getSelection().removeAllRanges(); i.setSelectionRange(0, 0); document.activeElement?.blur(); });
    await shot('share'); await p.keyboard.press('Escape'); await sleep(400);
    // Dark
    await p.evaluate(() => window.scratchTheme.set('dark')); await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
    await p.click('.sheet-tab >> nth=1'); await sleep(700); await blurAll(); await top();
    await shot('dark');
    await p.evaluate(() => window.scratchTheme.set('light'));
    // Share to ScrapSheet (what Android's Share menu sends)
    await p.reload(); await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1200);
    await p.click('.sheet-tab >> nth=0'); await sleep(600);
    await p.evaluate(async ([b64]) => {
      const f = document.createElement('form'); f.method = 'post'; f.enctype = 'multipart/form-data'; f.action = '/share-target'; f.id = 'osShare';
      const t = document.createElement('textarea'); t.name = 'text'; t.value = 'Table for 4 at Taberna da Rua das Flores, 8 PM'; f.append(t);
      const fi = document.createElement('input'); fi.type = 'file'; fi.name = 'files'; fi.id = 'osShareFiles'; f.append(fi);
      document.body.append(f);
    }, ['']);
    await p.setInputFiles('#osShareFiles', [{ name: 'dinner-reservation.png', mimeType: 'image/png', buffer: fs.readFileSync(IMGS + 'night-sky.png') }]);
    await Promise.all([p.waitForURL(u => u.pathname === '/'), p.evaluate(() => document.querySelector('#osShare').submit())]);
    await p.waitForSelector('#sheetModal:not([hidden])', { timeout: 20000 }); await sleep(500);
    await p.evaluate(() => document.activeElement?.blur());
    await shot('sharein');
    await p.click('#sheetModal button:has-text("Discard")'); await sleep(300);
    await ctx.close();

    // Signed out: the front page with the AES-256 note open
    const s = await (await b.newContext(opts)).newPage();
    await s.goto(BASE); await s.evaluate(() => window.scratchTheme.set('light')); await s.reload(); await sleep(600);
    await s.$eval('.auth-secure .tip-term', el => el.scrollIntoView({ block: 'end' }));
    await s.evaluate(() => window.scrollBy(0, 40)); await sleep(200);
    await s.click('.auth-secure .tip-term'); await sleep(300);
    await s.screenshot({ path: RAW + `${size}-secure.png` });
    await s.context().close();
    console.log('shot', size);
  }
  await b.close(); console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
