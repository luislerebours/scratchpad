// The app's .zip writer, run in Node over two 2.2 GB sparse files (4.4 GB: needs Zip64).
// The archive is written sparsely too (zero blocks skipped), so it costs almost no disk.
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
import fs from 'node:fs';
const src = fs.readFileSync(REPO + '/public/app.js', 'utf8');
const pick = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
const code = [
  pick('function safeFileName(name)', '\n}\n') + '\n}\n',
  pick('const CRC_TABLE', '// ---- Download my data ----')
].join('\n');
const makeZip = new Function(code + '\nreturn makeZip;')();

const dir = process.argv[2];
const GB = 1024 ** 3;
const paths = ['a.bin', 'b.bin'].map(n => `${dir}/${n}`);
for (const p of paths) { const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, Math.round(2.2 * GB)); fs.closeSync(fd); }
const blobs = await Promise.all(paths.map(p => fs.openAsBlob(p)));
const files = [
  Object.assign(new File(['hello'], 'hi.txt'), { zipPath: 'Sheet/hi.txt' }),
  Object.assign(blobs[0], { name: 'a.bin', zipPath: 'Sheet/files/a.bin' }),
  Object.assign(blobs[1], { name: 'b.bin', zipPath: 'Sheet/files/b.bin' }),
  Object.assign(new File(['after 4 GB'], 'z.txt'), { zipPath: 'Other/z.txt' })
];
const t = Date.now();
const zip = await makeZip(files, 'big.zip');
console.log('zip size', zip.size, 'built in', Date.now() - t, 'ms');
const out = fs.openSync(`${dir}/big.zip`, 'w');
let pos = 0;
for await (const chunk of zip.stream()) {
  if (chunk.some(b => b !== 0)) fs.writeSync(out, chunk, 0, chunk.length, pos);
  pos += chunk.length;
}
fs.ftruncateSync(out, pos); fs.closeSync(out);
for (const p of paths) fs.unlinkSync(p);
console.log('written', pos);
