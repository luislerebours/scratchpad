// Share from multi-select: the bar's look, and the real files handed to the share menu.
const REPO = require('path').resolve(__dirname, '../..');
const OUT = require('path').join(__dirname, 'out') + '/'; require('fs').mkdirSync(OUT + 'store/raw', { recursive: true });
const { chromium, devices } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8970';
const IMG = __dirname + '/imgs/';
const lastCode = email => [...fs.readFileSync(__dirname + '/server.log', 'utf8').matchAll(/\[dev mail\] to (\S+): code (\S+)/g)].filter(x => x[1] === email).pop()[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'ms' + Date.now() + '@example.com';
let fails = 0; const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 14 Pro'], acceptDownloads: true });
  // A stand-in for the phone's share menu: records what it was given. The first call can be made to fail like iOS does after a wait.
  await ctx.addInitScript(() => {
    window.__shared = []; window.__refuseNext = false;
    navigator.share = async data => {
      if (window.__refuseNext) { window.__refuseNext = false; throw new DOMException('Must be handling a user gesture', 'NotAllowedError'); }
      window.__shared.push(await Promise.all((data.files || []).map(async f => ({ name: f.name, type: f.type, size: f.size, head: [...new Uint8Array(await f.slice(0, 8).arrayBuffer())] }))));
    };
    navigator.canShare = data => Array.isArray(data?.files);
  });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.click('.auth-create'); await p.fill('#codeEmail', EMAIL); await p.click('#emailForm .auth-submit');
  await p.waitForSelector('#codeForm:not([hidden])'); await p.fill('#codeInput', lastCode(EMAIL)); await p.click('#codeForm .auth-submit');
  await p.waitForSelector('#passwordForm:not([hidden])'); await p.fill('#newPassword', 'pass-12345'); await p.click('#passwordForm .auth-submit');
  await p.waitForSelector('#recoveryKeyForm:not([hidden])', { timeout: 15000 }); await p.check('#recoverySaved'); await p.click('#recoveryKeyForm .auth-submit');
  await p.waitForSelector('.app-shell', { state: 'visible' }); await sleep(800);
  await p.click('#scratchpad'); await p.keyboard.type('Notes for the trip.\nPassport and license scans below.');
  const sunset = fs.readFileSync(IMG + 'sunset-beach.jpg'), old = fs.readFileSync(IMG + 'lisbon-castelo.jpg');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900_000, 7)]);
  await p.setInputFiles('#fileInput', [{ name: 'IMG_6258.jpeg', mimeType: 'image/jpeg', buffer: sunset }, { name: 'IMG_6259.jpeg', mimeType: 'image/jpeg', buffer: old }, { name: 'EEO TL.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  await p.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 3, null, { timeout: 30000 }); await sleep(1500);

  await p.click('#selectBtn'); await p.click('#selectAllBox'); await sleep(400);
  const bar = await p.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const btns = ['#bulkShareBtn', '#bulkSaveBtn', '#bulkDeleteBtn'].map(s => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); const i = e.querySelector('.i').getBoundingClientRect(); const t = e.querySelector('span').getBoundingClientRect(); return { label: e.querySelector('span').textContent, visible: b.width > 0 && !e.hidden, iconAbove: i.bottom <= t.top + 1, color: getComputedStyle(e).color, w: Math.round(b.width) }; });
    return { count: document.querySelector('#bulkCount').textContent, btns, barH: Math.round(r('#bulkBar').height), lastRowBottom: Math.round([...document.querySelectorAll('#fileList .file-row')].pop().getBoundingClientRect().bottom) };
  });
  ok('bar: count, then Share · Download · Delete', bar.count === '3 selected' && bar.btns.map(x => x.label).join() === 'Share,Download,Delete' && bar.btns.every(x => x.visible), JSON.stringify(bar.btns.map(x => x.label)));
  ok('each is an icon over its label, same width', bar.btns.every(x => x.iconAbove) && new Set(bar.btns.map(x => x.w)).size === 1, JSON.stringify(bar.btns.map(x => [x.w, x.iconAbove])));
  ok('Share and Download blue, Delete red', bar.btns[0].color === bar.btns[1].color && bar.btns[2].color !== bar.btns[0].color, JSON.stringify(bar.btns.map(x => x.color)));
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(400);
  await p.screenshot({ path: OUT + 'ms-bar.png' });
  const covered = await p.evaluate(() => { const last = [...document.querySelectorAll('#fileList .file-row')].pop().getBoundingClientRect(); const barTop = document.querySelector('#bulkBar').getBoundingClientRect().top; return Math.round(barTop - last.bottom); });
  ok('last file fully above the bar when scrolled down', covered >= 0, `${covered}px gap`);

  // Share: the real (unlocked) files reach the share menu
  await p.click('#bulkShareBtn');
  await p.waitForFunction(() => window.__shared.length === 1, null, { timeout: 20000 });
  const sent = await p.evaluate(() => window.__shared[0]);
  ok('share menu gets all 3 files, unlocked, named and typed', sent.length === 3 && sent.map(f => f.name).sort().join() === 'EEO TL.pdf,IMG_6258.jpeg,IMG_6259.jpeg' && sent.find(f => f.name === 'EEO TL.pdf').type === 'application/pdf' && sent.find(f => f.name === 'EEO TL.pdf').head.slice(0, 4).join() === '37,80,68,70' && sent.find(f => f.name === 'IMG_6258.jpeg').size === sunset.length, JSON.stringify(sent.map(f => [f.name, f.type, f.size])));
  ok('selection ends after sharing', !(await p.isVisible('#selectBar')));
  await sleep(300);
  await p.screenshot({ path: OUT + 'ms-shared.png' });

  // When the phone refuses (too long after the tap): a Share button to tap
  await p.click('#selectBtn'); await p.click('#fileList .file-row:has-text("EEO TL.pdf")'); await sleep(200);
  ok('one selected', (await p.textContent('#bulkCount')) === '1 selected');
  await p.evaluate(() => { window.__refuseNext = true; });
  await p.click('#bulkShareBtn');
  await p.waitForSelector('.transfer-ready', { timeout: 15000 });
  await p.screenshot({ path: OUT + 'ms-ready.png' });
  await p.click('.transfer-ready');
  await p.waitForFunction(() => window.__shared.length === 2, null, { timeout: 5000 }).then(() => ok('Share button opens the menu', true), () => ok('Share button opens the menu', false));
  ok('…with just that file', (await p.evaluate(() => window.__shared[1].map(f => f.name).join())) === 'EEO TL.pdf');

  // Without a share menu (most computers): no Share button
  const dctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await dctx.addInitScript(() => { delete Navigator.prototype.share; });
  const d = await dctx.newPage(); d.on('pageerror', e => errs.push('desk: ' + e.message));
  await d.goto(BASE); await d.fill('#signinEmail', EMAIL); await d.fill('#signinPassword', 'pass-12345'); await d.click('#signinForm .auth-submit');
  await d.waitForSelector('#fileList .file-row'); await d.click('#selectBtn'); await d.click('#selectAllBox'); await sleep(300);
  ok('no share menu: Share hidden', !(await d.isVisible('#bulkShareBtn')) && await d.isVisible('#bulkSaveBtn'));
  // With one (Mac/Windows Chrome): shown inline
  const d2ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await d2ctx.addInitScript(() => { navigator.share = async () => {}; navigator.canShare = () => true; });
  const d2 = await d2ctx.newPage();
  await d2.goto(BASE); await d2.fill('#signinEmail', EMAIL); await d2.fill('#signinPassword', 'pass-12345'); await d2.click('#signinForm .auth-submit');
  await d2.waitForSelector('#fileList .file-row'); await d2.click('#selectBtn'); await d2.click('#selectAllBox'); await sleep(300);
  ok('computer with a share menu: Share shown', await d2.isVisible('#bulkShareBtn'));
  await d2.$eval('#selectBar', el => el.scrollIntoView({ block: 'center' })); await sleep(200);
  await d2.screenshot({ path: OUT + 'ms-desktop.png', clip: await d2.$eval('#selectBar', el => { const r = el.getBoundingClientRect(); return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 }; }) });

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
