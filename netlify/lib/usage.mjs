import { MAX_SHEETS, userStore } from './auth.mjs';
import { limitsFor } from './plans.mjs';
import { versionsSummary } from './versions.mjs';

// Storage per account: what it holds, and its limit (the plan's, unless the admin set one).

// null means no limit. quotaBytes on the account: -1 = no limit, a number =
// that limit, unset = the plan's.
export function quotaFor(user) {
  if (user.quotaBytes === -1) return null;
  if (Number.isFinite(user.quotaBytes) && user.quotaBytes > 0) return user.quotaBytes;
  return limitsFor(user).quotaBytes;
}

async function recordsSize(store, sizeOf) {
  const { blobs } = await store.list();
  const records = await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)));
  let bytes = 0;
  let count = 0;
  for (const record of records) {
    // Uploads in progress count too, so parallel uploads can't slip past the limit.
    if (!record) continue;
    bytes += sizeOf(record);
    // Files in Recently Deleted still take space, but aren't counted as files.
    if (record.complete && !record.deletedAt) count++;
  }
  return { bytes, count };
}

// Text, files and images across all of an account's sheets.
export async function accountUsage(ns) {
  const state = userStore(ns, 'state');
  const perSheet = await Promise.all(Array.from({ length: MAX_SHEETS }, async (_, i) => {
    const sheet = i + 1;
    const [doc, files, images] = await Promise.all([
      state.get(`sheets/${sheet}`, { type: 'json' }),
      recordsSize(userStore(ns, 'files', sheet), r => (r.size || 0) + (r.thumb?.size || 0)),
      recordsSize(userStore(ns, 'images', sheet), r => (r.size || 0) + (r.preview?.size || 0))
    ]);
    const text = doc ? Buffer.byteLength(doc.text || '') + Buffer.byteLength(doc.html || '') : 0;
    return { text, files, images };
  }));
  // Earlier versions of the text (Version history) take space too.
  const versions = await versionsSummary(ns, Array.from({ length: MAX_SHEETS }, (_, i) => i + 1));
  return perSheet.reduce((sum, s) => ({
    bytes: sum.bytes + s.text + s.files.bytes + s.images.bytes,
    files: sum.files + s.files.count,
    images: sum.images + s.images.count
  }), { bytes: versions.bytes, files: 0, images: 0 });
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`;
}

// Null when the upload fits; otherwise a friendly reason to show.
export async function overQuota(user, ns, incomingBytes) {
  const quota = quotaFor(user);
  if (quota === null) return null;
  const { bytes } = await accountUsage(ns);
  if (bytes + incomingBytes <= quota) return null;
  return `Not enough space: this needs ${size(incomingBytes)} and only ${size(Math.max(0, quota - bytes))} of your ${size(quota)} is free. Delete some files to make room.`;
}
