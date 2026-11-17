import { allow, emailKey, env, json, requireUser, sameOrigin } from '../lib/auth.mjs';
import { planInfo } from '../lib/plans.mjs';
import { accountForToken, acknowledgeIfNeeded, applyPlay, getSubscription, isProSubscription, linkToken, playReady, rtdnKeyOk } from '../lib/play.mjs';
import { withErrors } from '../lib/errors.mjs';

// Google Play Billing (Pro bought in the Android app).
//   POST ?action=verify { token }   the page, right after a purchase (or when it
//                                   finds one not yet on the account): checked
//                                   with Google, acknowledged, linked to the
//                                   signed-in account → { plan }
//   POST ?action=rtdn&key=…         Google's real-time notices (Cloud Pub/Sub
//                                   push): renewals, cancellations, holds,
//                                   refunds. The subscription is always read
//                                   fresh from Google, so a notice only says
//                                   "look again".
// Whether the account is Pro comes only from what Google says, never from the page.

const MAX_TOKEN = 2048;
const validToken = t => typeof t === 'string' && t.length > 10 && t.length <= MAX_TOKEN && /^[A-Za-z0-9._:\-]+$/.test(t);

export default withErrors('play', async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'rtdn') {
    if (!rtdnKeyOk(url.searchParams.get('key'))) return json({ error: 'Forbidden' }, 403);
    const push = await req.json().catch(() => null);
    let note = null;
    try {
      note = JSON.parse(Buffer.from(push?.message?.data || '', 'base64').toString('utf8'));
    } catch {
      // Not a notice we can read: nothing to do (and no point retrying).
    }
    if (!note || note.packageName !== env('PLAY_PACKAGE_NAME')) return json({ received: true, ignored: 'not ours' });
    if (note.testNotification) return json({ received: true, test: true });
    const token = note.subscriptionNotification?.purchaseToken || (note.voidedPurchaseNotification?.productType === 1 ? note.voidedPurchaseNotification.purchaseToken : null);
    if (!token || !validToken(token)) return json({ received: true, ignored: 'no subscription' });
    if (!playReady()) return json({ error: 'Google Play isn’t set up' }, 503);
    try {
      const sub = await getSubscription(token);
      const ek = await accountForToken(token, sub);
      // Not linked yet: the page links it when it checks in (verify).
      if (!ek) return json({ received: true, unknown: true });
      await acknowledgeIfNeeded(token, sub);
      const user = await applyPlay(ek, token, sub);
      return json({ received: true, plan: user?.plan || null });
    } catch (err) {
      console.error('Play notice', err.status, err.message);
      // A 500 makes Pub/Sub try again later.
      return json({ error: 'Couldn’t update the account' }, 500);
    }
  }

  if (action === 'verify') {
    if (!sameOrigin(req)) return json({ error: 'Bad origin' }, 403);
    const auth = await requireUser(req);
    if (auth.error) return auth.error;
    if (!playReady()) return json({ error: 'Google Play purchases aren’t set up yet.' }, 503);
    const ek = emailKey(auth.user.email);
    if (!(await allow(`play-${ek}`, 30, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait a few minutes.' }, 429);
    const body = await req.json().catch(() => ({}));
    if (!validToken(body.token)) return json({ error: 'Bad purchase' }, 400);
    let sub;
    try {
      sub = await getSubscription(body.token);
    } catch (err) {
      if (err.status === 400 || err.status === 404 || err.status === 410) return json({ error: 'Google Play doesn’t recognize that purchase.' }, 400);
      console.error('Play verify', err.status, err.message);
      return json({ error: 'Couldn’t reach Google Play. Try again in a minute.' }, 502);
    }
    if (!isProSubscription(sub)) return json({ error: 'That isn’t a ScrapSheet Pro purchase.' }, 400);
    const owner = await accountForToken(body.token, sub);
    if (owner && owner !== ek) return json({ error: 'This Google Play subscription belongs to another ScrapSheet account. Sign in to that account to use it.' }, 409);
    if (sub.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') {
      await linkToken(body.token, ek);
      return json({ pending: true, plan: planInfo(auth.user) });
    }
    try {
      await acknowledgeIfNeeded(body.token, sub);
    } catch (err) {
      // Not fatal: the next check (or a notice) acknowledges it, within Google's 3 days.
      console.error('Play acknowledge', err.status, err.message);
    }
    const user = await applyPlay(ek, body.token, sub);
    return json({ plan: planInfo(user) });
  }

  return json({ error: 'Unknown action' }, 400);
});
