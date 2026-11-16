import { emailKey, json, requireUser, sameOrigin } from '../lib/auth.mjs';
import { planOf } from '../lib/plans.mjs';
import { ensureCustomer, priceFor, stripe, stripeReady } from '../lib/stripe.mjs';

// Paying for Pro, on Stripe's own pages (card details never reach ScrapSheet).
//   POST ?action=checkout { interval: 'month' | 'year' }  → { url } of a Stripe Checkout page
//   POST ?action=portal                                  → { url } of the Stripe billing page
// Whether the account is Pro is set by the webhook (stripe-webhook.mjs), not here.

export default async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(req)) return json({ error: 'Bad origin' }, 403);
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  if (!stripeReady()) return json({ error: 'Payments aren’t set up yet. Try again soon.' }, 503);

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const body = await req.json().catch(() => ({}));
  const origin = url.origin;

  try {
    if (action === 'checkout') {
      if (planOf(auth.user) === 'pro') return json({ error: 'You’re already on Pro.' }, 409);
      const interval = body.interval === 'year' ? 'year' : 'month';
      const price = await priceFor(interval);
      if (!price) return json({ error: 'Payments aren’t set up yet. Try again soon.' }, 503);
      const user = await ensureCustomer(auth.user);
      const ek = emailKey(user.email);
      const session = await stripe('POST', 'checkout/sessions', {
        mode: 'subscription',
        customer: user.stripe.customer,
        client_reference_id: ek,
        line_items: [{ price: price.id, quantity: 1 }],
        subscription_data: { metadata: { ek } },
        allow_promotion_codes: 'true',
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancelled`
      });
      return json({ url: session.url });
    }

    if (action === 'portal') {
      if (!auth.user.stripe?.customer) return json({ error: 'There’s no billing on this account yet.' }, 404);
      const session = await stripe('POST', 'billing_portal/sessions', { customer: auth.user.stripe.customer, return_url: `${origin}/` });
      return json({ url: session.url });
    }
  } catch (err) {
    console.error('Stripe', err.status, err.message);
    return json({ error: 'Payments aren’t available right now. Try again in a minute.' }, 502);
  }

  return json({ error: 'Unknown action' }, 400);
};
