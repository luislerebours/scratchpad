import { getStore } from '@netlify/blobs';

const SHEET_COUNT = 5;
const MAX_TEXT_CHARS = 1_000_000;
const DEFAULT_NAMES = ['Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4', 'Sheet 5'];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const parseSheet = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SHEET_COUNT ? n : null;
};

async function readNames(store) {
  const data = await store.get('meta/names', { type: 'json' });
  return {
    names: DEFAULT_NAMES.map((fallback, i) => String(data?.names?.[i] || fallback)),
    updatedAt: Number(data?.updatedAt || 0)
  };
}

export default async req => {
  const url = new URL(req.url);
  const store = getStore({ name: 'scratchpad', consistency: 'strong' });

  if (url.searchParams.get('meta') === 'names') {
    if (req.method === 'GET') return json(await readNames(store));
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await req.json().catch(() => null);
    const sheet = parseSheet(body?.sheet);
    const name = String(body?.name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
    if (!sheet || !name) return json({ error: 'Invalid sheet or name' }, 400);

    const current = await readNames(store);
    current.names[sheet - 1] = name;
    const next = { names: current.names, updatedAt: Date.now() };
    await store.setJSON('meta/names', next);
    return json(next);
  }

  // The sheet last opened on any device, so every device reopens there.
  if (url.searchParams.get('meta') === 'current') {
    if (req.method === 'GET') {
      const data = await store.get('meta/current', { type: 'json' });
      return json({ sheet: parseSheet(data?.sheet) || 1, updatedAt: Number(data?.updatedAt || 0) });
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await req.json().catch(() => null);
    const current = parseSheet(body?.sheet);
    if (!current) return json({ error: 'Invalid sheet' }, 400);
    const next = { sheet: current, updatedAt: Date.now() };
    await store.setJSON('meta/current', next);
    return json(next);
  }

  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);
  const key = `sheets/${sheet}`;

  if (req.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    return json({ text: data?.text || '', updatedAt: Number(data?.updatedAt || 0) });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null);
    if (typeof body?.text !== 'string') return json({ error: 'Missing text' }, 400);
    if (body.text.length > MAX_TEXT_CHARS) return json({ error: 'Text too long' }, 413);
    const next = { text: body.text, updatedAt: Date.now() };
    await store.setJSON(key, next);
    return json({ updatedAt: next.updatedAt });
  }

  return json({ error: 'Method not allowed' }, 405);
};
