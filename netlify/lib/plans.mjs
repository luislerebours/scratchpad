import { env, json } from './auth.mjs';

// Free and Pro. Accounts made before plans existed have no `plan` and stay
// Pro; new accounts start on Free. Paying through Stripe (web) or Google Play
// (Android app) sets `plan: 'pro'`, and a subscription ending sets it back to
// 'free' unless the other one still pays. Every account follows its
// plan: admin rights live in the admin dashboard and never change it. Limits apply to adding things: an account that drops to
// Free keeps everything it has, but can't add past Free's limits.

const MB = 1024 ** 2;

export const PLANS = {
  free: { name: 'Free', sheets: 1, files: 1, fileBytes: 10 * MB, quotaBytes: 10 * MB, share: false },
  pro: { name: 'Pro', sheets: 10, files: Infinity, fileBytes: 100 * MB, quotaBytes: 5 * 1024 * MB, share: true }
};

// What Pro costs, for the page (Stripe holds the real prices).
export const PRICES = { month: 0.99, year: 9.99 };

// Stripe subscription states that keep Pro: paid up, in a trial, or a payment being retried.
const STRIPE_KEEPS = new Set(['active', 'trialing', 'past_due']);
export const stripeKeepsPro = stripe => STRIPE_KEEPS.has(stripe?.status);

// Google Play: paid up, in a grace period, or cancelled but not yet run out.
export function playKeepsPro(play) {
  if (!play) return false;
  if (play.state === 'SUBSCRIPTION_STATE_ACTIVE' || play.state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') return true;
  return play.state === 'SUBSCRIPTION_STATE_CANCELED' && Number(play.expiresAt) > Date.now();
}

// Complimentary Pro: an admin gave this account Pro (`user.comp` { at, by }).
// It keeps Pro whatever billing says, until an admin changes the plan.
export const compKeepsPro = user => Boolean(user?.comp);

export function planOf(user) {
  return user?.plan === 'free' ? 'free' : 'pro';
}

export const limitsFor = user => PLANS[planOf(user)];

// What the page needs to know about the plan and billing.
export function planInfo(user) {
  const plan = planOf(user);
  const { name, sheets, files, fileBytes, quotaBytes, share } = PLANS[plan];
  // Where Pro is paid for: Google Play (bought in the Android app) when that's
  // what pays, otherwise Stripe (the web).
  const play = user?.play;
  const usePlay = play && (playKeepsPro(play) || !user?.stripe?.customer);
  const billing = usePlay ? {
    source: 'play',
    interval: play.interval || null,
    status: play.state || null,
    renewsAt: play.expiresAt || null,
    cancelsAtEnd: !play.autoRenew,
    productId: play.productId || null,
    packageName: env('PLAY_PACKAGE_NAME') || null
  } : user?.stripe?.customer ? {
    source: 'stripe',
    interval: user.stripe.interval || null,
    status: user.stripe.status || null,
    renewsAt: user.stripe.periodEnd || null,
    cancelsAtEnd: Boolean(user.stripe.cancelAtEnd)
  } : null;
  // Pro that nothing pays for: given by an admin.
  const complimentary = plan === 'pro' && compKeepsPro(user) && !stripeKeepsPro(user.stripe) && !playKeepsPro(user.play);
  return { plan, name, sheets, files: Number.isFinite(files) ? files : null, fileBytes, quotaBytes, share, billing, complimentary, prices: PRICES };
}

// A Pro feature or limit was hit: the page shows its upgrade card.
export const needsPro = error => json({ error, upgrade: true }, 403);
