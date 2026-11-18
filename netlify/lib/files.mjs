import { userStore } from './auth.mjs';
import { deletePieces, filePrefix, onR2, purge, r2Enabled, sheetPrefix } from './r2.mjs';

// Files and Recently Deleted, shared by files.mjs and state.mjs.
// Deleting a file or a sheet moves it to Recently Deleted; it is deleted for
// good after TRASH_DAYS, or sooner if the owner chooses.

export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;
export const FILE_KINDS = ['files', 'chunks', 'file-thumbs', 'images', 'image-chunks', 'image-previews'];

const chunkKey = (id, index) => `${id}-${index}`;
export const expired = deletedAt => Date.now() - Number(deletedAt || 0) > TRASH_MS;

// Records are kept in their own store so listing never touches chunk data.
export const fileStores = (ns, sheet) => ({
  ns,
  sheet,
  records: userStore(ns, 'files', sheet),
  chunks: userStore(ns, 'chunks', sheet),
  thumbs: userStore(ns, 'file-thumbs', sheet)
});

export const publicRecord = (record, sheet) => ({
  id: record.id,
  sheet,
  name: record.name,
  type: record.type,
  size: record.size,
  chunks: record.chunks,
  uploadedAt: record.uploadedAt,
  kept: Boolean(record.kept),
  thumb: Boolean(record.thumb),
  // End-to-end encrypted: name, contents and thumbnail are locked with the
  // file's key, which is itself locked with its sheet's key.
  enc: Boolean(record.enc),
  key: record.key || null
});

// Each 4 MB piece of a locked file is 28 bytes bigger (its IV and tag).
export const SEALED_OVERHEAD = 28;

export async function deleteFileForGood({ ns, sheet, records, chunks, thumbs }, record) {
  // Pieces in R2 go first; if that fails the record stays, so it's tried again.
  if (onR2(record)) await deletePieces(filePrefix(ns, sheet, record.id), record.chunks);
  await Promise.all([
    ...Array.from({ length: record.chunks }, (_, i) => chunks.delete(chunkKey(record.id, i))),
    record.thumb ? thumbs.delete(record.id) : null
  ]);
  await records.delete(record.id);
}

// A sheet's file records, after deleting for good any that have been in
// Recently Deleted for more than TRASH_DAYS.
export async function readRecords(ns, sheet) {
  const store = fileStores(ns, sheet);
  const { blobs } = await store.records.list();
  const all = await Promise.all(blobs.map(({ key }) => store.records.get(key, { type: 'json' }).catch(() => null)));
  const records = [];
  for (const record of all) {
    if (!record) continue;
    if (record.deletedAt && expired(record.deletedAt)) {
      // Cleanup never breaks a list: if it can't finish now, it's tried next time.
      await deleteFileForGood(store, record).catch(err => { console.error('Clearing an expired file', err.message); records.push(record); });
    } else records.push(record);
  }
  return { store, records };
}

// The files a sheet shows: finished uploads that aren't in Recently Deleted, newest first.
export const visibleFiles = (records, sheet) => records
  .filter(r => r.complete && !r.deletedAt)
  .map(r => publicRecord(r, sheet))
  .sort((a, b) => b.uploadedAt - a.uploadedAt);

async function emptyStore(store) {
  const { blobs } = await store.list();
  await Promise.all(blobs.map(({ key }) => store.delete(key)));
}

// Everything in a sheet's slot: its text, files and images.
export async function wipeSheet(ns, sheet) {
  // The slot's pieces in R2 (if any file there ever went to R2).
  const { blobs } = await userStore(ns, 'files', sheet).list();
  const records = await Promise.all(blobs.map(({ key }) => userStore(ns, 'files', sheet).get(key, { type: 'json' }).catch(() => null)));
  if (r2Enabled() || records.some(onR2)) await purge(sheetPrefix(ns, sheet));
  await userStore(ns, 'state').delete(`sheets/${sheet}`);
  await Promise.all(FILE_KINDS.map(kind => emptyStore(userStore(ns, kind, sheet))));
}

// Deleted sheets: { sheets: [{ id, name, deletedAt, position }] }. Their slots
// stay reserved, so new sheets can't land on top of them.
export async function readSheetTrash(ns) {
  const state = userStore(ns, 'state');
  const data = await state.get('meta/trash', { type: 'json' });
  const all = Array.isArray(data?.sheets) ? data.sheets : [];
  const gone = all.filter(s => expired(s.deletedAt));
  if (!gone.length) return all;
  await Promise.all(gone.map(s => wipeSheet(ns, s.id)));
  const left = all.filter(s => !gone.includes(s));
  await writeSheetTrash(ns, left);
  return left;
}

export async function writeSheetTrash(ns, sheets) {
  await userStore(ns, 'state').setJSON('meta/trash', { sheets, updatedAt: Date.now() });
}
