import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

// Netlify functions accept roughly 4.5 MB of binary per request, so files
// travel in chunks: each upload/download request carries one chunk.
const SHEET_COUNT = 5;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1000 * 1000;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const parseSheet = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SHEET_COUNT ? n : null;
};

const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const chunkKey = (id, index) => `${id}-${index}`;

// Records are kept in their own store so listing never touches chunk data.
const stores = sheet => ({
  records: getStore({ name: `scratchpad-files-${sheet}`, consistency: 'strong' }),
  chunks: getStore({ name: `scratchpad-chunks-${sheet}`, consistency: 'strong' })
});

const publicRecord = (record, sheet) => ({
  id: record.id,
  sheet,
  name: record.name,
  type: record.type,
  size: record.size,
  chunks: record.chunks,
  uploadedAt: record.uploadedAt
});

async function deleteFile({ records, chunks }, record) {
  await Promise.all(
    Array.from({ length: record.chunks }, (_, i) => chunks.delete(chunkKey(record.id, i)))
  );
  await records.delete(record.id);
}

export default async req => {
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);

  const store = stores(sheet);
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

  // Finish an upload once every chunk has arrived.
  if (req.method === 'POST' && action === 'finish') {
    const present = await Promise.all(
      Array.from({ length: record.chunks }, (_, i) => store.chunks.getMetadata(chunkKey(id, i)))
    );
    const missing = present.findIndex(meta => !meta);
    if (missing !== -1) return json({ error: `Chunk ${missing} missing` }, 400);
    const done = { ...record, complete: true, uploadedAt: Date.now() };
    await store.records.setJSON(id, done);
    return json(publicRecord(done, sheet));
  }

  // Download one chunk.
  if (req.method === 'GET' && chunkIndex !== null) {
    if (!record.complete) return json({ error: 'Upload not finished' }, 409);
    const data = await store.chunks.get(chunkKey(id, chunkIndex), { type: 'arrayBuffer' });
    if (!data) return json({ error: 'Chunk missing' }, 404);
    return new Response(data, {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }
    });
  }

  if (req.method === 'DELETE') {
    await deleteFile(store, record);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
};
