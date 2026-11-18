const { chromium } = require('playwright');
const BASE = 'http://localhost:8970', F = BASE + '/.netlify/functions';
const post = (u, body) => fetch(F + u, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
(async () => {
  // Old-format sheet (text only), like the live data today
  await post('/state?sheet=1', { text: 'first line\nsecond line' });
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:2, permissions:['clipboard-read','clipboard-write'] });
  const A = await ctx.newPage(), B = await (await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:2 })).newPage();
  for (const p of [A, B]) { p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept()); }
  await A.goto(BASE); await B.goto(BASE); await A.waitForTimeout(1200);
  console.log('1. old text shows as lines:', JSON.stringify(await A.$eval('#scratchpad', el => el.innerText)));

  // Paste a real PNG (generated in the page) at the end of the text
  const paste = (page, kind, payload) => page.evaluate(async ({ kind, payload }) => {
    const pad = document.querySelector('#scratchpad'); pad.focus();
    const r = document.createRange(); r.selectNodeContents(pad); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
    const dt = new DataTransfer();
    if (kind === 'png') {
      const c = document.createElement('canvas'); c.width = payload.w; c.height = payload.h; const x = c.getContext('2d');
      if (payload.noise) { const d = x.createImageData(c.width, c.height); crypto.getRandomValues(d.data.subarray(0, 65536)); for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, Math.min(i + 65536, d.data.length))); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255; x.putImageData(d, 0, 0); }
      else { x.fillStyle = '#2cc7ff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000'; x.font = '40px sans-serif'; x.fillText('pasted!', 20, 80); }
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      window.__pngSize = blob.size;
      dt.items.add(new File([blob], 'image.png', { type:'image/png' }));
    } else if (kind === 'pdf') dt.items.add(new File(['%PDF-1.4 fake'], 'doc.pdf', { type:'application/pdf' }));
    else for (const [t, v] of Object.entries(payload)) dt.setData(t, v);
    pad.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles:true, cancelable:true }));
  }, { kind, payload });

  await paste(A, 'png', { w: 400, h: 140 });
  console.log('2. placeholder while uploading:', await A.$$eval('#scratchpad img.pending', x => x.length) >= 0);
  await A.waitForFunction(() => { const i = document.querySelector('#scratchpad img'); return i && !i.dataset.pending && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
  await A.keyboard.type(' after the image');
  await A.waitForTimeout(3500);
  const bState = await B.$eval('#scratchpad', el => ({ text: el.innerText, imgs: [...el.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth })) }));
  console.log('3. other device:', JSON.stringify(bState));

  // Big noisy image -> must be shrunk to JPEG under 3.9 MB
  await paste(A, 'png', { w: 3200, h: 2400, noise: true });
  await A.waitForFunction(() => [...document.querySelectorAll('#scratchpad img')].length === 2 && ![...document.querySelectorAll('#scratchpad img')].some(i => i.dataset.pending), null, { timeout: 60000 });
  const src2 = await A.$eval('#scratchpad img:nth-of-type(2)', i => i.getAttribute('src')).catch(async () => (await A.$$eval('#scratchpad img', x => x.map(i => i.getAttribute('src'))))[1]);
  const r2 = await fetch(BASE + src2); const buf2 = Buffer.from(await r2.arrayBuffer());
  console.log('4. big paste: original PNG', (await A.evaluate(() => window.__pngSize) / 1e6).toFixed(1), 'MB -> stored', r2.headers.get('content-type'), (buf2.length / 1e6).toFixed(2), 'MB | cache:', r2.headers.get('cache-control'));

  // Plain text paste drops outside formatting
  await paste(A, 'data', { 'text/plain': '\nplain pasted', 'text/html': '<b style="color:red">plain pasted</b>' });
  console.log('5. formatted paste stored as:', JSON.stringify((await A.$eval('#scratchpad', el => el.innerHTML)).slice(-40)));

  // PDF pasted into text goes to Files
  await paste(A, 'pdf', {});
  await A.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 1, null, { timeout: 15000 });
  console.log('6. pasted PDF went to Files:', await A.textContent('#fileList .file-name'));

  // Viewer + Remove
  await A.waitForTimeout(1500);
  await A.click('#scratchpad img >> nth=1'); await A.click('#imageTools [data-tool="view"]');
  console.log('7. viewer open:', await A.isVisible('#previewModal'), '| Remove shown:', await A.isVisible('#previewRemoveBtn'));
  await A.screenshot({ path: '../shot-viewer.png' });
  await A.click('#previewRemoveBtn'); await A.waitForTimeout(3500);
  console.log('   images left A/B:', await A.$$eval('#scratchpad img', x => x.length), await B.$$eval('#scratchpad img', x => x.length));
  await B.$eval('#scratchpad', el => el.scrollIntoView()); await B.screenshot({ path: '../shot-inline.png' });

  // Copy puts html + text on the clipboard
  await A.click('#copyBtn'); await A.waitForTimeout(300);
  const clip = await A.evaluate(async () => { const items = await navigator.clipboard.read(); const out = {}; for (const t of items[0].types) out[t] = await (await items[0].getType(t)).text(); return out; });
  console.log('8. copy types:', Object.keys(clip), '| html has absolute image url:', /src="http:\/\/localhost:8970\/\.netlify\/functions\/images/.test(clip['text/html'] || ''));

  // Malicious html written straight to the server must render harmlessly
  await post('/state?sheet=1', { text: 'x', html: 'safe text<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3">link</a><iframe src="https://example.com"></iframe><div style="position:fixed;inset:0" onclick="window.__xss=4">block</div><img src="/.netlify/functions/images?sheet=1&id=abc" onload="window.__xss=5">' });
  await B.waitForTimeout(3500);
  const evil = await B.$eval('#scratchpad', el => ({ html: el.innerHTML, xss: window.__xss || null }));
  console.log('9. sanitized:', JSON.stringify(evil));
  await B.click('#scratchpad'); await B.waitForTimeout(200);
  console.log('   xss after click:', await B.evaluate(() => window.__xss || null));

  // Clear
  await A.waitForTimeout(500);
  await A.click('#clearBtn'); await A.waitForTimeout(3500);
  console.log('10. cleared, placeholder on B:', await B.$eval('#scratchpad', el => el.classList.contains('is-empty')));
  console.log('page errors:', errs); await b.close();
})();
