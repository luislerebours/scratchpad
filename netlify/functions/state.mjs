import { MAX_SHEETS, bumpRev, bumpRevForDevice, json, parseSheet, requireUser, userStore } from '../lib/auth.mjs';
import {
  TRASH_DAYS, deleteFileForGood, publicRecord, readRecords, readSheetTrash, visibleFiles, wipeSheet, writeSheetTrash
} from '../lib/files.mjs';
import { cleanName, isSealed, isWrappedKey, readSheets } from '../lib/sheets.mjs';
import { liveShares } from '../lib/shares.mjs';
import { limitsFor, needsPro } from '../lib/plans.mjs';
import { accountUsage, quotaFor } from '../lib/usage.mjs';
import { withErrors } from '../lib/errors.mjs';

const MAX_TEXT_CHARS = 1_000_000;

async function writeSheets(ns, store, sheets) {
  const next = { sheets, updatedAt: Date.now() };
  await store.setJSON('meta/sheets', next);
  await bumpRev(ns, 'sheets');
  return next;
}

export default withErrors('state', async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { ns } = auth;
  const url = new URL(req.url);
  const store = userStore(ns, 'state');
  const meta = url.searchParams.get('meta');
  const limits = limitsFor(auth.user);
  const startSheets = limits.sheets === 1 ? 1 : 5;
  // End-to-end encrypted accounts only ever send us locked text, names and keys.
  const locked = Boolean(auth.user.keyring);
  const SEALED_ONLY = 'Reload ScrapSheet to keep editing.';

  // Storage used by the account and its limit (null: no limit).
  if (meta === 'usage' && req.method === 'GET') {
    const usage = await accountUsage(ns);
    return json({ bytes: usage.bytes, quota: quotaFor(auth.user) });
  }

  // Every sheet's text in one request, so the page can switch tabs without
  // waiting. Very large sheets are left out; the page fetches those on their own.
  if (meta === 'all' && req.method === 'GET') {
    const { sheets } = await readSheets(store, startSheets);
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
    // What each tab shows under its name (whether it holds anything, and its
    // files), and every file name for search. Reading also clears out what has
    // been in Recently Deleted for 30 days.
    const [fileLists, trash, shares] = await Promise.all([
      Promise.all(sheets.map(async s => visibleFiles((await readRecords(ns, s.id)).records, s.id))),
      readSheetTrash(ns),
      liveShares(ns)
    ]);
    const status = sheets.map((s, i) => ({
      id: s.id,
      // Locked sheets say themselves whether they hold anything; older ones we can read.
      content: typeof docs[i]?.filled === 'boolean' ? docs[i].filled : Boolean(String(docs[i]?.text || '').trim() || /<img\b/i.test(String(docs[i]?.html || ''))),
      files: fileLists[i].length,
      fileList: fileLists[i]
    }));
    return json({ sheets: out, status, trashedSheets: trash.length, shares });
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
    if (req.method === 'GET') return json(await readSheets(store, startSheets));
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({}));
    const { sheets } = await readSheets(store, startSheets);

    if (body.action === 'add') {
      if (sheets.length >= limits.sheets && limits.sheets < MAX_SHEETS) return needsPro('The Free plan has 1 sheet. Pro has up to 10.');
      if (sheets.length >= MAX_SHEETS) return json({ error: `You can have up to ${MAX_SHEETS} sheets.` }, 400);
      let trash = await readSheetTrash(ns);
      // Every slot taken, some by deleted sheets: the owner may delete one for good to make room.
      const purge = trash.find(t => t.id === parseSheet(body.purge));
      if (purge) {
        await wipeSheet(ns, purge.id);
        trash = trash.filter(t => t !== purge);
        await writeSheetTrash(ns, trash);
      }
      const used = new Set([...sheets.map(s => s.id), ...trash.map(t => t.id)]);
      const id = Array.from({ length: MAX_SHEETS }, (_, i) => i + 1).find(n => !used.has(n));
      if (!id) {
        const oldest = [...trash].sort((a, b) => a.deletedAt - b.deletedAt)[0];
        return json({ error: 'Recently Deleted is holding the last free sheet.', purge: { id: oldest.id, name: oldest.name, key: oldest.key || null } }, 409);
      }
      if (locked && (!isWrappedKey(body.key) || !isSealed(body.name))) return json({ error: SEALED_ONLY }, 400);
      // A freed slot may hold leftovers from a deleted sheet; start it clean.
      await store.delete(`sheets/${id}`);
      await Promise.all([bumpRev(ns, `text-${id}`), bumpRev(ns, `files-${id}`)]);
      const entry = { id, name: cleanName(body.name) || `Sheet ${id}`, ...(isWrappedKey(body.key) ? { key: body.key } : {}) };
      return json({ ...(await writeSheets(ns, store, [...sheets, entry])), added: id });
    }

    // A key (and locked name) for a sheet that has none yet: new and older
    // sheets of an encrypted account, live or in Recently Deleted. Never replaces a key.
    if (body.action === 'set-key') {
      const id = parseSheet(body.sheet);
      if (!isWrappedKey(body.key) || !isSealed(body.name)) return json({ error: 'Bad key' }, 400);
      const trash = await readSheetTrash(ns);
      if (sheets.some(s => s.id === id && !s.key)) {
        return json(await writeSheets(ns, store, sheets.map(s => (s.id === id ? { ...s, key: body.key, name: body.name } : s))));
      }
      if (trash.some(t => t.id === id && !t.key)) {
        await writeSheetTrash(ns, trash.map(t => (t.id === id ? { ...t, key: body.key, name: body.name } : t)));
      }
      return json(await readSheets(store, startSheets));
    }

    const sheet = parseSheet(body.sheet);
    if (!sheets.some(s => s.id === sheet)) return json({ error: 'No such sheet' }, 404);

    if (body.action === 'rename') {
      const name = cleanName(body.name);
      if (!name) return json({ error: 'Enter a name' }, 400);
      if (locked && !isSealed(name)) return json({ error: SEALED_ONLY }, 400);
      return json(await writeSheets(ns, store, sheets.map(s => (s.id === sheet ? { ...s, name } : s))));
    }

    // Deleting moves the sheet, with its text and files, to Recently Deleted.
    if (body.action === 'delete') {
      if (sheets.length === 1) return json({ error: 'You need at least one sheet.' }, 400);
      const position = sheets.findIndex(s => s.id === sheet);
      const trash = await readSheetTrash(ns);
      await writeSheetTrash(ns, [...trash.filter(t => t.id !== sheet), { id: sheet, name: sheets[position].name, key: sheets[position].key, deletedAt: Date.now(), position }]);
      return json({ ...(await writeSheets(ns, store, sheets.filter(s => s.id !== sheet))), trashed: sheet });
    }

    return json({ error: 'Unknown action' }, 400);
  }

  // Recently Deleted: sheets and files kept for TRASH_DAYS before going for good.
  if (meta === 'trash') {
    const { sheets } = await readSheets(store, startSheets);
    const trash = await readSheetTrash(ns);

    if (req.method === 'GET') {
      const [active, held] = await Promise.all([
        Promise.all(sheets.map(async s => ({ sheet: s, ...(await readRecords(ns, s.id)) }))),
        Promise.all(trash.map(async t => ({ t, ...(await readRecords(ns, t.id)) })))
      ]);
      const files = active.flatMap(({ sheet, records }) => records
        .filter(r => r.complete && r.deletedAt)
        .map(r => ({ ...publicRecord(r, sheet.id), sheetName: sheet.name, deletedAt: r.deletedAt })));
      const deletedSheets = held.map(({ t, records }) => {
        const done = records.filter(r => r.complete);
        return { id: t.id, name: t.name, key: t.key || null, deletedAt: t.deletedAt, files: done.length, bytes: done.reduce((n, r) => n + (r.size || 0), 0) };
      });
      const byNewest = (a, b) => b.deletedAt - a.deletedAt;
      return json({ days: TRASH_DAYS, sheets: deletedSheets.sort(byNewest), files: files.sort(byNewest) });
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({}));
    const sheet = parseSheet(body.sheet);

    if (body.action === 'restore-sheet' || body.action === 'delete-sheet') {
      const held = trash.find(t => t.id === sheet);
      if (!held) return json({ error: 'That sheet is no longer in Recently Deleted.' }, 404);
      await writeSheetTrash(ns, trash.filter(t => t !== held));
      if (body.action === 'delete-sheet') {
        await wipeSheet(ns, sheet);
        return json({ ok: true });
      }
      const next = [...sheets];
      next.splice(Math.min(Number.isInteger(held.position) ? held.position : next.length, next.length), 0, { id: held.id, name: held.name, ...(held.key ? { key: held.key } : {}) });
      await Promise.all([bumpRev(ns, `text-${sheet}`), bumpRev(ns, `files-${sheet}`)]);
      return json(await writeSheets(ns, store, next));
    }

    if (body.action === 'restore-file' || body.action === 'delete-file') {
      if (!sheets.some(s => s.id === sheet)) return json({ error: 'Restore its sheet first.' }, 404);
      const { store: files, records } = await readRecords(ns, sheet);
      const record = records.find(r => r.id === body.id && r.deletedAt);
      if (!record) return json({ error: 'That file is no longer in Recently Deleted.' }, 404);
      if (body.action === 'delete-file') {
        await deleteFileForGood(files, record);
        return json({ ok: true });
      }
      const { deletedAt, ...restored } = record;
      await files.records.setJSON(record.id, restored);
      await bumpRev(ns, `files-${sheet}`);
      return json({ ok: true, file: publicRecord(restored, sheet) });
    }

    if (body.action === 'empty') {
      await Promise.all(trash.map(t => wipeSheet(ns, t.id)));
      await writeSheetTrash(ns, []);
      await Promise.all(sheets.map(async s => {
        const { store: files, records } = await readRecords(ns, s.id);
        await Promise.all(records.filter(r => r.deletedAt).map(r => deleteFileForGood(files, r)));
      }));
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  }

  // The sheet last opened on any device, so every device reopens there.
  if (meta === 'current') {
    const { sheets } = await readSheets(store, startSheets);
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
    if (html && html.length > MAX_TEXT_CHARS * 3) return json({ error: 'Text too long' }, 413);
    let next = { text: body.text, html, updatedAt: Date.now() };
    if (locked) {
      // Locked text: we keep it as sent, plus what we can't read for ourselves:
      // whether it holds anything (for the tab), and which images it uses (so
      // unused ones can be cleared away).
      if (!(typeof html === 'string' && html.startsWith('e1:') && /^[A-Za-z0-9_-]+$/.test(html.slice(3)))) return json({ error: SEALED_ONLY }, 400);
      const images = Array.isArray(body.images) ? body.images.filter(id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)).slice(0, 2000) : [];
      next = { text: '', html, filled: Boolean(body.filled), images, updatedAt: next.updatedAt };
    }
    await store.setJSON(key, next);
    const { rev, notice } = await bumpRevForDevice(ns, `text-${sheet}`);
    return json({ updatedAt: next.updatedAt, rev, ...(notice ? { notice } : {}) });
  }

  return json({ error: 'Method not allowed' }, 405);
});
