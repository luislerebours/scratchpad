import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import {
  allow, authStore, emailKey, env, hashPassword, checkPassword, json, normalizeEmail, notifySync,
  sameOrigin, validEmail
} from '../lib/auth.mjs';
import {
  adminCookie, adminId, adminStore, audit, listPrefix, checkTotp, clearedAdminCookie, hashRecovery, newRecoveryCodes, newTotpSecret,
  otpauthUri, readAudit, readSettings, requireAdmin, setupConfigured, setupTokenOk, writeSettings
} from '../lib/admin.mjs';
import { clearErrors, readErrors, withErrors } from '../lib/errors.mjs';
import { planOf, playKeepsPro } from '../lib/plans.mjs';
import { readShares, sharesStore, ended } from '../lib/shares.mjs';
import { applySubscription, stripe, stripeReady } from '../lib/stripe.mjs';
import { applyPlay, getSubscription, playReady } from '../lib/play.mjs';
import { accountUsage, quotaFor } from '../lib/usage.mjs';
import { deleteAccount } from '../lib/account.mjs';
import { r2Enabled } from '../lib/r2.mjs';
import { securityNotice } from '../lib/notices.mjs';

// The admin dashboard's API (/admin). Every action except signing in checks
// the admin cookie on the server (requireAdmin). Admins see accounts, plans,
// billing status, storage numbers and activity; never sheet text, names,
// files or images (those are end-to-end encrypted anyway).

const DAY = 24 * 60 * 60 * 1000;
const ENROLL_MS = 20 * 60 * 1000;
const INVITE_MS = 72 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;
const KEEPS_PRO = new Set(['active', 'trialing', 'past_due']);

const validEk = id => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
const tokenHash = token => createHash('sha256').update(`admin-token:${token}`).digest('hex');
const clientIp = (req, context) => context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
const cleanName = name => String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
const stripeMode = () => (/^(sk|rk)_live_/.test(env('STRIPE_SECRET_KEY') || '') ? 'live' : 'test');

const adminView = (admin, me) => ({
  id: admin.id,
  email: admin.email,
  name: admin.name || '',
  createdAt: admin.createdAt,
  createdBy: admin.createdBy || null,
  lastLoginAt: admin.lastLoginAt || null,
  disabledAt: admin.disabledAt || null,
  recoveryLeft: (admin.recovery || []).length,
  you: me ? admin.id === me.id : false
});

// ---- Accounts ----

async function allUsers() {
  const store = authStore();
  const { blobs } = await listPrefix(store, 'users/');
  return (await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))).filter(Boolean);
}

async function accountView(user) {
  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const s = user.stripe || {};
  return {
    id: emailKey(user.email),
    email: user.email,
    originalData: user.ns === '',
    createdAt: user.createdAt || null,
    loginCount: user.loginCount ?? null,
    lastLoginAt: user.lastLoginAt || null,
    lastSeenAt: user.lastSeenAt || null,
    activeDays30: user.visitDays ? user.visitDays.filter(day => day > since).length : null,
    plan: planOf(user),
    planSet: user.plan || null,
    quota: quotaFor(user),
    quotaCustom: user.quotaBytes ?? null,
    encrypted: Boolean(user.keyring),
    paying: Boolean(s.subscription && KEEPS_PRO.has(s.status)) || playKeepsPro(user.play),
    payingVia: Boolean(s.subscription && KEEPS_PRO.has(s.status)) ? 'Stripe' : playKeepsPro(user.play) ? 'Google Play' : null,
    stripe: s.customer ? {
      customer: s.customer,
      subscription: s.subscription || null,
      status: s.status || null,
      interval: s.interval || null,
      periodEnd: s.periodEnd || null,
      cancelAtEnd: Boolean(s.cancelAtEnd)
    } : null,
    // Google Play (Pro bought in the Android app). The purchase token is private: never shown.
    play: user.play ? {
      productId: user.play.productId || null,
      interval: user.play.interval || null,
      status: user.play.state || null,
      periodEnd: user.play.expiresAt || null,
      cancelAtEnd: !user.play.autoRenew,
      test: Boolean(user.play.test)
    } : null,
    disabledAt: user.disabledAt || null,
    disabledBy: user.disabledBy || null,
    ...(await accountUsage(user.ns))
  };
}

// Turns off an account's live share links (kept, marked off).
async function revokeShares(ns) {
  const store = sharesStore();
  const live = (await readShares(ns)).filter(s => !ended(s));
  await Promise.all(live.map(s => store.setJSON(`shares/${s.token}`, { ...s, revoked: true, revokedAt: Date.now(), revokedBy: 'admin', revokedReason: 'admin' })));
  return live.length;
}

async function accountAction(req, admin, body) {
  if (!validEk(body.id)) return json({ error: 'Choose an account' }, 400);
  const store = authStore();
  const key = `users/${body.id}`;
  const user = await store.get(key, { type: 'json' });
  if (!user) return json({ error: 'No such account' }, 404);
  const target = user.email;
  let updated = user;
  let details = {};

  switch (body.op) {
    case 'plan': {
      if (!['free', 'pro'].includes(body.plan)) return json({ error: 'Choose Free or Pro' }, 400);
      updated = { ...user, plan: body.plan };
      details = { from: planOf(user), to: body.plan };
      break;
    }
    case 'quota': {
      // limitGb: null or '' = the plan's limit, 0 = no limit, else that many GB.
      const gb = body.limitGb === null || body.limitGb === '' || body.limitGb === undefined ? null : Number(body.limitGb);
      if (gb !== null && !(Number.isFinite(gb) && gb >= 0 && gb <= 10_000)) return json({ error: 'Enter a number of GB' }, 400);
      const quotaBytes = gb === null ? undefined : gb === 0 ? -1 : Math.round(gb * 1024 ** 3);
      updated = { ...user, quotaBytes };
      if (quotaBytes === undefined) delete updated.quotaBytes;
      details = { from: quotaFor(user), to: quotaFor(updated) };
      break;
    }
    case 'resync': {
      // Pro bought in the Android app: read fresh from Google Play.
      if (user.play?.token && !user.stripe?.customer) {
        if (!playReady()) return json({ error: 'Google Play isn’t set up' }, 503);
        const sub = await getSubscription(user.play.token).catch(() => null);
        if (!sub) return json({ error: 'Google Play didn’t find this account’s subscription' }, 404);
        updated = (await applyPlay(emailKey(user.email), user.play.token, sub)) || user;
        details = { source: 'play', status: sub.subscriptionState, plan: planOf(updated) };
        await audit(req, admin, 'account.resync', { target, ...details });
        return json({ ok: true, account: await accountView(updated) });
      }
      if (!stripeReady()) return json({ error: 'Stripe isn’t set up' }, 503);
      const s = user.stripe || {};
      let sub = null;
      if (s.subscription) sub = await stripe('GET', `subscriptions/${s.subscription}`).catch(() => null);
      if (!sub && s.customer) sub = (await stripe('GET', 'subscriptions', { customer: s.customer, status: 'all', limit: 1 }).catch(() => null))?.data?.[0] || null;
      if (!sub) return json({ error: 'No Stripe subscription found for this account' }, 404);
      updated = (await applySubscription(sub)) || user;
      details = { status: sub.status, plan: planOf(updated) };
      await audit(req, admin, 'account.resync', { target, ...details });
      return json({ ok: true, account: await accountView(updated) });
    }
    case 'deactivate': {
      if (user.disabledAt) return json({ error: 'Already deactivated' }, 409);
      // Signs out every device (sessions carry the version), and stops sign-in,
      // codes and share links. Everything the account holds is kept.
      updated = { ...user, disabledAt: Date.now(), disabledBy: admin.email, version: (user.version || 1) + 1 };
      await store.setJSON(key, updated);
      const ek = body.id;
      await Promise.all([store.delete(`codes/${ek}`), store.delete(`pending/${ek}`)]);
      const links = await revokeShares(user.ns);
      await notifySync(user.ns, 'session', String(Date.now()));
      await audit(req, admin, 'account.deactivate', { target, sharesTurnedOff: links, paying: Boolean(user.stripe?.subscription && KEEPS_PRO.has(user.stripe.status)), reason: cleanName(body.reason) || null });
      return json({ ok: true, account: await accountView(updated) });
    }
    // Deleting an account someone asked support to delete (they can't sign in):
    // exactly what Delete account does in the app. Typed confirmation; the
    // owner is emailed; the audit log keeps who did it and why.
    case 'delete': {
      if (user.ns === '') return json({ error: 'This account holds the original data from before accounts and can’t be deleted here.' }, 409);
      if (String(body.confirm || '').trim().toLowerCase() !== user.email.toLowerCase()) return json({ error: 'Type the account’s email to confirm.' }, 400);
      const result = await deleteAccount(user);
      if (result.error) return json({ error: result.error }, result.status);
      await audit(req, admin, 'account.delete', { target, subscriptionCancelled: result.cancelled, reason: cleanName(body.reason) || null });
      await securityNotice(req, user.email, 'deleted-by-support', { cancelled: result.cancelled });
      return json({ ok: true, deleted: true });
    }
    case 'reactivate': {
      if (!user.disabledAt) return json({ error: 'Not deactivated' }, 409);
      updated = { ...user };
      delete updated.disabledAt;
      delete updated.disabledBy;
      details = {};
      break;
    }
    case 'signout': {
      updated = { ...user, version: (user.version || 1) + 1 };
      await store.setJSON(key, updated);
      await notifySync(user.ns, 'session', String(Date.now()));
      await audit(req, admin, 'account.signout', { target });
      return json({ ok: true, account: await accountView(updated) });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
  await store.setJSON(key, updated);
  await audit(req, admin, `account.${body.op}`, { target, ...details });
  return json({ ok: true, account: await accountView(updated) });
}

// ---- Admins: setup, invites, enrollment, sign-in ----

async function qr(uri) {
  return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

async function startEnrollment(kind, fields) {
  const secret = newTotpSecret();
  const nonce = randomBytes(24).toString('base64url');
  await adminStore().setJSON(`enroll/${tokenHash(nonce)}`, { kind, ...fields, secret, expiresAt: Date.now() + ENROLL_MS });
  const uri = otpauthUri(secret, fields.email);
  return { enrollToken: nonce, secret, uri, qr: await qr(uri) };
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'That password is too long.';
  return null;
}

async function signedInAdmin(admin, body = {}) {
  return json({ admin: adminView(admin, admin), ...body }, 200, { 'Set-Cookie': await adminCookie(admin) });
}

async function publicAction(req, context, action, body) {
  const store = adminStore();
  const ip = clientIp(req, context);

  if (action === 'setup-start') {
    if (!(await allow(`admin-setup-${ip}`, 10, 60 * 60 * 1000))) return json({ error: 'Too many tries. Wait an hour.' }, 429);
    if (await store.get('bootstrap')) return json({ error: 'Setup is already done. Sign in, or ask an admin for an invite.' }, 403);
    if (!setupConfigured()) return json({ error: 'Setup isn’t turned on for this site.' }, 403);
    if (!setupTokenOk(body.setupToken)) {
      await audit(req, null, 'admin.setup-failed', { reason: 'bad setup token' });
      return json({ error: 'That setup token isn’t right.' }, 403);
    }
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return json({ error: 'Enter a valid email address' }, 400);
    const bad = checkNewPassword(body.password);
    if (bad) return json({ error: bad }, 400);
    const { hash, salt } = await hashPassword(body.password);
    return json(await startEnrollment('setup', { email, name: cleanName(body.name), hash, salt }));
  }

  if (action === 'invite-info') {
    const invite = await store.get(`invites/${tokenHash(String(body.invite || ''))}`, { type: 'json' });
    if (!invite || invite.expiresAt < Date.now()) return json({ error: 'This invite has expired or was already used. Ask for a new one.' }, 404);
    return json({ email: invite.email, name: invite.name || '' });
  }

  if (action === 'invite-start') {
    if (!(await allow(`admin-invite-${ip}`, 10, 60 * 60 * 1000))) return json({ error: 'Too many tries. Wait an hour.' }, 429);
    const invite = await store.get(`invites/${tokenHash(String(body.invite || ''))}`, { type: 'json' });
    if (!invite || invite.expiresAt < Date.now()) return json({ error: 'This invite has expired or was already used. Ask for a new one.' }, 404);
    const bad = checkNewPassword(body.password);
    if (bad) return json({ error: bad }, 400);
    const { hash, salt } = await hashPassword(body.password);
    return json(await startEnrollment('invite', {
      email: invite.email, name: cleanName(body.name) || invite.name || '', hash, salt,
      invite: tokenHash(String(body.invite)), createdBy: invite.createdBy
    }));
  }

  if (action === 'enroll-confirm') {
    const key = `enroll/${tokenHash(String(body.enrollToken || ''))}`;
    const enroll = await store.get(key, { type: 'json' });
    if (!enroll || enroll.expiresAt < Date.now()) return json({ error: 'This step has expired. Start again.' }, 400);
    const step = checkTotp(enroll.secret, body.code);
    if (!step) return json({ error: 'That code isn’t right. Check the time on your phone and try the newest code.' }, 400);
    const id = adminId(enroll.email);
    const now = Date.now();
    const { codes, hashes } = newRecoveryCodes();

    if (enroll.kind === 'reset') {
      const admin = await store.get(`admins/${enroll.adminId}`, { type: 'json' });
      if (!admin || admin.disabledAt) return json({ error: 'Admin sign-in required' }, 401);
      const updated = { ...admin, totp: { secret: enroll.secret, confirmedAt: now, lastStep: step }, recovery: hashes, version: admin.version + 1 };
      await store.setJSON(`admins/${admin.id}`, updated);
      await store.delete(key);
      await audit(req, admin, 'admin.mfa-reset', { target: admin.email });
      return signedInAdmin(updated, { recoveryCodes: codes });
    }

    const existing = await store.get(`admins/${id}`, { type: 'json' });
    if (existing && !existing.disabledAt) return json({ error: 'There is already an admin with this email.' }, 409);
    if (enroll.kind === 'setup') {
      // Only the very first admin comes through setup, once.
      const { modified } = await store.set('bootstrap', id, { onlyIfNew: true });
      if (!modified) return json({ error: 'Setup is already done. Sign in, or ask an admin for an invite.' }, 403);
    } else {
      const invite = await store.get(`invites/${enroll.invite}`, { type: 'json' });
      if (!invite || invite.expiresAt < now) return json({ error: 'This invite has expired or was already used. Ask for a new one.' }, 404);
      await store.delete(`invites/${enroll.invite}`);
    }
    const admin = {
      id, email: enroll.email, name: enroll.name || '', hash: enroll.hash, salt: enroll.salt,
      totp: { secret: enroll.secret, confirmedAt: now, lastStep: step }, recovery: hashes,
      version: (existing?.version || 0) + 1, createdAt: now, createdBy: enroll.kind === 'setup' ? 'setup token' : enroll.createdBy,
      lastLoginAt: now
    };
    await store.setJSON(`admins/${id}`, admin);
    await store.delete(key);
    await audit(req, admin, enroll.kind === 'setup' ? 'admin.setup' : 'admin.enrolled', { target: admin.email });
    return signedInAdmin(admin, { recoveryCodes: codes });
  }

  if (action === 'login') {
    const email = normalizeEmail(body.email);
    const id = adminId(email);
    if (!(await allow(`admin-login-${id}`, 10, 15 * 60 * 1000)) || !(await allow(`admin-login-ip-${ip}`, 30, 15 * 60 * 1000))) {
      return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    }
    const admin = validEmail(email) ? await store.get(`admins/${id}`, { type: 'json' }) : null;
    const passwordOk = admin ? await checkPassword(String(body.password || ''), admin) : (await hashPassword('x'), false);
    let step = null;
    let recoveryUsed = null;
    if (passwordOk && admin.totp?.confirmedAt) {
      if (body.recovery) {
        const h = hashRecovery(body.recovery);
        if ((admin.recovery || []).includes(h)) recoveryUsed = h;
      } else {
        step = checkTotp(admin.totp.secret, body.code, admin.totp.lastStep || 0);
      }
    }
    if (!passwordOk || admin.disabledAt || (!step && !recoveryUsed)) {
      await audit(req, null, 'admin.login-failed', {
        target: email.slice(0, 254),
        reason: !passwordOk ? 'password' : admin.disabledAt ? 'disabled' : body.recovery ? 'recovery code' : 'authenticator code'
      });
      return json({ error: 'Wrong email, password or code.' }, 401);
    }
    const updated = {
      ...admin,
      lastLoginAt: Date.now(),
      totp: step ? { ...admin.totp, lastStep: step } : admin.totp,
      recovery: recoveryUsed ? admin.recovery.filter(h => h !== recoveryUsed) : admin.recovery
    };
    await store.setJSON(`admins/${id}`, updated);
    await audit(req, updated, 'admin.login', { method: recoveryUsed ? 'recovery code' : 'authenticator', recoveryLeft: updated.recovery.length });
    return signedInAdmin(updated);
  }

  return null;
}

async function adminAction(req, admin, action, body) {
  const store = adminStore();

  if (action === 'logout') {
    await audit(req, admin, 'admin.logout');
    return json({ ok: true }, 200, { 'Set-Cookie': clearedAdminCookie() });
  }

  if (action === 'account') return accountAction(req, admin, body);

  if (action === 'settings') {
    const before = await readSettings();
    const next = { ...before };
    if (typeof body.signupsOpen === 'boolean') next.signupsOpen = body.signupsOpen;
    await writeSettings(next);
    const changed = Object.keys(next).filter(k => next[k] !== before[k]);
    if (changed.length) await audit(req, admin, 'settings.change', { changes: Object.fromEntries(changed.map(k => [k, { from: before[k], to: next[k] }])) });
    return json({ settings: next });
  }

  if (action === 'errors-clear') {
    const count = await clearErrors();
    await audit(req, admin, 'errors.clear', { count });
    return json({ ok: true });
  }

  if (action === 'invite') {
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return json({ error: 'Enter a valid email address' }, 400);
    const existing = await store.get(`admins/${adminId(email)}`, { type: 'json' });
    if (existing && !existing.disabledAt) return json({ error: 'That person is already an admin.' }, 409);
    const token = randomBytes(24).toString('base64url');
    await store.setJSON(`invites/${tokenHash(token)}`, { email, name: cleanName(body.name), createdBy: admin.email, createdAt: Date.now(), expiresAt: Date.now() + INVITE_MS });
    await audit(req, admin, 'admin.invite', { target: email });
    // In the fragment, so it never reaches server logs.
    return json({ link: `${new URL(req.url).origin}/admin#invite=${token}`, expiresAt: Date.now() + INVITE_MS });
  }

  if (action === 'admin') {
    if (!validEk(body.id)) return json({ error: 'Choose an admin' }, 400);
    const other = await store.get(`admins/${body.id}`, { type: 'json' });
    if (!other) return json({ error: 'No such admin' }, 404);
    if (body.op === 'disable') {
      if (other.id === admin.id) return json({ error: 'You can’t disable yourself. Ask another admin.' }, 400);
      if (other.disabledAt) return json({ error: 'Already disabled' }, 409);
      await store.setJSON(`admins/${other.id}`, { ...other, disabledAt: Date.now(), version: other.version + 1 });
      await audit(req, admin, 'admin.disable', { target: other.email });
    } else if (body.op === 'enable') {
      if (!other.disabledAt) return json({ error: 'Not disabled' }, 409);
      const updated = { ...other };
      delete updated.disabledAt;
      await store.setJSON(`admins/${other.id}`, updated);
      await audit(req, admin, 'admin.enable', { target: other.email });
    } else if (body.op === 'signout') {
      const updated = { ...other, version: other.version + 1 };
      await store.setJSON(`admins/${other.id}`, updated);
      await audit(req, admin, 'admin.signout', { target: other.email });
      if (other.id === admin.id) return json({ ok: true }, 200, { 'Set-Cookie': clearedAdminCookie() });
    } else {
      return json({ error: 'Unknown action' }, 400);
    }
    return json({ ok: true });
  }

  // New recovery codes (the old ones stop working). Needs a current authenticator code.
  if (action === 'my-recovery') {
    const step = checkTotp(admin.totp.secret, body.code, admin.totp.lastStep || 0);
    if (!step) return json({ error: 'That code isn’t right.' }, 400);
    const { codes, hashes } = newRecoveryCodes();
    await store.setJSON(`admins/${admin.id}`, { ...admin, recovery: hashes, totp: { ...admin.totp, lastStep: step } });
    await audit(req, admin, 'admin.recovery-codes');
    return json({ recoveryCodes: codes });
  }

  // A new password: needs the current one and an authenticator code. Signs out other sessions.
  if (action === 'my-password') {
    if (!(await allow(`admin-login-${admin.id}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    if (!(await checkPassword(String(body.password || ''), admin))) return json({ error: 'Your current password isn’t right.' }, 400);
    const step = checkTotp(admin.totp.secret, body.code, admin.totp.lastStep || 0);
    if (!step) return json({ error: 'That code isn’t right.' }, 400);
    const bad = checkNewPassword(body.newPassword);
    if (bad) return json({ error: bad }, 400);
    const updated = { ...admin, ...(await hashPassword(body.newPassword)), version: admin.version + 1, totp: { ...admin.totp, lastStep: step } };
    await store.setJSON(`admins/${admin.id}`, updated);
    await audit(req, admin, 'admin.password');
    return signedInAdmin(updated);
  }

  // A new authenticator (lost phone, signed in with a recovery code). Needs the password.
  if (action === 'mfa-reset-start') {
    if (!(await allow(`admin-login-${admin.id}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    if (!(await checkPassword(String(body.password || ''), admin))) return json({ error: 'Your password isn’t right.' }, 400);
    return json(await startEnrollment('reset', { email: admin.email, adminId: admin.id }));
  }

  return json({ error: 'Unknown action' }, 400);
}

async function adminRead(req, admin, view) {
  const store = adminStore();
  if (view === 'me') return json({ admin: adminView(admin, admin) });

  if (view === 'accounts') {
    const accounts = await Promise.all((await allUsers()).map(accountView));
    accounts.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return json({ accounts, stripeMode: stripeMode() });
  }

  if (view === 'audit') return json({ entries: await readAudit(300) });
  if (view === 'errors') return json({ errors: await readErrors(200) });

  if (view === 'settings') {
    return json({
      settings: await readSettings(),
      // Whether each service is set up: yes/no only, never the values.
      services: {
        stripe: stripeReady() ? stripeMode() : null,
        stripeWebhook: Boolean(env('STRIPE_WEBHOOK_SECRET')),
        play: playReady() ? env('PLAY_PACKAGE_NAME') : null,
        playNotices: Boolean(env('PLAY_RTDN_SECRET')),
        email: Boolean(env('RESEND_API_KEY') && env('MAIL_FROM')),
        sync: Boolean(env('SYNC_URL')),
        filesR2: r2Enabled(),
        legacyOwnerEmail: Boolean(env('OWNER_EMAIL')),
        setupToken: setupConfigured()
      }
    });
  }

  if (view === 'admins') {
    const { blobs } = await listPrefix(store, 'admins/');
    const admins = (await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))).filter(Boolean);
    const { blobs: inviteBlobs } = await listPrefix(store, 'invites/');
    const invites = (await Promise.all(inviteBlobs.map(({ key }) => store.get(key, { type: 'json' }))))
      .filter(i => i && i.expiresAt > Date.now())
      .map(i => ({ email: i.email, createdBy: i.createdBy, expiresAt: i.expiresAt }));
    return json({ admins: admins.map(a => adminView(a, admin)).sort((a, b) => a.createdAt - b.createdAt), invites });
  }

  return json({ error: 'Unknown view' }, 400);
}

export default withErrors('admin-api', async (req, context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // Before sign-in: whether this site still needs its first admin.
  if (req.method === 'GET' && action === 'status') {
    const done = Boolean(await adminStore().get('bootstrap'));
    return json({ setup: done ? 'done' : setupConfigured() ? 'open' : 'off' });
  }

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return json({ error: 'Bad origin' }, 403);
    const body = await req.json().catch(() => ({}));
    const pub = await publicAction(req, context, action, body);
    if (pub) return pub;
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    return adminAction(req, auth.admin, action, body);
  }

  if (req.method === 'GET') {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    return adminRead(req, auth.admin, url.searchParams.get('view') || 'me');
  }

  return json({ error: 'Method not allowed' }, 405);
});
