import { env, json } from '../lib/auth.mjs';
import { applySubscription, stripe, verifySignature } from '../lib/stripe.mjs';
import { withErrors } from '../lib/errors.mjs';

// Stripe tells ScrapSheet when a subscription starts, changes or ends. Each
// notice is checked against STRIPE_WEBHOOK_SECRET, then the subscription is
// read fresh from Stripe (so notices arriving out of order can't undo each
// other) and the account's plan set to match.
//
// In the Stripe dashboard: Developers → Webhooks → endpoint
//   https://scrap.sector809labs.com/.netlify/functions/stripe-webhook
// with these events: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted.

export default withErrors('stripe-webhook', async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const payload = await req.text();
  if (!verifySignature(payload, req.headers.get('stripe-signature'), env('STRIPE_WEBHOOK_SECRET'))) {
    return json({ error: 'Bad signature' }, 400);
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: 'Bad payload' }, 400);
  }

  const object = event?.data?.object || {};
  let subscriptionId = null;
  if (event.type === 'checkout.session.completed' && object.mode === 'subscription') subscriptionId = object.subscription;
  if (event.type?.startsWith('customer.subscription.')) subscriptionId = object.id;
  if (!subscriptionId) return json({ received: true, ignored: event.type });

  try {
    const sub = await stripe('GET', `subscriptions/${subscriptionId}`);
    const user = await applySubscription(sub);
    return json({ received: true, plan: user?.plan || null });
  } catch (err) {
    console.error('Stripe webhook', event.type, err.status, err.message);
    // A 500 makes Stripe try again later.
    return json({ error: 'Couldn’t update the account' }, 500);
  }
});
