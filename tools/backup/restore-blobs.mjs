// Puts a backup's Netlify Blobs back into a site (docs/RECOVERY.md).
//   node tools/backup/restore-blobs.mjs <folder> [--overwrite] [--dry-run]
// <folder> is the backup's "blobs" folder, copied out of Drive with rclone
// (rclone copy vault:blobs <folder>). Every store and key goes back under its
// original name. Keys already in the site are left alone unless --overwrite.
// Env: NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (Netlify › User settings ›
// Applications › Personal access tokens), or NETLIFY_BLOBS_CONTEXT (tests).
import fs from 'node:fs/promises';
import path from 'node:path';
import { getStore } from '@netlify/blobs';
import { decodeName } from './names.mjs';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
const overwrite = args.includes('--overwrite');
const dryRun = args.includes('--dry-run');
if (!dir) {
  console.error('Usage: node tools/backup/restore-blobs.mjs <blobs folder> [--overwrite] [--dry-run]');
  process.exit(2);
}
const { NETLIFY_SITE_ID: siteID, NETLIFY_AUTH_TOKEN: token } = process.env;
if (!process.env.NETLIFY_BLOBS_CONTEXT && !(siteID && token)) {
  console.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN first (docs/RECOVERY.md).');
  process.exit(2);
}
const open = name => getStore({ name, consistency: 'strong', ...(siteID && token ? { siteID, token } : {}) });

const jobs = [];
for (const storeDir of await fs.readdir(dir)) {
  const name = decodeName(storeDir);
  for (const file of await fs.readdir(path.join(dir, storeDir))) {
    jobs.push([name, decodeName(file), path.join(dir, storeDir, file)]);
  }
}
console.log(`${jobs.length} blobs in ${new Set(jobs.map(j => j[0])).size} stores${dryRun ? ' (dry run: nothing written)' : ''}.`);

let written = 0;
let skipped = 0;
const queue = [...jobs];
async function worker() {
  while (queue.length) {
    const [name, key, file] = queue.shift();
    const store = open(name);
    if (!overwrite && (await store.getMetadata(key))) { skipped++; continue; }
    if (!dryRun) {
      const data = await fs.readFile(file);
      await store.set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    written++;
    if (written % 500 === 0) console.log(`  ${written} written…`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`Done: ${written} ${dryRun ? 'would be written' : 'written'}, ${skipped} already there (left alone).`);
