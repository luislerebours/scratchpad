import { randomUUID } from 'node:crypto';
import { bumpRev, json, parseSheet, requireUser, userStore } from '../lib/auth.mjs';
import { overQuota } from '../lib/usage.mjs';

// Netlify functions accept roughly 4.5 MB of binary per request, so files
// travel in chunks: each upload/download request carries one chunk.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1000 * 1000;
// A small square the page makes from an image, shown in the file list.
const MAX_THUMB_BYTES = 64 * 1024;
const THUMB_TYPES = new Set(['image/jpeg', 'image/webp', 'image/png']);
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const chunkKey = (id, index) => `${id}-${index}`;

// Records are kept in their own store so listing never touches chunk data.
const stores = (ns, sheet) => ({
  records: userStore(ns, 'files', sheet),
  chunks: userStore(ns, 'chunks', sheet),
  thumbs: userStore(ns, 'file-thumbs', sheet)
});

const publicRecord = (record, sheet) => ({
  id: record.id,
  sheet,
  name: record.name,
  type: record.type,
  size: record.size,
  chunks: record.chunks,
  uploadedAt: record.uploadedAt,
  kept: Boolean(record.kept),
  thumb: Boolean(record.thumb)
});

async function deleteFile({ records, chunks, thumbs }, record) {
  await Promise.all([
    ...Array.from({ length: record.chunks }, (_, i) => chunks.delete(chunkKey(record.id, i))),
    record.thumb ? thumbs.delete(record.id) : null
  ]);
  await records.delete(record.id);
}

export default async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);

  const store = stores(auth.ns, sheet);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  const chunkParam = url.searchParams.get('chunk');

  // List completed files, cleaning up uploads that were abandoned midway.
  if (req.method === 'GET' && !id) {
    const { blobs } = await store.records.list();
    const all = await Promise.all(blobs.map(({ key }) => store.records.get(key, { type: 'json' })));
    const files = [];
    for (const record of all) {
      if (!record) continue;
      if (record.complete) files.push(publicRecord(record, sheet));
      else if (Date.now() - record.startedAt > STALE_UPLOAD_MS) await deleteFile(store, record);
    }
    files.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return json({ files, maxBytes: MAX_FILE_BYTES });
  }

  // Start an upload: reserve an id and tell the client how to chunk it.
  if (req.method === 'POST' && action === 'start') {
    const body = await req.json().catch(() => null);
    const size = Number(body?.size);
    if (!Number.isInteger(size) || size < 0) return json({ error: 'Invalid size' }, 400);
    if (size > MAX_FILE_BYTES) return json({ error: 'File is over 100 MB' }, 413);
    const full = await overQuota(auth.user, auth.ns, size);
    if (full) return json({ error: full, quota: true }, 413);

    const record = {
      id: randomUUID(),
      name: String(body?.name || 'file').slice(0, 200),
      type: String(body?.type || 'application/octet-stream').slice(0, 200),
      size,
      chunkSize: CHUNK_BYTES,
      chunks: Math.max(1, Math.ceil(size / CHUNK_BYTES)),
      complete: false,
      startedAt: Date.now()
    };
    await store.records.setJSON(record.id, record);
    return json({ id: record.id, chunkSize: record.chunkSize, chunks: record.chunks });
  }

  if (!validId(id)) return json({ error: 'Invalid id' }, 400);
  const record = await store.records.get(id, { type: 'json' });
  if (!record) return json({ error: 'Not found' }, 404);

  const chunkIndex = chunkParam === null ? null : Number(chunkParam);
  if (chunkIndex !== null && !(Number.isInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex < record.chunks)) {
    return json({ error: 'Invalid chunk' }, 400);
  }

  // Upload one chunk as the raw request body.
  if (req.method === 'PUT' && chunkIndex !== null) {
    if (record.complete) return json({ error: 'Upload already finished' }, 409);
    const data = await req.arrayBuffer();
    const expected = Math.min(record.chunkSize, record.size - chunkIndex * record.chunkSize);
    if (data.byteLength !== expected) return json({ error: 'Wrong chunk size' }, 400);
    await store.chunks.set(chunkKey(id, chunkIndex), data);
    return json({ ok: true });
  }

  // A thumbnail for an image: sent while uploading, or later for older files.
  // An id always names the same file, so a device may keep it for good.
  if (url.searchParams.get('thumb') === '1') {
    if (req.method === 'PUT') {
      const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!THUMB_TYPES.has(type)) return json({ error: 'Unsupported thumbnail type' }, 415);
      const data = await req.arrayBuffer();
      if (!data.byteLength || data.byteLength > MAX_THUMB_BYTES) return json({ error: 'Thumbnail too large' }, 413);
      await store.thumbs.set(id, data);
      // Re-read: the upload may have finished meanwhile.
      const latest = (await store.records.get(id, { type: 'json' })) || record;
      await store.records.setJSON(id, { ...latest, thumb: { type, size: data.byteLength } });
      if (latest.complete) await bumpRev(auth.ns, `files-${sheet}`);
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const data = record.thumb ? await store.thumbs.get(id, { type: 'arrayBuffer' }) : null;
      if (!data) return json({ error: 'No thumbnail' }, 404);
      return new Response(data, {
        headers: { 'Content-Type': record.thumb.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }
      });
    }
  }

  // Finish an upload once every chunk has arrived.
  if (req.method === 'POST' && action === 'finish') {
    const present = await Promise.all(
      Array.from({ length: record.chunks }, (_, i) => store.chunks.getMetadata(chunkKey(id, i)))
    );
    const missing = present.findIndex(meta => !meta);
    if (missing !== -1) return json({ error: `Chunk ${missing} missing` }, 400);
    const done = { ...record, complete: true, uploadedAt: Date.now() };
    await store.records.setJSON(id, done);
    await bumpRev(auth.ns, `files-${sheet}`);
    return json(publicRecord(done, sheet));
  }

  // Download one chunk.
  if (req.method === 'GET' && chunkIndex !== null) {
    if (!record.complete) return json({ error: 'Upload not finished' }, 409);
    const data = await store.chunks.get(chunkKey(id, chunkIndex), { type: 'arrayBuffer' });
    if (!data) return json({ error: 'Chunk missing' }, 404);
    return new Response(data, {
      // A file's chunks never change, so a device can keep them: opening the
      // same file again on that device downloads nothing.
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' }
    });
  }

  // "Keep": the owner still needs this file, so no reminders about its age.
  if (req.method === 'POST' && action === 'keep') {
    if (!record.complete) return json({ error: 'Upload not finished' }, 409);
    const body = await req.json().catch(() => ({}));
    const updated = { ...record, kept: Boolean(body.kept) };
    await store.records.setJSON(id, updated);
    await bumpRev(auth.ns, `files-${sheet}`);
    return json(publicRecord(updated, sheet));
  }

  if (req.method === 'DELETE') {
    await deleteFile(store, record);
    await bumpRev(auth.ns, `files-${sheet}`);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
};
