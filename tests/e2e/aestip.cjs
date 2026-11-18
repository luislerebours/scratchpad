// "AES-256 (i)" on the sign-in page: tap on phones, hover/click/keyboard on desktop.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8970'; 
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = p => p.isVisible('#aesTip');
// The box sits beside the term, fully on screen, arrow pointing at it.
const placed = p => p.evaluate(() => {
  const t = [...document.querySelectorAll('.tip-term')].find(b => b.getAttribute('aria-expanded') === 'true');
  const box = document.querySelector('#aesTip').getBoundingClientRect(); const r = t.getBoundingClientRect();
  const side = document.querySelector('#aesTip').dataset.side;
  const gap = side === 'top' ? r.top - box.bottom : box.top - r.bottom;
  return { onScreen: box.left >= 8 && box.right <= innerWidth - 8 && box.top >= 0 && box.bottom <= innerHeight, gap: Math.round(gap), side };
});
(async () => {
  const b = await chromium.launch(); const errs = [];

  // ---- Phone: tap ----
  for (const theme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'] });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE); await p.evaluate(t => window.scratchTheme.set(t), theme); await p.reload(); await sleep(500);
    const term = '.auth-secure .tip-term';
    ok(`phone ${theme}: line reads "Protected with AES-256 encryption."`, (await p.textContent('.auth-secure')).trim() === 'Protected with AES-256 encryption.', await p.textContent('.auth-secure'));
    const off = await p.$eval('.auth-secure', el => { const s = el.querySelector(':scope > svg').getBoundingClientRect(); const t = el.querySelector(':scope > span').getBoundingClientRect(); return (s.top + s.height / 2) - (t.top + t.height / 2); });
    ok(`phone ${theme}: lock centered on the text`, Math.abs(off) <= 0.5, off.toFixed(2));
    ok(`phone ${theme}: closed to start`, !(await open(p)));
    await p.$eval(term, el => el.scrollIntoView({ block: 'center' })); await sleep(200);
    await p.tap(term); await sleep(200);
    ok(`phone ${theme}: a tap opens the box`, await open(p) && (await p.getAttribute(term, 'aria-expanded')) === 'true');
    ok(`phone ${theme}: it explains AES-256`, (await p.textContent('#aesTip')).includes('approves for protecting Top Secret information'));
    const pl = await placed(p);
    ok(`phone ${theme}: beside the term, fully on screen`, pl.onScreen && pl.gap >= 8 && pl.gap <= 16, JSON.stringify(pl));
    await p.screenshot({ path: OUT + `aestip-phone-${theme}.png` });
    await sleep(1500);
    ok(`phone ${theme}: stays open`, await open(p));
    await p.tap('#aesTip'); await sleep(150);
    ok(`phone ${theme}: tapping the box itself keeps it`, await open(p));
    await p.tap('.auth-card h1, .auth-card h2'); await sleep(150);
    ok(`phone ${theme}: a tap elsewhere closes it`, !(await open(p)));
    await p.tap(term); await sleep(150); await p.tap(term); await sleep(150);
    ok(`phone ${theme}: tapping the term again closes it`, !(await open(p)));
    await ctx.close();
  }

  // ---- Desktop: hover, click, keyboard ----
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }); p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE); await p.evaluate(t => window.scratchTheme.set(t), theme); await p.reload(); await sleep(500);
    const term = '.auth-perks .tip-term';
    ok(`desktop ${theme}: row ends "Protected with AES-256."`, (await p.textContent('.auth-perks li:first-child')).trim().endsWith('Protected with AES-256.'));
    await p.$eval(term, el => el.scrollIntoView({ block: 'center' })); await sleep(200);
    await p.hover(term); await sleep(200);
    ok(`desktop ${theme}: hover opens the box`, await open(p));
    const pl = await placed(p);
    ok(`desktop ${theme}: beside the term, on screen`, pl.onScreen && pl.gap >= 8 && pl.gap <= 16, JSON.stringify(pl));
    await p.hover('#aesTip'); await sleep(300);
    ok(`desktop ${theme}: moving onto the box keeps it`, await open(p));
    await p.screenshot({ path: OUT + `aestip-desktop-${theme}.png` });
    await p.mouse.move(5, 5); await sleep(400);
    ok(`desktop ${theme}: moving away closes it`, !(await open(p)));
    await p.click(term); await p.mouse.move(5, 5); await sleep(400);
    ok(`desktop ${theme}: a click keeps it open`, await open(p));
    await p.keyboard.press('Escape'); await sleep(150);
    ok(`desktop ${theme}: Escape closes it, focus back on the term`, !(await open(p)) && await p.evaluate(() => document.activeElement.classList.contains('tip-term')));
    await p.keyboard.press('Enter'); await sleep(150);
    ok(`desktop ${theme}: Enter opens it from the keyboard`, await open(p));
    await p.keyboard.press('Enter'); await sleep(150);
    ok(`desktop ${theme}: Enter again closes it`, !(await open(p)));
    await p.close();
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
