// Rename a file, move a file to another sheet (stored in R2 or on Netlify), and
// reorder sheet tabs by dragging (mouse; touch and hold on a phone).
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const BASE = 'http://localhost:8970'; 
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const E = 'filestabs' + Date.now() + '@example.com';

(async () => {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
  process.env.SYNC_URL = 'http://localhost:8787'; process.env.FILES_R2 = '1';
  const { userStore, emailKey, authStore } = await import(require('url').pathToFileURL(REPO + '/netlify/lib/auth.mjs').href);
  const r2 = await import(require('url').pathToFileURL(REPO + '/netlify/lib/r2.mjs').href);
  const b = await chromium.launch(); const errs = [];
  const A = await (await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage(); A.on('pageerror', e => errs.push(e.message));
  await A.goto(BASE); await A.click('.auth-create'); await A.fill('#codeEmail', E); await A.click('#emailForm .auth-submit');
  await A.waitForSelector('#codeForm:not([hidden])'); await A.fill('#codeInput', lastCode(E)); await A.click('#codeForm .auth-submit');
  await A.waitForSelector('#passwordForm:not([hidden])'); await A.fill('#newPassword', 'pass-12345'); await A.click('#passwordForm .auth-submit');
  await A.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await A.check('#recoverySaved'); await A.click('#recoveryKeyForm .auth-submit');
  await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);
  const ns = (await authStore().get(`users/${emailKey(E)}`, { type: 'json' })).ns;
  const recordsOf = async sheet => { const s = userStore(ns, 'files', sheet); const { blobs } = await s.list(); return Promise.all(blobs.map(x => s.get(x.key, { type: 'json' }))); };
  const rows = p => p.$$eval('#fileList .file-row .file-name', els => els.map(e => e.textContent));
  const tabsOrder = p => p.$$eval('.sheet-tab .sheet-label', els => els.map(e => e.textContent));
  const download = async (p, name) => {
    const dl = p.waitForEvent('download', { timeout: 30000 });
    await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click('.menu-item:has-text("Download")');
    return fs.readFileSync(await (await dl).path());
  };
  const menu = async (p, name, item) => { await p.click(`#fileList .file-row:has-text("${name}") [data-file-menu]`); await p.click(`.menu-item:has-text("${item}")`); };

  // Files: one in R2, one on Netlify (as a page without live sync would store it).
  const big = crypto.randomBytes(2_600_000); const small = crypto.randomBytes(300_000);
  await A.setInputFiles('#fileInput', [{ name: 'trip-plan.pdf', mimeType: 'application/pdf', buffer: big }]);
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 30000 });
  await A.route(/functions\/files\?.*action=start/, async route => { const body = JSON.parse(route.request().postData()); delete body.direct; route.continue({ postData: JSON.stringify(body) }); });
  await A.setInputFiles('#fileInput', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: small }]);
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 2, null, { timeout: 30000 });
  await A.unroute(/functions\/files\?.*action=start/);
  const recs = await recordsOf(1);
  ok('(one file in R2, one on Netlify)', recs.some(r => r.store === 'r2') && recs.some(r => !r.store));

  // The Files heading carries the same paperclip as the tab's file count.
  await A.waitForSelector('.sheet-tab .tab-files svg path');
  const clip = await A.evaluate(() => {
    const h = document.querySelector('#filesHeading'); const svg = h.querySelector('svg'); const s = svg.getBoundingClientRect();
    const r = document.createRange(); r.selectNodeContents(h.lastChild); const t = r.getBoundingClientRect();
    return { head: svg.querySelector('path').getAttribute('d'), tab: document.querySelector('.sheet-tab .tab-files svg path').getAttribute('d'),
      text: h.textContent, hidden: svg.getAttribute('aria-hidden'), before: s.right <= t.left, gap: t.left - s.right,
      level: Math.abs((s.top + s.bottom) / 2 - (t.top + t.bottom) / 2), size: s.width };
  });
  ok('Files heading shows the tabs’ paperclip', clip.head === clip.tab && clip.size > 16, `${Math.round(clip.size)}px`);
  ok('the paperclip sits just left of “Files”, level with it', clip.before && clip.gap > 3 && clip.gap < 14 && clip.level < 3, `gap ${Math.round(clip.gap)}px, off ${clip.level.toFixed(1)}px`);
  ok('the heading still reads “Files” (the icon is hidden from screen readers)', clip.text === 'Files' && clip.hidden === 'true');
  const tapFlash = await A.$eval('#filesHeading', h => getComputedStyle(h).webkitTapHighlightColor);
  ok('tapping the heading doesn’t flash (it isn’t a button)', /rgba\(0, 0, 0, 0\)|transparent/.test(tapFlash), tapFlash);

  // A second device.
  const B = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true })).newPage(); B.on('pageerror', e => errs.push('B ' + e.message));
  await B.goto(BASE); await B.fill('#signinEmail', E); await B.fill('#signinPassword', 'pass-12345'); await B.click('#signinForm .auth-submit');
  await B.waitForSelector('.app-shell', { state: 'visible' }); await sleep(2500);

  // ---- Rename ----
  await menu(A, 'trip-plan.pdf', 'Rename');
  await A.waitForSelector('#renameModal:not([hidden])');
  ok('Rename opens with the name, the part before .pdf selected', (await A.inputValue('#renameInput')) === 'trip-plan.pdf' && (await A.evaluate(() => [renameInput.selectionStart, renameInput.selectionEnd].join())) === '0,9' && (await A.textContent('#renameTitle')) === 'Rename file');
  await A.keyboard.type('lisbon-itinerary'); await A.keyboard.press('Enter');
  await A.waitForFunction(() => [...document.querySelectorAll('#fileList .file-name')].some(e => e.textContent === 'lisbon-itinerary.pdf'), null, { timeout: 10000 })
    .then(() => ok('the file is renamed', true), () => ok('the file is renamed', false));
  const renamed = (await recordsOf(1)).find(r => r.store === 'r2');
  ok('…its new name is stored locked', String(renamed.name).startsWith('e1:'));
  await B.waitForFunction(() => [...document.querySelectorAll('#fileList .file-name')].some(e => e.textContent === 'lisbon-itinerary.pdf'), null, { timeout: 10000 })
    .then(() => ok('…and shows on the other device', true), () => ok('…and shows on the other device', false));
  ok('renaming a sheet still works the same dialog', await (async () => {
    await A.dblclick('.sheet-tab >> nth=0'); await A.waitForSelector('#renameModal:not([hidden])');
    const t = await A.textContent('#renameTitle'); await A.fill('#renameInput', 'Trips'); await A.keyboard.press('Enter'); await sleep(800);
    return t === 'Rename sheet' && (await tabsOrder(A))[0] === 'Trips';
  })());

  // ---- Move (R2 file) ----
  await menu(A, 'lisbon-itinerary.pdf', 'Move to');
  await A.waitForSelector('#sheetModal:not([hidden])');
  ok('Move to… lists the other sheets', (await A.$$eval('#sheetActions button', bs => bs.map(b => b.textContent))).join() === 'Sheet 2,Sheet 3,Sheet 4,Sheet 5,Cancel');
  await A.click('#sheetActions button:has-text("Sheet 2")');
  await A.waitForFunction(() => ![...document.querySelectorAll('#fileList .file-name')].some(e => e.textContent === 'lisbon-itinerary.pdf'), null, { timeout: 30000 });
  ok('moved: gone from this sheet', (await rows(A)).join() === 'notes.txt');
  const moved = (await recordsOf(2)).find(r => r.complete);
  ok('…stored in R2 in the other sheet, finished, with its dates', moved?.store === 'r2' && moved.uploadedAt === renamed.uploadedAt && !moved.moveOf);
  ok('…the original’s pieces are gone from R2', (await r2.pieceSizes(ns, 1, renamed)).every(s => s === null));
  ok('…nothing left of it in the first sheet', !(await recordsOf(1)).some(r => r.id === renamed.id));
  await A.click('.sheet-tab >> nth=1'); await sleep(1200);
  ok('…and it’s in Sheet 2', (await rows(A)).join() === 'lisbon-itinerary.pdf');
  await sleep(2600);
  ok('…downloads whole there (its key was re-locked for Sheet 2)', Buffer.compare(await download(A, 'lisbon-itinerary.pdf'), big) === 0);

  // ---- Move (Netlify file), from the other device ----
  await B.click('.sheet-tab >> nth=0'); await sleep(1000);
  await B.click('#fileList .file-row:has-text("notes.txt") [data-file-menu]'); await B.click('.menu-item:has-text("Move to")');
  await B.click('#sheetActions button:has-text("Sheet 3")');
  await B.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 0, null, { timeout: 30000 })
    .then(() => ok('a Netlify-stored file moves too (from the phone)', true), () => ok('a Netlify-stored file moves too (from the phone)', false));
  await A.click('.sheet-tab >> nth=2'); await sleep(1500);
  await sleep(2600);
  ok('…and downloads whole in Sheet 3', Buffer.compare(await download(A, 'notes.txt'), small) === 0);

  // ---- Reorder tabs with a mouse ----
  await A.click('.sheet-tab >> nth=0'); await sleep(600);
  const before = await tabsOrder(A);
  const t0 = await A.$eval('.sheet-tab >> nth=0', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const t2 = await A.$eval('.sheet-tab:nth-child(3)', el => { const r = el.getBoundingClientRect(); return { x: r.right - 5, y: r.y + r.height / 2 }; });
  await A.mouse.move(t0.x, t0.y); await A.mouse.down();
  // While dragging: the tab stays under the pointer, and the tabs it passes slide over (not jump).
  let worst = 0, slid = false;
  for (let i = 1; i <= 12; i++) {
    const x = t0.x + (t2.x - t0.x) * i / 12;
    await A.mouse.move(x, t0.y, { steps: 2 });
    const probe = await A.evaluate(() => {
      const dragged = document.querySelector('.sheet-tab.dragging');
      if (!dragged) return null;
      const r = dragged.getBoundingClientRect();
      const sliding = [...document.querySelectorAll('.sheet-tab:not(.dragging)')].some(t => Math.abs(parseFloat(getComputedStyle(t).translate) || 0) > 0.5);
      return { center: r.left + r.width / 2, sliding };
    });
    if (!probe) { worst = Infinity; continue; }
    worst = Math.max(worst, Math.abs(probe.center - x));
    slid ||= probe.sliding;
  }
  ok('the dragged tab follows the mouse', worst < 2, `off by up to ${worst.toFixed(1)} px`);
  ok('…and the tabs it passes slide out of its way', slid);
  await A.mouse.up(); await sleep(1200);
  ok('…then it settles into its place, leaving nothing behind', await A.evaluate(() => !document.querySelector('.sheet-tab.dragging, .sheet-tab.settling') && [...document.querySelectorAll('.sheet-tab')].every(t => !t.style.translate && !t.style.transition)));
  const after = await tabsOrder(A);
  ok('dragging a tab with the mouse moves it', after.join() === [before[1], before[2], before[0], ...before.slice(3)].join(), `${before} → ${after}`);
  ok('…without opening it on letting go', await A.$eval('.sheet-tab.active .sheet-label', e => e.textContent) === before[0]);
  await B.waitForFunction(o => [...document.querySelectorAll('.sheet-tab .sheet-label')].map(e => e.textContent).join() === o, after.join(), { timeout: 10000 })
    .then(() => ok('…and the other device gets the new order', true), () => ok('…and the other device gets the new order', false));
  await A.reload(); await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…which stays after a reload', (await tabsOrder(A)).join() === after.join());

  // ---- Reorder on a phone: touch and hold, then drag; a quick swipe doesn't ----
  const cdp = await B.context().newCDPSession(B);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const center = async n => B.$eval(`.sheet-tab:nth-child(${n})`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right }; });
  const phoneBefore = await tabsOrder(B);
  let s = await center(1), d = await center(2);
  await touch('touchStart', s.x, s.y);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', s.x + (d.right + 6 - s.x) * i / 6, s.y); await sleep(15); }
  await touch('touchEnd'); await sleep(800);
  ok('a quick swipe on the tabs doesn’t reorder them', (await tabsOrder(B)).join() === phoneBefore.join());
  s = await center(1); d = await center(2);
  const layout = () => B.evaluate(() => ({ tab2: document.querySelector('.sheet-tab:nth-child(2)').getBoundingClientRect().top, card: document.querySelector('.pad-card').getBoundingClientRect().top, add: document.querySelector('#addSheetBtn').getBoundingClientRect().top }));
  const restLayout = await layout();
  await touch('touchStart', s.x, s.y); await sleep(300);
  ok('holding a tab for 300 ms picks it up (the hold is 260 ms)', await B.$('.sheet-tab.dragging') !== null);
  await sleep(250);
  const held = await B.evaluate(() => {
    const dragged = document.querySelector('.sheet-tab.dragging'); if (!dragged) return null;
    const others = [...document.querySelectorAll('.sheet-tab:not(.dragging)')];
    return { lift: others[0].getBoundingClientRect().top - dragged.getBoundingClientRect().top, dim: Math.max(...others.map(t => Number(getComputedStyle(t).opacity))) };
  });
  ok('…it rises off the row while the other tabs dim', held && held.lift > 5 && held.dim < 0.6, JSON.stringify(held));
  // The row clips what sticks out of it: while held, it reaches far enough for the rise and the shadow.
  const room = await B.evaluate(() => {
    const t = document.querySelector('.sheet-tab.dragging').getBoundingClientRect(); const r = document.querySelector('#tabsScroller').getBoundingClientRect();
    return { above: Math.round(t.top - r.top), below: Math.round(r.bottom - t.bottom) };
  });
  ok('…with nothing cut off: room above and below the held tab for it and its shadow', room.above >= 18 && room.below >= 34, JSON.stringify(room));
  const heldLayout = await layout();
  ok('…and making that room moves nothing else', JSON.stringify(heldLayout) === JSON.stringify(restLayout), `${JSON.stringify(restLayout)} → ${JSON.stringify(heldLayout)}`);
  // One slot along: the finger moves as far as the next tab's right edge is from this one's.
  for (let i = 1; i <= 8; i++) { await touch('touchMove', s.x + (d.right - s.right + 4) * i / 8, s.y); await sleep(30); }
  await B.screenshot({ path: OUT + 'tab-drag.png', clip: { x: 0, y: 40, width: 390, height: 120 } });
  await touch('touchEnd'); await sleep(1200);
  const phoneAfter = await tabsOrder(B);
  ok('…and after letting go the tabs are bright and level again', await B.evaluate(() => [...document.querySelectorAll('.sheet-tab')].every(t => Number(getComputedStyle(t).opacity) === 1 && getComputedStyle(t).transform === 'none')));
  ok('…and the row gives back the extra room (it would catch taps meant for the buttons above)', await B.evaluate(() => { const c = getComputedStyle(document.querySelector('#tabsScroller')); return c.paddingTop === '0px' && c.paddingBottom === '0px'; }));
  ok('touch and hold, then drag, moves a tab on a phone', phoneAfter.join() === [phoneBefore[1], phoneBefore[0], ...phoneBefore.slice(2)].join(), `${phoneBefore} → ${phoneAfter}`);

  // Holding a dragged tab near the strip's edge scrolls the tabs along.
  const strip = await B.$eval('#tabsScroller', el => { const r = el.getBoundingClientRect(); return { right: r.right, scroll: el.scrollLeft, max: el.scrollWidth - el.clientWidth }; });
  if (strip.max > 0) {
    s = await center(1);
    await touch('touchStart', s.x, s.y); await sleep(500);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', s.x + (strip.right - 10 - s.x) * i / 6, s.y); await sleep(30); }
    await sleep(700);
    const scrolled = await B.$eval('#tabsScroller', el => el.scrollLeft);
    await touch('touchEnd'); await sleep(1200);
    ok('holding a dragged tab near the edge scrolls the tabs along', scrolled > strip.scroll, `${strip.scroll} → ${scrolled}`);
  } else ok('(the tabs fit the phone screen: no edge scrolling to check)', true);

  // With reduced motion, the tabs jump into place instead of sliding.
  await sleep(1500);
  await A.emulateMedia({ reducedMotion: 'reduce' });
  const m0 = await A.$eval('.sheet-tab:nth-child(1)', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right }; });
  const m1 = await A.$eval('.sheet-tab:nth-child(2)', el => el.getBoundingClientRect().right);
  await A.mouse.move(m0.x, m0.y); await A.mouse.down();
  let anySlide = false;
  for (let i = 1; i <= 8; i++) {
    await A.mouse.move(m0.x + (m1 - m0.right + 4) * i / 8, m0.y, { steps: 2 });
    anySlide ||= await A.evaluate(() => [...document.querySelectorAll('.sheet-tab:not(.dragging)')].some(t => Math.abs(parseFloat(getComputedStyle(t).translate) || 0) > 0.5));
  }
  await A.mouse.up(); await sleep(800);
  ok('with reduced motion, the other tabs jump instead of sliding', !anySlide);
  await A.emulateMedia({ reducedMotion: 'no-preference' });

  // Dropping a tab and grabbing another while the first still glides home: both moves count.
  await sleep(1500);
  const q0 = await tabsOrder(A);
  const dragOneSlot = async n => {
    const from = await A.$eval(`.sheet-tab:nth-child(${n})`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right }; });
    const toRight = await A.$eval(`.sheet-tab:nth-child(${n + 1})`, el => el.getBoundingClientRect().right);
    await A.mouse.move(from.x, from.y); await A.mouse.down();
    for (let i = 1; i <= 6; i++) await A.mouse.move(from.x + (toRight - from.right + 4) * i / 6, from.y, { steps: 2 });
    await A.mouse.up();
  };
  await dragOneSlot(1); await sleep(60); await dragOneSlot(3); await sleep(1500);
  const q1 = await tabsOrder(A);
  const want = [q0[1], q0[0], q0[3], q0[2], ...q0.slice(4)];
  ok('a second drag right after the first one works too', q1.join() === want.join(), `${q0} → ${q1}`);
  await A.reload(); await A.waitForSelector('.app-shell', { state: 'visible' }); await sleep(1500);
  ok('…and both moves were saved', (await tabsOrder(A)).join() === want.join());

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
