// Nightly backup, the Netlify Blobs part (run by tools/backup/nightly.sh).
// Asks the site (netlify/functions/backup.mjs) for every store and the etag of
// every key, compares with last night's manifest, and downloads only what's
// new or changed. Writes, in OUT:
//   blobs/<store>/<key>  the new and changed blobs (names: names.mjs)
//   deleted.txt          blobs in last night's copy that are gone now
//   manifest.json        { store: { key: etag } } for tonight
//   summary.json         counts (no names: the workflow log is public)
// Env: SITE (the site's address), TOKEN (GitHub's signed token), PREV (last
// night's manifest, may be missing), OUT, ALLOW_BIG_DELETE=1 to go ahead when
// much of the copy would be marked deleted (normally that stops the run: a
// site that lost its data must not empty the backup).
import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeName } from './names.mjs';

const { SITE, TOKEN, PREV, OUT, ALLOW_BIG_DELETE } = process.env;
if (!SITE || !TOKEN || !OUT) throw new Error('SITE, TOKEN and OUT are needed');
const api = `${SITE.replace(/\/$/, '')}/.netlify/functions/backup`;
const headers = { Authorization: `Bearer ${TOKEN}` };
const PARALLEL = 8;

async function call(query, type = 'json') {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${api}?${new URLSearchParams(query)}`, { headers, signal: AbortSignal.timeout(60_000) });
      if (r.status === 404 && query.op === 'get') return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return type === 'json' ? await r.json() : { data: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag') };
    } catch (err) {
      if (attempt >= 4 || /HTTP 4\d\d/.test(err.message)) throw new Error(`Backup ${query.op} failed: ${err.message}`);
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
}

const prev = PREV ? JSON.parse(await fs.readFile(PREV, 'utf8').catch(() => '{}')) : {};

// Tonight's list.
const index = {};
let after = '';
do {
  const page = await call({ op: 'index', after });
  for (const s of page.stores) index[s.name] = Object.fromEntries(s.blobs);
  after = page.next;
} while (after);

// What changed.
const wanted = [];
const deleted = [];
let total = 0;
let prevTotal = 0;
for (const [store, keys] of Object.entries(index)) {
  for (const [key, etag] of Object.entries(keys)) {
    total++;
    if (prev[store]?.[key] !== etag) wanted.push([store, key]);
  }
}
for (const [store, keys] of Object.entries(prev)) {
  for (const key of Object.keys(keys)) {
    prevTotal++;
    if (!(index[store] && key in index[store])) deleted.push([store, key]);
  }
}

const bigDelete = deleted.length > Math.max(50, prevTotal * 0.1);
if (bigDelete && ALLOW_BIG_DELETE !== '1') {
  console.error(`::error::${deleted.length} of the ${prevTotal} blobs in the backup are gone from the site. ` +
    'Stopped so the backup keeps them. If that is expected (many accounts deleted), run the workflow by hand with "allow big delete" ticked.');
  process.exit(3);
}

// Download, a few at a time.
const manifest = structuredClone(index);
let fetched = 0;
let bytes = 0;
let vanished = 0;
const queue = [...wanted];
async function worker() {
  while (queue.length) {
    const [store, key] = queue.shift();
    const got = await call({ op: 'get', store, key }, 'raw');
    if (!got) { // deleted since the list was made
      delete manifest[store][key];
      if (prev[store]?.[key]) deleted.push([store, key]);
      vanished++;
      continue;
    }
    const file = path.join(OUT, 'blobs', encodeName(store), encodeName(key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    // The manifest keeps the list's etag (a blob changed after the list was
    // made is simply fetched again tomorrow).
    await fs.writeFile(file, got.data);
    fetched++;
    bytes += got.data.length;
  }
}
await fs.mkdir(path.join(OUT, 'blobs'), { recursive: true });
await Promise.all(Array.from({ length: PARALLEL }, worker));

await fs.writeFile(path.join(OUT, 'deleted.txt'), deleted.map(([s, k]) => `${encodeName(s)}/${encodeName(k)}`).join('\n') + (deleted.length ? '\n' : ''));
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
const summary = { stores: Object.keys(index).length, blobs: total - vanished, fetched, bytes, deleted: deleted.length };
await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(summary));
console.log(`Blobs: ${summary.stores} stores, ${summary.blobs} blobs; ${fetched} new or changed (${(bytes / 1e6).toFixed(1)} MB), ${deleted.length} gone since last night.`);
