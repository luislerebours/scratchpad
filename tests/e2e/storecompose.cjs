// Store images from the raw screenshots: a headline on brand colours over the
// app in a device frame (phone 1080×1920, 7" 1200×1920, 10" 1600×2560), the
// 1024×500 feature graphic and the 512 px icon. Opaque PNGs, as Play requires.
const REPO = require('path').resolve(__dirname, '../..') + '/';
const OUTDIR = require('path').join(__dirname, 'out') + '/';
const { chromium } = require('playwright'); const fs = require('fs'); const { execFileSync } = require('child_process');
const STORE = OUTDIR + 'store/';
const OUT = STORE + 'out/';
fs.mkdirSync(OUT, { recursive: true });

const C = { teal: '#247F82', cream: '#F5F2EB', mint: '#DDF5EE', ink: '#1C1C1C', soft: '#5E554D' };
const SHOTS = [
  ['editor', 'Drop it here.\nPull it up anywhere.', 'Notes, photos and files on every device.'],
  ['sharein', 'Share to ScrapSheet\nfrom any app', 'Photos, links and files, in one tap.'],
  ['files', 'Your files, right\nnext to your notes', 'PDFs, photos, anything up to 100 MB.'],
  ['dark', 'Instantly on all\nyour devices', 'Type on your phone, see it on your laptop.', 'teal'],
  ['share', 'Send a link,\nnot an attachment', 'Share a file or a whole sheet. Links expire when you say.'],
  ['search', 'Find it in a second', 'Search every sheet and file name.'],
  ['secure', 'Private by design', 'End-to-end encrypted with AES-256. Not even we can read it.', 'teal']
];
const SIZES = {
  phone: { w: 1080, h: 1920, title: 78, sub: 38, frame: 0.74, pad: 120 },
  tablet7: { w: 1200, h: 1920, title: 80, sub: 40, frame: 0.70, pad: 130 },
  tablet10: { w: 1600, h: 2560, title: 104, sub: 50, frame: 0.70, pad: 170 }
};
const font = `@font-face { font-family: Brand; src: url('file://${REPO}public/fonts/montserrat-latin.woff2') format('woff2'); font-weight: 100 900; }`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function page(size, [name, title, sub, bg]) {
  const s = SIZES[size];
  const dark = bg === 'teal';
  return `<!doctype html><meta charset="utf-8"><style>${font}
    html,body{margin:0;width:${s.w}px;height:${s.h}px;overflow:hidden;background:${dark ? C.teal : C.cream}}
    .wrap{box-sizing:border-box;height:100%;padding:${s.pad}px ${Math.round(s.pad * 0.6)}px 0;display:flex;flex-direction:column;align-items:center;text-align:center;font-family:Brand,Arial,sans-serif}
    h1{margin:0;font-weight:800;font-size:${s.title}px;line-height:1.12;letter-spacing:-.02em;color:${dark ? '#fff' : C.ink};white-space:pre-line}
    p{margin:${Math.round(s.sub * 0.7)}px 0 0;font-weight:500;font-size:${s.sub}px;line-height:1.35;color:${dark ? C.mint : C.soft};max-width:${Math.round(s.w * 0.8)}px}
    .frame{margin:${Math.round(s.pad * 0.6)}px 0 ${Math.round(s.pad * 0.55)}px;flex:1;min-height:0;display:flex;justify-content:center}
    .frame img{display:block;height:100%;width:auto;box-sizing:border-box;border:${Math.round(s.w * 0.014)}px solid ${C.ink};border-radius:${Math.round(s.w * 0.05)}px;background:#fff;box-shadow:0 30px 80px rgba(0,0,0,${dark ? '.35' : '.18'})}
  </style><div class="wrap"><h1>${esc(title)}</h1><p>${esc(sub)}</p><div class="frame"><img src="raw/${size}-${name}.png"></div></div>`;
}

const feature = () => `<!doctype html><meta charset="utf-8"><style>${font}
  html,body{margin:0;width:1024px;height:500px;overflow:hidden;background:${C.teal};font-family:Brand,Arial,sans-serif}
  .text{position:absolute;left:64px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center}
  .text img{height:56px;align-self:flex-start;margin-bottom:34px}
  h1{margin:0;color:#fff;font-weight:800;font-size:48px;line-height:1.1;letter-spacing:-.02em}
  p{margin:18px 0 0;color:${C.mint};font-weight:500;font-size:22px;line-height:1.4}
  .frame{position:absolute;right:56px;top:46px;width:270px;height:520px;border:7px solid ${C.ink};border-bottom:0;border-radius:30px 30px 0 0;overflow:hidden;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .frame img{display:block;width:100%}
</style>
<div class="text"><img src="file://${REPO}branding/kit/01_Logos/horizontal-white.svg"><h1>Drop it here.<br>Pull it up anywhere.</h1><p>Notes, photos and files on every device.<br>End-to-end encrypted.</p></div>
<div class="frame"><img src="raw/phone-editor.png"></div>`;

(async () => {
  const b = await chromium.launch();
  const render = async (html, w, h, file) => {
    fs.writeFileSync(STORE + '_tmp.html', html);
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.goto('file://' + STORE + '_tmp.html'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
    await p.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    await p.close();
  };
  for (const size of Object.keys(SIZES)) {
    for (const [i, shot] of SHOTS.entries()) await render(page(size, shot), SIZES[size].w, SIZES[size].h, `${OUT}${size}-${i + 1}-${shot[0]}.png`);
  }
  await render(feature(), 1024, 500, OUT + 'feature-graphic-1024x500.png');
  await b.close();
  // Play wants opaque images: flatten to RGB. The icon: the approved app icon at 512.
  execFileSync('python3', ['-c', `
import glob
from PIL import Image
for f in glob.glob('${OUT}*.png'):
    Image.open(f).convert('RGB').save(f, optimize=True)
Image.open('${REPO}branding/app-icon-full-bleed-1024.png').convert('RGB').resize((512, 512), Image.LANCZOS).save('${OUT}icon-512.png', optimize=True)
`]);
  console.log('done', fs.readdirSync(OUT).length);
})().catch(e => { console.error(e); process.exit(1); });
