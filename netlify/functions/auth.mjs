import { randomBytes } from 'node:crypto';
import {
  DEACTIVATED, MAX_SHEETS, allow, authStore, checkPassword, clearedCookie, emailKey, env, hashCode, hashPassword, json, notifySync,
  makeCode, normalizeCode, normalizeEmail, requireUser, sameOrigin, sessionCookie, sign, userStore, validEmail, verify
} from '../lib/auth.mjs';
import { wipeSheet } from '../lib/files.mjs';
import { readSettings } from '../lib/admin.mjs';
import { withErrors } from '../lib/errors.mjs';
import { sendEmail } from '../lib/email.mjs';
import { planInfo } from '../lib/plans.mjs';
import { customerKey, stripe, stripeReady } from '../lib/stripe.mjs';
import { readShares, sharesStore } from '../lib/shares.mjs';

// Accounts: email a code (an animal and four digits), check it, choose a
// password, then sign in with email and password. The same code steps reset
// a forgotten password.
const CODE_MS = 15 * 60 * 1000;
const SET_PASSWORD_MS = 30 * 60 * 1000;
const MAX_CODE_TRIES = 5;
const HOUR = 60 * 60 * 1000;

// The sign-in / reset code, in the shared email template (lib/email.mjs).
async function sendCodeEmail(to, code, link) {
  await sendEmail({
    to,
    origin: new URL(link).origin,
    subject: `Your ScrapSheet code: ${code}`,
    preheader: `Your code is ${code}. It works once and expires in 15 minutes.`,
    heading: 'Your sign-in code',
    intro: 'Enter this code in ScrapSheet to keep going. It works once and expires in 15 minutes.',
    box: { title: 'Your code', code },
    button: { label: 'Open ScrapSheet', url: link },
    note: 'If you didn’t ask for this, you can ignore this email.',
    // Local tests read codes from this line.
    devLog: `[dev mail] to ${to}: code ${code} link ${link}`
  });
}

// End-to-end encryption: the page turns the password into an auth secret (what
// we check, stored only as a scrypt hash) and a key we never see. Accounts from
// before that send the plain password once more, and are upgraded on the spot.
// The keyring holds the account's master key, locked by that password key and
// by the recovery key; we can't open it.

const validAuth = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const b64ish = (value, max = 400) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const validKeyring = k => k && k.v === 1 && b64ish(k.byPassword) && b64ish(k.byRecovery) && b64ish(k.recoverySalt, 40);
const cleanKeyring = k => ({ v: 1, byPassword: k.byPassword, byRecovery: k.byRecovery, recoverySalt: k.recoverySalt });

// Checks what a sign-in sent against the stored hash: the auth secret, or (for
// accounts not yet upgraded) the plain password. Returns the account as it
// should be saved, or null.
async function checkSecret(user, body) {
  if (user.authV === 2) return validAuth(body.auth) && (await checkPassword(body.auth, user)) ? user : null;
  const password = String(body.password || '');
  if (!password || !validAuth(body.auth) || !(await checkPassword(password, user))) return null;
  return { ...user, ...(await hashPassword(body.auth)), authV: 2 };
}

async function signedIn(user, body = {}) {
  return json({
    email: user.email,
    keyring: user.keyring || null,
    locked: Boolean(user.keyring) && !user.migratedAt ? 'migrating' : user.keyring ? 'on' : 'off',
    // Whether files and images uploaded before their types were locked have been done.
    typesSealed: Boolean(user.typesSealedAt),
    plan: planInfo(user),
    ...body
  }, 200, { 'Set-Cookie': await sessionCookie(user) });
}

// ---- Security notices ----
// A short email when something changes about how the account is reached or
// kept, so the owner hears about it if it wasn't them. Says when, and the kind
// of device (from its browser), nothing else; never stored. A notice that can't
// be sent never stops the action itself.

const SUPPORT = 'support@sector809labs.com';

function deviceOf(req) {
  const ua = req.headers.get('user-agent') || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'An unknown device';
}

const whenText = () => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date())} UTC`;

const NOTICES = {
  password: {
    subject: 'Your ScrapSheet password was changed',
    heading: 'Your password was changed',
    intro: 'The password for your ScrapSheet account was just changed, and every other device was signed out.'
  },
  'start-over': {
    subject: 'Your ScrapSheet account was started over',
    heading: 'Your account was started over',
    intro: 'Your ScrapSheet account was started over with a new password. Everything that was in it was erased, and every other device was signed out.'
  },
  recovery: {
    subject: 'A new ScrapSheet recovery key was made',
    heading: 'A new recovery key was made',
    intro: 'A new recovery key was just made for your ScrapSheet account. The old one no longer works.'
  },
  'signout-all': {
    subject: 'Signed out of ScrapSheet everywhere',
    heading: 'Signed out of all devices',
    intro: 'Every device signed in to your ScrapSheet account was just signed out.'
  },
  deleted: {
    subject: 'Your ScrapSheet account was deleted',
    heading: 'Your account was deleted',
    intro: 'Your ScrapSheet account and everything in it were permanently deleted.'
  }
};

async function securityNotice(req, email, kind, { cancelled = false } = {}) {
  const n = NOTICES[kind];
  const origin = new URL(req.url).origin;
  const intro = n.intro + (cancelled ? ' Your Pro subscription was cancelled too, so you won’t be charged again.' : '');
  try {
    await sendEmail({
      to: email,
      origin,
      subject: n.subject,
      preheader: intro,
      heading: n.heading,
      intro,
      box: { title: 'When and where', body: `${whenText()} · ${deviceOf(req)}` },
      ...(kind === 'deleted' ? {} : { button: { label: 'Open ScrapSheet', url: origin } }),
      note: kind === 'deleted'
        ? `If you didn’t do this, email ${SUPPORT} right away. Thanks for using ScrapSheet.`
        : `Wasn’t you? Reset your password right away (“Forgot password?” on the sign-in page) and email ${SUPPORT}.`,
      // Local tests read this line.
      devLog: `[dev mail] to ${email}: security ${kind} (${deviceOf(req)})${cancelled ? ' +cancelled' : ''}`
    });
  } catch (err) {
    console.error('Security notice not sent', kind, err?.message);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// Activity for the admin view: sign-ins, and the days the pad was opened.
function withSignIn(user) {
  return { ...user, loginCount: (user.loginCount || 0) + 1, lastLoginAt: Date.now(), ...withVisit(user) };
}

function withVisit(user) {
  const days = (user.visitDays || []).filter(day => day !== today());
  return { lastSeenAt: Date.now(), visitDays: [...days, today()].slice(-60) };
}

// Every sheet slot (text, files, images), the account's lists and markers,
// and its share links.
async function deleteAccountData(ns) {
  const shares = await readShares(ns);
  const links = sharesStore();
  await Promise.all(shares.map(async s => {
    const { blobs } = await links.list({ prefix: `count/${s.token}/` });
    await Promise.all([links.delete(`shares/${s.token}`), ...blobs.map(({ key }) => links.delete(key))]);
  }));
  await Promise.all(Array.from({ length: MAX_SHEETS }, (_, i) => wipeSheet(ns, i + 1)));
  const state = userStore(ns, 'state');
  const { blobs } = await state.list();
  await Promise.all(blobs.map(({ key }) => state.delete(key)));
}

export default withErrors('auth', async (req, context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const store = authStore();

  // Who is signed in. Each visit renews the one-year cookie.
  if (req.method === 'GET') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    let user = auth.user;
    // Record at most one visit an hour, to keep writes down.
    if (Date.now() - (user.lastSeenAt || 0) > 60 * 60 * 1000 || user.visitDays?.at(-1) !== today()) {
      user = { ...user, ...withVisit(user) };
      await store.setJSON(`users/${emailKey(user.email)}`, user);
    }
    return signedIn(user);
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(req)) return json({ error: 'Bad origin' }, 403);
  const body = await req.json().catch(() => ({}));

  if (action === 'logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  }

  if (action === 'logout-all') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    const ek = emailKey(auth.user.email);
    await store.setJSON(`users/${ek}`, { ...auth.user, version: auth.user.version + 1 });
    // Open devices re-check right away and find themselves signed out.
    await notifySync(auth.user.ns, 'session', String(Date.now()));
    await securityNotice(req, auth.user.email, 'signout-all');
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  }

  // Signed in on this device from before encryption: the password proves it's
  // the owner once more, and becomes an auth secret.
  if (action === 'upgrade') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    const ek = emailKey(auth.user.email);
    if (!(await allow(`login-${ek}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    // Also checked when already upgraded: the keyring made next must match the real password.
    const checked = await checkSecret(auth.user, body);
    // 400, not 401: a 401 would send the page back to sign-in.
    if (!checked) return json({ error: 'That password isn’t right.' }, 400);
    if (checked !== auth.user) await store.setJSON(`users/${ek}`, checked);
    return json({ ok: true });
  }

  // The first keyring for an account from before encryption. Only one is ever
  // kept: if another device got there first, its keyring comes back instead.
  if (action === 'keyring') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    if (auth.user.keyring) return json({ keyring: auth.user.keyring, existing: true }, 409);
    if (!validKeyring(body.keyring)) return json({ error: 'Bad keyring' }, 400);
    await store.setJSON(`users/${emailKey(auth.user.email)}`, { ...auth.user, keyring: cleanKeyring(body.keyring) });
    return json({ ok: true, keyring: cleanKeyring(body.keyring) });
  }

  // A new recovery key (the old one stops working). Needs the password.
  if (action === 'recovery') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    if (!auth.user.keyring) return json({ error: 'Set up encryption first.' }, 409);
    const ek = emailKey(auth.user.email);
    if (!(await allow(`login-${ek}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    if (!(await checkSecret(auth.user, body))) return json({ error: 'That password isn’t right.' }, 400);
    if (!b64ish(body.byRecovery) || !b64ish(body.recoverySalt, 40)) return json({ error: 'Bad recovery key' }, 400);
    const keyring = { ...auth.user.keyring, byRecovery: body.byRecovery, recoverySalt: body.recoverySalt };
    await store.setJSON(`users/${ek}`, { ...auth.user, keyring });
    await securityNotice(req, auth.user.email, 'recovery');
    return json({ ok: true, keyring });
  }

  // Every file and image type is now locked too.
  if (action === 'types-sealed') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    if (!auth.user.keyring || !auth.user.migratedAt) return json({ error: 'Not yet' }, 409);
    await store.setJSON(`users/${emailKey(auth.user.email)}`, { ...auth.user, typesSealedAt: Date.now() });
    return json({ ok: true });
  }

  // Everything from before encryption is now locked.
  // Delete the account and everything in it. Needs the password (as the sign-in
  // secret); a paid Pro subscription is cancelled first so it never bills again.
  if (action === 'delete-account') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    const { user, ns } = auth;
    const ek = emailKey(user.email);
    if (!(await allow(`delete-${ek}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    // 400, not 401: a 401 would send the page back to sign-in.
    if (!(await checkSecret(user, body))) return json({ error: 'That password isn’t right.' }, 400);
    const sub = user.stripe?.subscription;
    const cancelling = Boolean(sub && !['canceled', 'incomplete_expired'].includes(user.stripe.status));
    if (cancelling) {
      if (!stripeReady()) return json({ error: 'Couldn’t cancel your Pro subscription. Try again later, or email support.' }, 503);
      try {
        await stripe('DELETE', `subscriptions/${sub}`);
      } catch (err) {
        // Already gone at Stripe is fine; anything else stops the deletion so nobody keeps paying for nothing.
        if (err.status !== 404) {
          console.error('Cancel on delete', err.status, err.message);
          return json({ error: 'Couldn’t cancel your Pro subscription. Try again in a minute, or email support.' }, 502);
        }
      }
    }
    await deleteAccountData(ns);
    await Promise.all([`users/${ek}`, `codes/${ek}`, `pending/${ek}`].map(key => store.delete(key)));
    if (user.stripe?.customer) await store.delete(customerKey(user.stripe.customer));
    // Other devices check in and find the account gone.
    await notifySync(ns, 'session', String(Date.now()));
    await securityNotice(req, user.email, 'deleted', { cancelled: cancelling });
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  }

  if (action === 'migrated') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    if (!auth.user.keyring) return json({ error: 'No keyring' }, 409);
    await store.setJSON(`users/${emailKey(auth.user.email)}`, { ...auth.user, migratedAt: Date.now() });
    return json({ ok: true });
  }

  const email = normalizeEmail(body.email);

  if (action === 'request-code') {
    if (!validEmail(email)) return json({ error: 'Enter a valid email address' }, 400);
    const ek = emailKey(email);
    const ip = context?.ip || 'unknown';
    // New sign-ups can be paused from the admin dashboard; existing accounts still get codes.
    if (!(await readSettings()).signupsOpen && !(await store.get(`users/${ek}`))) {
      return json({ error: 'New sign-ups are paused right now. Please try again later.' }, 403);
    }
    if (!(await allow(`code-email-${ek}`, 5, HOUR)) || !(await allow(`code-ip-${ip}`, 20, HOUR))) {
      return json({ error: 'Too many codes requested. Try again in an hour.' }, 429);
    }
    const code = makeCode();
    await store.setJSON(`codes/${ek}`, { hash: hashCode(code, ek), expiresAt: Date.now() + CODE_MS, tries: 0 });
    const link = `${url.origin}/?step=code&email=${encodeURIComponent(email)}`;
    try {
      await sendCodeEmail(email, code, link);
    } catch (err) {
      console.error('Sending code failed', err);
      return json({ error: 'Couldn’t send the email. Try again shortly.' }, 502);
    }
    return json({ ok: true });
  }

  if (action === 'verify-code') {
    const ek = emailKey(email);
    const record = await store.get(`codes/${ek}`, { type: 'json' });
    if (!record || record.expiresAt < Date.now()) return json({ error: 'That code has expired. Ask for a new one.' }, 400);
    if (record.hash !== hashCode(normalizeCode(body.code), ek)) {
      if (record.tries + 1 >= MAX_CODE_TRIES) {
        await store.delete(`codes/${ek}`);
        return json({ error: 'Too many wrong tries. Ask for a new code.' }, 429);
      }
      await store.setJSON(`codes/${ek}`, { ...record, tries: record.tries + 1 });
      return json({ error: 'That code isn’t right.' }, 400);
    }
    await store.delete(`codes/${ek}`);
    const existingUser = await store.get(`users/${ek}`, { type: 'json' });
    if (existingUser?.disabledAt) return json({ error: DEACTIVATED }, 403);
    // A single-use pass to choose a password in the next step. An encrypted
    // account also gets its recovery-locked key: only the recovery key opens it.
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + SET_PASSWORD_MS;
    await store.setJSON(`pending/${ek}`, { nonce, expiresAt });
    const token = await sign({ t: 'pw', ek, email, n: nonce, exp: expiresAt });
    const existing = existingUser;
    const recovery = existing?.keyring ? { byRecovery: existing.keyring.byRecovery, recoverySalt: existing.keyring.recoverySalt } : null;
    return json({ token, existing: Boolean(existing), recovery });
  }

  if (action === 'set-password') {
    const pass = await verify(body.token);
    if (!pass || pass.t !== 'pw') return json({ error: 'This step has expired. Ask for a new code.' }, 400);
    const pending = await store.get(`pending/${pass.ek}`, { type: 'json' });
    if (!pending || pending.nonce !== pass.n || pending.expiresAt < Date.now()) {
      return json({ error: 'This step has expired. Ask for a new code.' }, 400);
    }
    if (!validAuth(body.auth)) return json({ error: 'Update ScrapSheet (reload the page) and try again.' }, 400);
    const existing = await store.get(`users/${pass.ek}`, { type: 'json' });
    if (existing?.disabledAt) return json({ error: DEACTIVATED }, 403);
    if (!existing && !(await readSettings()).signupsOpen) return json({ error: 'New sign-ups are paused right now. Please try again later.' }, 403);
    // What the master key will be locked with: a whole new keyring (new
    // account, starting over, or an account from before encryption), or, after
    // the recovery key opened the old one, the same key locked for the new password.
    let keyring;
    if (existing?.keyring && !body.startOver) {
      if (!b64ish(body.byPassword)) return json({ error: 'Enter your recovery key first.' }, 400);
      keyring = { ...existing.keyring, byPassword: body.byPassword };
    } else {
      if (!validKeyring(body.keyring)) return json({ error: 'Update ScrapSheet (reload the page) and try again.' }, 400);
      keyring = cleanKeyring(body.keyring);
    }
    await store.delete(`pending/${pass.ek}`);

    const { hash, salt } = await hashPassword(body.auth);
    let user;
    if (existing) {
      // Starting over: nothing in the old account can be opened without its
      // keys, so it is erased first.
      if (body.startOver) await deleteAccountData(existing.ns);
      // A reset signs out every other device.
      user = { ...existing, hash, salt, authV: 2, keyring, version: existing.version + 1 };
      // Starting over leaves nothing to lock. Otherwise an account from before
      // encryption keeps no migratedAt until this device has locked its data.
      if (body.startOver) Object.assign(user, { migratedAt: Date.now(), typesSealedAt: Date.now() });
    } else {
      const uid = randomBytes(8).toString('hex');
      // New accounts start on Free (NEW_ACCOUNT_PLAN=pro is for local testing only).
      user = { uid, ns: uid, email: pass.email, hash, salt, authV: 2, keyring, migratedAt: Date.now(), typesSealedAt: Date.now(), version: 1, createdAt: Date.now(), plan: env('NEW_ACCOUNT_PLAN') === 'pro' ? 'pro' : 'free' };
    }
    user = withSignIn(user);
    await store.setJSON(`users/${pass.ek}`, user);
    if (existing) {
      await notifySync(user.ns, 'session', String(Date.now()));
      await securityNotice(req, user.email, body.startOver ? 'start-over' : 'password');
    }
    return signedIn(user, { created: !existing });
  }

  if (action === 'login') {
    const ek = emailKey(email);
    if (!(await allow(`login-${ek}`, 10, 15 * 60 * 1000))) {
      return json({ error: 'Too many tries. Wait 15 minutes, or reset your password with a code.' }, 429);
    }
    const user = validEmail(email) ? await store.get(`users/${ek}`, { type: 'json' }) : null;
    // Not upgraded yet (or no such account, so nothing is given away): ask the
    // page to send the plain password once.
    if ((!user || user.authV !== 2) && !body.password) return json({ legacy: true }, 409);
    const checked = user ? await checkSecret(user, body) : null;
    if (!checked) return json({ error: 'Wrong email or password.' }, 401);
    if (checked.disabledAt) return json({ error: DEACTIVATED }, 403);
    const updated = withSignIn(checked);
    await store.setJSON(`users/${ek}`, updated);
    return signedIn(updated);
  }

  return json({ error: 'Unknown action' }, 400);
});
