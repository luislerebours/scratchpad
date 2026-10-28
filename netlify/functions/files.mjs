import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

const SHEET_COUNT = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

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

export default async req => {
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);

  const store = getStore({ name: `scratchpad-files-${sheet}`, consistency: 'strong' });
  const id = url.searchParams.get('id');

  if (req.method === 'GET' && id) {
    if (!validId(id)) return json({ error: 'Invalid id' }, 400);
    const entry = await store.getWithMetadata(id, { type: 'arrayBuffer' });
    if (!entry) return json({ error: 'Not found' }, 404);
    const { name = 'file', type = 'application/octet-stream' } = entry.metadata || {};
    return new Response(entry.data, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store'
      }
    });
  }

  if (req.method === 'GET') {
    const { blobs } = await store.list();
    const files = await Promise.all(
      blobs.map(async ({ key }) => {
        const meta = await store.getMetadata(key);
        return meta && { id: key, sheet, ...meta.metadata };
      })
    );
    return json({
      files: files.filter(Boolean).sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    });
  }

  if (req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') return json({ error: 'Missing file' }, 400);
    if (file.size > MAX_FILE_BYTES) return json({ error: 'File is over 4 MB' }, 413);

    const newId = randomUUID();
    const metadata = {
      name: String(file.name || 'file').slice(0, 200),
      type: file.type || 'application/octet-stream',
      size: file.size,
      uploadedAt: Date.now()
    };
    await store.set(newId, await file.arrayBuffer(), { metadata });
    return json({ id: newId, sheet, ...metadata });
  }

  if (req.method === 'DELETE') {
    if (!validId(id)) return json({ error: 'Invalid id' }, 400);
    await store.delete(id);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
};
