import { MAX_SHEETS, bumpRev, json, parseSheet, requireUser, userStore } from '../lib/auth.mjs';
import { accountUsage, quotaFor } from '../lib/usage.mjs';

const MAX_TEXT_CHARS = 1_000_000;
const FILE_KINDS = ['files', 'chunks', 'file-thumbs', 'images', 'image-chunks', 'image-previews'];

const cleanName = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);

// The account's sheets, in tab order. Accounts made before sheets could be
// added had five fixed sheets with names in meta/names.
async function readSheets(store) {
  const data = await store.get('meta/sheets', { type: 'json' });
  if (data?.sheets?.length) return data;
  const legacy = await store.get('meta/names', { type: 'json' });
  if (legacy) {
    const names = Array.from({ length: 5 }, (_, i) => cleanName(legacy.names?.[i]) || `Sheet ${i + 1}`);
    return { sheets: names.map((name, i) => ({ id: i + 1, name })), updatedAt: Number(legacy.updatedAt || 0) };
  }
  return { sheets: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Sheet ${i + 1}` })), updatedAt: 0 };
}

async function writeSheets(ns, store, sheets) {
  const next = { sheets, updatedAt: Date.now() };
  await store.setJSON('meta/sheets', next);
  await bumpRev(ns, 'sheets');
  return next;
}

async function emptyStore(store) {
  const { blobs } = await store.list();
  await Promise.all(blobs.map(({ key }) => store.delete(key)));
}

export default async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { ns } = auth;
  const url = new URL(req.url);
  const store = userStore(ns, 'state');
  const meta = url.searchParams.get('meta');

  // Storage used by the account and its limit (null: no limit).
  if (meta === 'usage' && req.method === 'GET') {
    const usage = await accountUsage(ns);
    return json({ bytes: usage.bytes, quota: quotaFor(auth.user) });
  }

  // Every sheet's text in one request, so the page can switch tabs without
  // waiting. Very large sheets are left out; the page fetches those on their own.
  if (meta === 'all' && req.method === 'GET') {
    const { sheets } = await readSheets(store);
    const docs = await Promise.all(sheets.map(s => store.get(`sheets/${s.id}`, { type: 'json' })));
    let room = 3_000_000;
    const out = [];
    sheets.forEach((s, i) => {
      const doc = docs[i];
      const html = typeof doc?.html === 'string' ? doc.html : null;
      const text = html === null ? String(doc?.text || '') : null;
      const size = (html ?? text).length;
      if (size > room) return;
      room -= size;
      out.push({ id: s.id, html, text, updatedAt: Number(doc?.updatedAt || 0) });
    });
    // What each tab shows under its name: whether it holds anything, and its file count.
    const fileCounts = await Promise.all(sheets.map(async s => {
      const records = userStore(ns, 'files', s.id);
      const { blobs } = await records.list();
      const all = await Promise.all(blobs.map(({ key }) => records.get(key, { type: 'json' }).catch(() => null)));
      return all.filter(r => r?.complete).length;
    }));
    const status = sheets.map((s, i) => ({
      id: s.id,
      content: Boolean(String(docs[i]?.text || '').trim() || /<img\b/i.test(String(docs[i]?.html || ''))),
      files: fileCounts[i]
    }));
    return json({ sheets: out, status });
  }

  // The 2-second check: just the change markers for the tabs and one sheet.
  if (meta === 'poll' && req.method === 'GET') {
    const sheet = parseSheet(url.searchParams.get('sheet'));
    if (!sheet) return json({ error: 'Invalid sheet' }, 400);
    const [sheets, text, files] = await Promise.all(
      ['sheets', `text-${sheet}`, `files-${sheet}`].map(part => store.get(`rev/${part}`))
    );
    return json({ sheets: sheets || '0', text: text || '0', files: files || '0' });
  }

  if (meta === 'sheets') {
    if (req.method === 'GET') return json(await readSheets(store));
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({}));
    const { sheets } = await readSheets(store);

    if (body.action === 'add') {
      if (sheets.length >= MAX_SHEETS) return json({ error: `You can have up to ${MAX_SHEETS} sheets.` }, 400);
      const used = new Set(sheets.map(s => s.id));
      const id = Array.from({ length: MAX_SHEETS }, (_, i) => i + 1).find(n => !used.has(n));
      // A freed slot may hold leftovers from a deleted sheet; start it clean.
      await store.delete(`sheets/${id}`);
      await Promise.all([bumpRev(ns, `text-${id}`), bumpRev(ns, `files-${id}`)]);
      return json({ ...(await writeSheets(ns, store, [...sheets, { id, name: cleanName(body.name) || `Sheet ${id}` }])), added: id });
    }

    const sheet = parseSheet(body.sheet);
    if (!sheets.some(s => s.id === sheet)) return json({ error: 'No such sheet' }, 404);

    if (body.action === 'rename') {
      const name = cleanName(body.name);
      if (!name) return json({ error: 'Enter a name' }, 400);
      return json(await writeSheets(ns, store, sheets.map(s => (s.id === sheet ? { ...s, name } : s))));
    }

    if (body.action === 'delete') {
      if (sheets.length === 1) return json({ error: 'You need at least one sheet.' }, 400);
      const next = await writeSheets(ns, store, sheets.filter(s => s.id !== sheet));
      await store.delete(`sheets/${sheet}`);
      await Promise.all(FILE_KINDS.map(kind => emptyStore(userStore(ns, kind, sheet))));
      await Promise.all([bumpRev(ns, `text-${sheet}`), bumpRev(ns, `files-${sheet}`)]);
      return json(next);
    }

    return json({ error: 'Unknown action' }, 400);
  }

  // The sheet last opened on any device, so every device reopens there.
  if (meta === 'current') {
    const { sheets } = await readSheets(store);
    if (req.method === 'GET') {
      const data = await store.get('meta/current', { type: 'json' });
      const sheet = sheets.some(s => s.id === data?.sheet) ? data.sheet : sheets[0].id;
      return json({ sheet, updatedAt: Number(data?.updatedAt || 0) });
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => null);
    const current = parseSheet(body?.sheet);
    if (!sheets.some(s => s.id === current)) return json({ error: 'Invalid sheet' }, 400);
    const next = { sheet: current, updatedAt: Date.now() };
    await store.setJSON('meta/current', next);
    return json(next);
  }

  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);
  const key = `sheets/${sheet}`;

  if (req.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    return json({ text: data?.text || '', html: data?.html ?? null, updatedAt: Number(data?.updatedAt || 0) });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null);
    if (typeof body?.text !== 'string') return json({ error: 'Missing text' }, 400);
    if (body.text.length > MAX_TEXT_CHARS) return json({ error: 'Text too long' }, 413);
    // html carries the layout with inline images; the page sanitizes it whenever it is shown.
    const html = typeof body.html === 'string' ? body.html : null;
    if (html && html.length > MAX_TEXT_CHARS * 2) return json({ error: 'Text too long' }, 413);
    const next = { text: body.text, html, updatedAt: Date.now() };
    await store.setJSON(key, next);
    const rev = await bumpRev(ns, `text-${sheet}`);
    return json({ updatedAt: next.updatedAt, rev });
  }

  return json({ error: 'Method not allowed' }, 405);
};
