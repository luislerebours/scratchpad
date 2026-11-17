import { createHmac, timingSafeEqual } from 'node:crypto';
import { authStore, emailKey, env } from './auth.mjs';
import { playKeepsPro } from './plans.mjs';

// Stripe, through its REST API (no SDK). Keys live in Netlify's environment:
//   STRIPE_SECRET_KEY      sk_test_… or sk_live_…
//   STRIPE_WEBHOOK_SECRET  whsec_… for /.netlify/functions/stripe-webhook
// Prices are found by lookup key, so the code never holds price ids. The
// product ("ScrapSheet Pro") carries the SaaS tax code Managed Payments needs.
export const LOOKUP_KEYS = { month: 'scrapsheet_pro_month', year: 'scrapsheet_pro_year' };

export const stripeReady = () => Boolean(env('STRIPE_SECRET_KEY'));

// Stripe takes form-encoded bodies with bracketed keys: a[b][0]=c.
function encode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((v, i) => (typeof v === 'object' ? encode(v, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(v))));
    else if (typeof value === 'object') encode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export async function stripe(method, path, params) {
  const query = method === 'GET' && params ? `?${encode(params)}` : '';
  const r = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      // Managed Payments needs 2025-03-31.basil or later; on this version a
      // subscription's period dates live on its items.
      'Stripe-Version': '2026-04-22.dahlia',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
    },
    body: method === 'GET' ? undefined : encode(params)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `Stripe ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function priceFor(interval) {
  const key = LOOKUP_KEYS[interval];
  if (!key) return null;
  const { data } = await stripe('GET', 'prices', { lookup_keys: [key], active: 'true', limit: 1 });
  return data?.[0] || null;
}

// ---- Webhook signatures: "t=…,v1=…", HMAC-SHA256 of `${t}.${body}` ----

export function verifySignature(payload, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest();
  const given = header.split(',').filter(p => p.startsWith('v1=')).map(p => Buffer.from(p.slice(3), 'hex'));
  return given.some(sig => sig.length === expected.length && timingSafeEqual(sig, expected));
}

// ---- Accounts ↔ Stripe customers ----

export const customerKey = id => `stripe-customers/${id}`;

// The account's Stripe customer, made on first use.
export async function ensureCustomer(user) {
  if (user.stripe?.customer) return user;
  const ek = emailKey(user.email);
  const customer = await stripe('POST', 'customers', { email: user.email, metadata: { ek } });
  const store = authStore();
  const latest = (await store.get(`users/${ek}`, { type: 'json' })) || user;
  const updated = { ...latest, stripe: { ...(latest.stripe || {}), customer: customer.id } };
  await store.setJSON(`users/${ek}`, updated);
  await store.set(customerKey(customer.id), ek);
  return updated;
}

// Subscription states that keep Pro: paid up, in a trial, or a payment being retried.
const KEEPS_PRO = new Set(['active', 'trialing', 'past_due']);

// Records a subscription on its account and sets the plan to match.
export async function applySubscription(sub) {
  const store = authStore();
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const ek = sub.metadata?.ek || (customer && (await store.get(customerKey(customer))));
  if (!ek) return null;
  const user = await store.get(`users/${ek}`, { type: 'json' });
  if (!user) return null;
  // Another subscription already keeps this account on Pro: a different one ending changes nothing.
  if (user.stripe?.subscription && user.stripe.subscription !== sub.id && KEEPS_PRO.has(user.stripe.status) && !KEEPS_PRO.has(sub.status)) return user;
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end || item?.current_period_end;
  const updated = {
    ...user,
    // A Google Play subscription that still pays keeps Pro, whatever Stripe says.
    plan: KEEPS_PRO.has(sub.status) || playKeepsPro(user.play) ? 'pro' : 'free',
    stripe: {
      ...(user.stripe || {}),
      customer: customer || user.stripe?.customer,
      subscription: sub.id,
      status: sub.status,
      interval: item?.price?.recurring?.interval || null,
      periodEnd: periodEnd ? periodEnd * 1000 : null,
      cancelAtEnd: Boolean(sub.cancel_at_period_end),
      updatedAt: Date.now()
    }
  };
  await store.setJSON(`users/${ek}`, updated);
  if (customer) await store.set(customerKey(customer), ek);
  return updated;
}
