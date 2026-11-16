import { randomUUID } from 'node:crypto';
import { bumpRev, json, parseSheet, requireUser } from '../lib/auth.mjs';
import { SEALED_OVERHEAD, deleteFileForGood, fileStores, publicRecord, readRecords, visibleFiles } from '../lib/files.mjs';
import { isSealed, isWrappedKey } from '../lib/sheets.mjs';
import { limitsFor, needsPro } from '../lib/plans.mjs';
import { accountUsage, overQuota } from '../lib/usage.mjs';

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

export default async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);

  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  const chunkParam = url.searchParams.get('chunk');

  // List completed files, cleaning up uploads that were abandoned midway, and
  // (while reading) files that have been in Recently Deleted for 30 days.
  if (req.method === 'GET' && !id) {
    const { store, records } = await readRecords(auth.ns, sheet);
    for (const record of records) {
      if (!record.complete && Date.now() - record.startedAt > STALE_UPLOAD_MS) await deleteFileForGood(store, record);
    }
    // ?all=1: also Recently Deleted, for locking files from before encryption.
    if (url.searchParams.get('all') === '1') {
      const all = records.filter(r => r.complete).map(r => ({ ...publicRecord(r, sheet), deletedAt: r.deletedAt || null }));
      return json({ files: all, maxBytes: MAX_FILE_BYTES });
    }
    return json({ files: visibleFiles(records, sheet), maxBytes: MAX_FILE_BYTES });
  }

  const store = fileStores(auth.ns, sheet);

  // Start an upload: reserve an id and tell the client how to chunk it.
  if (req.method === 'POST' && action === 'start') {
    const body = await req.json().catch(() => null);
    const size = Number(body?.size);
    if (!Number.isInteger(size) || size < 0) return json({ error: 'Invalid size' }, 400);
    if (size > MAX_FILE_BYTES) return json({ error: 'File is over 100 MB' }, 413);
    // An encrypted account sends only locked files: a locked name and the file's locked key.
    const sealed = Boolean(body?.enc);
    // Its type is locked too, so the server can't tell a photo from a PDF.
    if ((auth.user.keyring || sealed) && !(sealed && isWrappedKey(body.key) && isSealed(body.name) && isSealed(body.type))) {
      return json({ error: 'Reload ScrapSheet to keep uploading.' }, 400);
    }
    // Locking a file from before encryption: a locked copy replaces it, keeping
    // its dates, and the old one is erased once the copy is complete.
    const old = sealed && validId(body.migrateFrom) ? await store.records.get(body.migrateFrom, { type: 'json' }) : null;
    if (!old) {
      const limits = limitsFor(auth.user);
      if (size > limits.fileBytes) return needsPro('On the Free plan, files can be up to 10 MB. Pro takes files up to 100 MB each.');
      if (Number.isFinite(limits.files) && (await accountUsage(auth.ns)).files >= limits.files) {
        return needsPro('The Free plan holds 1 file. Pro holds as many as fit in 5 GB.');
      }
      const full = await overQuota(auth.user, auth.ns, size);
      if (full) return json({ error: full, quota: true }, 413);
    }

    const record = {
      id: randomUUID(),
      name: sealed ? body.name : String(body?.name || 'file').slice(0, 200),
      type: sealed ? body.type : String(body?.type || 'application/octet-stream').slice(0, 200),
      size,
      chunkSize: CHUNK_BYTES,
      chunks: Math.max(1, Math.ceil(size / CHUNK_BYTES)),
      complete: false,
      startedAt: Date.now(),
      ...(sealed ? { enc: 1, key: body.key } : {}),
      ...(old ? { migrateFrom: old.id, keepDates: { uploadedAt: old.uploadedAt, kept: Boolean(old.kept), deletedAt: old.deletedAt || null } } : {})
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
    const expected = Math.min(record.chunkSize, record.size - chunkIndex * record.chunkSize) + (record.enc ? SEALED_OVERHEAD : 0);
    if (data.byteLength !== expected) return json({ error: 'Wrong chunk size' }, 400);
    await store.chunks.set(chunkKey(id, chunkIndex), data);
    return json({ ok: true });
  }

  // A thumbnail for an image: sent while uploading, or later for older files.
  // An id always names the same file, so a device may keep it for good.
  if (url.searchParams.get('thumb') === '1') {
    if (req.method === 'PUT') {
      const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!THUMB_TYPES.has(type) && !(record.enc && type === 'application/octet-stream')) return json({ error: 'Unsupported thumbnail type' }, 415);
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
    let done = { ...record, complete: true, uploadedAt: Date.now() };
    if (record.migrateFrom) {
      // The locked copy takes the old file's place: same dates, then the old one goes.
      const { migrateFrom, keepDates, ...rest } = done;
      done = { ...rest, uploadedAt: keepDates.uploadedAt || done.uploadedAt, kept: keepDates.kept, ...(keepDates.deletedAt ? { deletedAt: keepDates.deletedAt } : {}) };
      const old = await store.records.get(migrateFrom, { type: 'json' });
      await store.records.setJSON(id, done);
      if (old) await deleteFileForGood(store, old);
    } else {
      await store.records.setJSON(id, done);
    }
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
  // A locked file from before types were locked: its type, locked with its key. Never replaces a locked type.
  if (req.method === 'POST' && action === 'seal-type') {
    const body = await req.json().catch(() => null);
    if (!record.enc || isSealed(record.type)) return json({ ok: true });
    if (!isSealed(body?.type)) return json({ error: 'Bad type' }, 400);
    const latest = (await store.records.get(id, { type: 'json' })) || record;
    await store.records.setJSON(id, { ...latest, type: body.type, ...(latest.thumb ? { thumb: { ...latest.thumb, type: 'application/octet-stream' } } : {}) });
    return json({ ok: true });
  }

  if (req.method === 'POST' && action === 'keep') {
    if (!record.complete) return json({ error: 'Upload not finished' }, 409);
    const body = await req.json().catch(() => ({}));
    const updated = { ...record, kept: Boolean(body.kept) };
    await store.records.setJSON(id, updated);
    await bumpRev(auth.ns, `files-${sheet}`);
    return json(publicRecord(updated, sheet));
  }

  // Deleting moves a file to Recently Deleted; an unfinished upload just goes.
  if (req.method === 'DELETE') {
    if (!record.complete) {
      await deleteFileForGood(store, record);
      return json({ ok: true });
    }
    if (!record.deletedAt) await store.records.setJSON(id, { ...record, deletedAt: Date.now() });
    await bumpRev(auth.ns, `files-${sheet}`);
    return json({ ok: true, trashed: true });
  }

  return json({ error: 'Method not allowed' }, 405);
};
