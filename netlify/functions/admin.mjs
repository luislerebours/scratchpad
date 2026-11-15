import { MAX_SHEETS, authStore, isAdmin, json, requireUser, userStore } from '../lib/auth.mjs';

// Admin only (the OWNER_EMAIL account): every account, its data use and activity.
const DAY = 24 * 60 * 60 * 1000;

async function recordsSize(store, sizeOf) {
  const { blobs } = await store.list();
  const records = await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)));
  let bytes = 0;
  let count = 0;
  for (const record of records) {
    if (!record?.complete) continue;
    bytes += sizeOf(record);
    count++;
  }
  return { bytes, count };
}

// Text, files and images across all of an account's sheets.
async function usage(ns) {
  const state = userStore(ns, 'state');
  const perSheet = await Promise.all(Array.from({ length: MAX_SHEETS }, async (_, i) => {
    const sheet = i + 1;
    const [doc, files, images] = await Promise.all([
      state.get(`sheets/${sheet}`, { type: 'json' }),
      recordsSize(userStore(ns, 'files', sheet), r => r.size || 0),
      recordsSize(userStore(ns, 'images', sheet), r => (r.size || 0) + (r.preview?.size || 0))
    ]);
    const text = doc ? Buffer.byteLength(doc.text || '') + Buffer.byteLength(doc.html || '') : 0;
    return { text, files, images };
  }));
  return perSheet.reduce((sum, s) => ({
    bytes: sum.bytes + s.text + s.files.bytes + s.images.bytes,
    files: sum.files + s.files.count,
    images: sum.images + s.images.count
  }), { bytes: 0, files: 0, images: 0 });
}

export default async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  if (!isAdmin(auth.user)) return json({ error: 'Not allowed' }, 403);
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const store = authStore();
  const { blobs } = await store.list();
  const users = (await Promise.all(
    blobs.filter(({ key }) => key.startsWith('users/')).map(({ key }) => store.get(key, { type: 'json' }))
  )).filter(Boolean);

  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const accounts = await Promise.all(users.map(async user => ({
    email: user.email,
    owner: user.ns === '',
    createdAt: user.createdAt || null,
    loginCount: user.loginCount ?? null,
    lastLoginAt: user.lastLoginAt || null,
    lastSeenAt: user.lastSeenAt || null,
    activeDays30: user.visitDays ? user.visitDays.filter(day => day > since).length : null,
    ...(await usage(user.ns))
  })));
  accounts.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  return json({
    count: accounts.length,
    totalBytes: accounts.reduce((sum, a) => sum + a.bytes, 0),
    accounts
  });
};
