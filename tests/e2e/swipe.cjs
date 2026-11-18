const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'swipe' + Date.now() + '@example.com';
let fails = 0; const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:2, hasTouch:true, isMobile:true });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ x:x0, y:y0 }] });
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }] }); await sleep(16); }
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] }); await sleep(350);
  };
  const rowBox = async name => (await p.locator(`#fileList .file-row:has-text("${name}")`).boundingBox());
  const serverFiles = () => p.evaluate(() => fetch('/.netlify/functions/files?sheet=1').then(r => r.json()).then(d => d.files.map(f => ['a', 'b', 'c', 'd'][f.size - 1] + '-file.txt').sort()));

  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', EMAIL); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(EMAIL)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit'); await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state:'visible' }); await sleep(1200);
  // Tabs named like the mockup
  for (const [n, name] of [[2, 'LLM'], [3, 'Legal']]) {
    await p.click(`.sheet-tab[data-sheet="${n}"]`); await sleep(500);
    await p.click('#sheetMenuBtn'); await p.click('.menu-item:has-text("Rename sheet")'); await p.fill('#renameInput', name); await p.click('#renameForm button[type=submit]'); await sleep(500);
  }
  await p.click('.sheet-tab[data-sheet="3"]'); await sleep(500);
  await p.screenshot({ path: OUT + 'it-header.png', clip: { x: 0, y: 0, width: 390, height: 130 } });
  const tab = await p.$eval('.sheet-tab.active', t => { const c = getComputedStyle(t); return { h: t.offsetHeight, weight: c.fontWeight, size: c.fontSize, radius: c.borderRadius }; });
  ok('tabs: 44px tall, 16px semibold, rounded', tab.h >= 44 && tab.weight === '600' && tab.size === '16px', JSON.stringify(tab));
  ok('header uses the new mark', (await p.getAttribute('.topbar .brand-icon', 'src')).includes('mark.png'));
  await p.click('.sheet-tab[data-sheet="1"]'); await sleep(600);

  await p.setInputFiles('#fileInput', ['a', 'b', 'c', 'd'].map((n, i) => ({ name:`${n}-file.txt`, mimeType:'text/plain', buffer: Buffer.from(n.repeat(i + 1)) })));
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 4, null, { timeout: 15000 }); await sleep(2600);
  await p.$eval('#filesSection', el => el.scrollIntoView({ block:'start' })); await sleep(300);

  // Short swipe: Delete appears; file stays
  let r = await rowBox('a-file.txt');
  await drag(r.x + r.width - 40, r.y + r.height / 2, r.x + r.width - 140, r.y + r.height / 2);
  ok('short swipe opens the row', await p.$eval('#fileList .file-row:has-text("a-file.txt")', el => el.classList.contains('open')));
  ok('no preview opened by the swipe', await p.isHidden('#previewModal'));
  await p.screenshot({ path: OUT + 'it-swipe-open.png' });
  // Tap elsewhere closes
  await p.touchscreen.tap(20, 20); await sleep(300);
  ok('tap elsewhere closes it', !(await p.$eval('#fileList .file-row:has-text("a-file.txt")', el => el.classList.contains('open'))));

  // Swipe again and tap Delete -> gone with Undo, still on server
  r = await rowBox('a-file.txt');
  await drag(r.x + r.width - 40, r.y + r.height / 2, r.x + r.width - 140, r.y + r.height / 2);
  r = await rowBox('a-file.txt');
  await p.touchscreen.tap(r.x + r.width - 40, r.y + r.height / 2); await sleep(400);
  ok('tap Delete hides the file', !(await p.$('#fileList .file-row:has-text("a-file.txt")')));
  ok('message offers Undo', (await p.innerText('#toast')).replace(/\n/g, ' ') === 'Deleted a-file.txt Undo', await p.innerText('#toast'));
  await p.screenshot({ path: OUT + 'it-undo.png' });
  ok('not deleted on the server yet', (await serverFiles()).includes('a-file.txt'));
  ok('attachment count follows', (await p.textContent('#attachText')) === '3 attachments', await p.textContent('#attachText'));
  await p.click('#toast .toast-action'); await sleep(600);
  ok('Undo brings it back', Boolean(await p.$('#fileList .file-row:has-text("a-file.txt")')));
  await sleep(5000);
  ok('…and it is never deleted', (await serverFiles()).includes('a-file.txt'));

  // Long swipe: deletes straight away (after the Undo time)
  r = await rowBox('b-file.txt');
  await drag(r.x + r.width - 20, r.y + r.height / 2, r.x + 10, r.y + r.height / 2, 16);
  ok('long swipe deletes', !(await p.$('#fileList .file-row:has-text("b-file.txt")')));
  await sleep(5600);
  ok('deleted on the server after Undo time', !(await serverFiles()).includes('b-file.txt'));

  // Vertical drag on a row is a scroll, not a swipe
  r = await rowBox('c-file.txt');
  await drag(r.x + 200, r.y + r.height / 2, r.x + 190, r.y + r.height / 2 - 120);
  ok('vertical drag does not open the row', !(await p.$eval('#fileList .file-row:has-text("c-file.txt")', el => el.classList.contains('open') || el.querySelector('.file-row-inner').style.transform !== '')));

  // A tap on the name still previews
  r = await rowBox('c-file.txt');
  await p.locator('#fileList .file-row:has-text("c-file.txt") .file-name').tap(); await p.waitForSelector('#previewModal:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok('tap on a file still opens it', await p.isVisible('#previewModal'));
  await p.keyboard.press('Escape'); await sleep(300);

  // Leaving the page during Undo finishes the delete
  r = await rowBox('d-file.txt');
  await drag(r.x + r.width - 20, r.y + r.height / 2, r.x + 10, r.y + r.height / 2, 16); await sleep(300);
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await sleep(800);
  ok('leaving the page deletes right away', !(await serverFiles()).includes('d-file.txt'));

  // Menu delete still confirms
  await p.click('#fileList .file-row:has-text("c-file.txt") [data-file-menu]'); await p.click('.menu-item:has-text("Delete file")');
  ok('menu delete still asks first', (await p.textContent('#sheetTitle')) === 'Delete this file?');
  await p.click('#sheetActions button:has-text("Cancel")');

  // Mouse drags don't swipe
  const desk = await (await b.newContext({ viewport:{ width:1280, height:900 } })).newPage(); desk.on('pageerror', e => errs.push(e.message));
  await desk.goto(BASE); await desk.fill('#signinEmail', EMAIL); await desk.fill('#signinPassword', 'pass-12345'); await desk.click('#signinForm .auth-submit');
  await desk.waitForSelector('#fileList .file-row'); await sleep(800);
  const dr = await desk.locator('#fileList .file-row >> nth=0').boundingBox();
  await desk.mouse.move(dr.x + dr.width - 300, dr.y + dr.height / 2); await desk.mouse.down(); await desk.mouse.move(dr.x + 50, dr.y + dr.height / 2, { steps: 10 }); await desk.mouse.up(); await sleep(300);
  ok('mouse drag does nothing on desktop', (await desk.$$('#fileList .file-row')).length === 2 && !(await desk.$('.file-row.open')));
  await desk.$eval('#filesSection', el => el.scrollIntoView({ block:'center' }));
  await desk.screenshot({ path: OUT + 'it-desktop.png' });
  await p.evaluate(() => scrollTo(0, 0)); await sleep(200); await p.screenshot({ path: OUT + 'it-phone.png' });
  console.log('errors:', errs, '| fails:', fails); await b.close();
})();
