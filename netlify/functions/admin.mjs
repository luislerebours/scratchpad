import { authStore, emailKey, isAdmin, json, normalizeEmail, requireUser } from '../lib/auth.mjs';
import { accountUsage, quotaFor } from '../lib/usage.mjs';
import { planOf } from '../lib/plans.mjs';

// Admin only (the OWNER_EMAIL account): every account, its data use and activity.
const DAY = 24 * 60 * 60 * 1000;

export default async req => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  if (!isAdmin(auth.user)) return json({ error: 'Not allowed' }, 403);
  const store = authStore();

  // Change an account's storage limit: limitGb null = default, 0 = no limit.
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const key = `users/${emailKey(normalizeEmail(body.email))}`;
    const user = await store.get(key, { type: 'json' });
    if (!user) return json({ error: 'No such account' }, 404);
    if (body.plan !== undefined) {
      if (!['free', 'pro'].includes(body.plan)) return json({ error: 'Choose Free or Pro' }, 400);
      const updated = { ...user, plan: body.plan };
      await store.setJSON(key, updated);
      return json({ ok: true, plan: planOf(updated), quota: quotaFor(updated) });
    }
    const gb = body.limitGb === null || body.limitGb === '' ? null : Number(body.limitGb);
    if (gb !== null && !(Number.isFinite(gb) && gb >= 0 && gb <= 10_000)) return json({ error: 'Enter a number of GB' }, 400);
    const quotaBytes = gb === null ? undefined : gb === 0 ? -1 : Math.round(gb * 1024 ** 3);
    const updated = { ...user, quotaBytes };
    if (quotaBytes === undefined) delete updated.quotaBytes;
    await store.setJSON(key, updated);
    return json({ ok: true, quota: quotaFor(updated) });
  }
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

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
    quota: quotaFor(user),
    plan: planOf(user),
    ...(await accountUsage(user.ns))
  })));
  accounts.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  return json({
    count: accounts.length,
    totalBytes: accounts.reduce((sum, a) => sum + a.bytes, 0),
    accounts
  });
};
