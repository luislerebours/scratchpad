import { randomBytes } from 'node:crypto';
import {
  allow, authStore, checkPassword, clearedCookie, emailKey, env, hashCode, hashPassword, json,
  makeCode, normalizeCode, normalizeEmail, requireUser, sameOrigin, sessionCookie, sign, validEmail, verify
} from '../lib/auth.mjs';

// Accounts: email a code (an animal and four digits), check it, choose a
// password, then sign in with email and password. The same code steps reset
// a forgotten password.
const CODE_MS = 15 * 60 * 1000;
const SET_PASSWORD_MS = 30 * 60 * 1000;
const MAX_CODE_TRIES = 5;
const HOUR = 60 * 60 * 1000;

async function sendCodeEmail(to, code, link) {
  const key = env('RESEND_API_KEY');
  const from = env('MAIL_FROM');
  if (!key || !from) {
    if (env('SCRATCHPAD_DEV_MAIL') === '1') {
      console.log(`[dev mail] to ${to}: code ${code} link ${link}`);
      return;
    }
    throw new Error('Email is not set up (RESEND_API_KEY and MAIL_FROM)');
  }
  const text = `Your Scratch Pad code is ${code}\n\nOpen ${link} and enter the code. It works once and expires in 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#111">
<p>Your Scratch Pad code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:.04em;margin:8px 0 16px">${code}</p>
<p><a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#2cc7ff;color:#06101e;font-weight:700;text-decoration:none">Open Scratch Pad</a></p>
<p style="color:#555;font-size:14px">Enter the code there. It works once and expires in 15 minutes. If you didn't ask for this, you can ignore this email.</p>
</div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: `Your Scratch Pad code: ${code}`, text, html })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function signedIn(user, body = {}) {
  return json({ email: user.email, ...body }, 200, { 'Set-Cookie': await sessionCookie(user) });
}

export default async (req, context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const store = authStore();

  // Who is signed in. Each visit renews the one-year cookie.
  if (req.method === 'GET') {
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    return signedIn(auth.user);
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
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  }

  const email = normalizeEmail(body.email);

  if (action === 'request-code') {
    if (!validEmail(email)) return json({ error: 'Enter a valid email address' }, 400);
    const ek = emailKey(email);
    const ip = context?.ip || 'unknown';
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
    // A single-use pass to choose a password in the next step.
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + SET_PASSWORD_MS;
    await store.setJSON(`pending/${ek}`, { nonce, expiresAt });
    const token = await sign({ t: 'pw', ek, email, n: nonce, exp: expiresAt });
    const existing = await store.get(`users/${ek}`, { type: 'json' });
    return json({ token, existing: Boolean(existing) });
  }

  if (action === 'set-password') {
    const pass = await verify(body.token);
    if (!pass || pass.t !== 'pw') return json({ error: 'This step has expired. Ask for a new code.' }, 400);
    const pending = await store.get(`pending/${pass.ek}`, { type: 'json' });
    if (!pending || pending.nonce !== pass.n || pending.expiresAt < Date.now()) {
      return json({ error: 'This step has expired. Ask for a new code.' }, 400);
    }
    const password = String(body.password || '');
    if (password.length < 8) return json({ error: 'Use at least 8 characters.' }, 400);
    if (password.length > 200) return json({ error: 'That password is too long.' }, 400);
    await store.delete(`pending/${pass.ek}`);

    const { hash, salt } = await hashPassword(password);
    const existing = await store.get(`users/${pass.ek}`, { type: 'json' });
    let user;
    if (existing) {
      // A reset signs out every other device.
      user = { ...existing, hash, salt, version: existing.version + 1 };
    } else {
      const uid = randomBytes(8).toString('hex');
      let ns = uid;
      const owner = normalizeEmail(env('OWNER_EMAIL'));
      if (owner && owner === pass.email) {
        const { modified } = await store.set('legacy-owner', pass.ek, { onlyIfNew: true });
        if (modified) ns = '';
      }
      user = { uid, ns, email: pass.email, hash, salt, version: 1, createdAt: Date.now() };
    }
    await store.setJSON(`users/${pass.ek}`, user);
    return signedIn(user, { created: !existing });
  }

  if (action === 'login') {
    const ek = emailKey(email);
    const password = String(body.password || '');
    if (!(await allow(`login-${ek}`, 10, 15 * 60 * 1000))) {
      return json({ error: 'Too many tries. Wait 15 minutes, or reset your password with a code.' }, 429);
    }
    const user = validEmail(email) ? await store.get(`users/${ek}`, { type: 'json' }) : null;
    if (!user || !(await checkPassword(password, user))) {
      return json({ error: 'Wrong email or password.' }, 401);
    }
    return signedIn(user);
  }

  return json({ error: 'Unknown action' }, 400);
};
