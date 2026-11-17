# Android app: launch notes

Researched November 17, 2026. Store rules change often (Google's US rules are
still moving under the Epic v. Google settlement), so check the linked pages
again right before submitting.

## The short version

1. Package the web app as a **Trusted Web Activity (TWA)** with Bubblewrap.
   It's the same site in a full-screen Chrome view, so every change we ship to
   the web reaches the Android app at once, with no app update needed.
2. **Pro is bought through Google Play Billing inside the app** (built: see
   "Google Play Billing" below). It's the smoothest upgrade on Android: the
   payment method is already on the Google account, one tap and a fingerprint,
   managed in the Play Store with everything else. The web keeps Stripe. One
   account can be Pro through either; one ending never cancels the other.

## Billing rules (the part that decides the design)

- **Outside the US:** "Apps on Google Play that sell digital goods or
  subscriptions must use Google Play Billing." Pro is a digital subscription,
  so selling it in the app means Play Billing.
  ([Chrome: Play Billing in a TWA](https://developer.chrome.com/docs/android/trusted-web-activity/receive-payments-play-billing))
- **In the US:** since October 29, 2025, "Google will not require the use of
  Google Play Billing in apps distributed on the Google Play Store", and
  doesn't prohibit other in-app payment methods. There are alternative billing
  and external content links programs (launched December 9, 2025). Enrolled
  developers must report transactions and pay service fees starting
  October 1, 2026 (external links: downloads reportable until February 1,
  2027). Google's page doesn't state the fee amounts. A new Epic settlement
  (March 4, 2026) is waiting for the court to approve a revised injunction,
  so this can still change.
  ([Play Console Help: US policy update](https://support.google.com/googleplay/android-developer/answer/15582165?hl=en))
- **No purchase in the app at all** (people upgrade on the web) is allowed
  everywhere, as long as the app doesn't point people to buying elsewhere
  outside the programs above. That means the Android app should hide
  "Upgrade to Pro" and "Manage billing" and not mention prices.

### What that means for ScrapSheet

- Inside the Android app, Upgrade buys through Google Play (with Google's
  local prices), and Stripe checkout never shows. Manage billing opens the
  Play Store subscription. Someone who pays on the web is told to manage it
  on the web (no link out of the app).
- Google takes 15% of subscriptions, with no fixed fee per charge, which at
  $0.99 may well cost less than card fees.

## Technical requirements

- **Target Android 16 (API level 36)** for new apps and updates, required
  since August 31, 2026 (extension possible to November 1, 2026). Check
  Bubblewrap's template targets 36 before building.
  ([Play target API level](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en))
- **Digital Asset Links:** publish `public/.well-known/assetlinks.json`
  (served at `https://scrap.sector809labs.com/.well-known/assetlinks.json`)
  with the package name and the SHA-256 fingerprints of both the Play app
  signing key and the upload key. Chrome's parser is strict (no trailing
  commas). If verification fails, the app shows a browser bar instead of
  running full screen.
- **Address:** launch the app on `https://scrap.sector809labs.com`. The
  netlify.app address stays for networks that block new domains, but the app
  should use one origin (each address has its own sign-in and kept keys).
- **Already in place:** manifest with `id`, `scope`, icons (full-bleed and
  maskable from `branding/`), `share_target` (ScrapSheet in the Share menu),
  a service worker, real-time sync, instant open, offline view-only.
- **Tell the app it's the app:** set Bubblewrap's launch URL to
  `/?source=twa`, so the page buys through Google Play instead of Stripe.
- TWAs can't be used for apps aimed at children under 13.

## Play Console checklist

- Developer account under **Sector 809 Labs LLC** (organization accounts need
  a D-U-N-S number; check whether the 14-day closed-testing rule for new
  personal accounts applies).
- Store listing: name, short and full description, screenshots (phone and
  7"/10" tablet), feature graphic, icon from `branding/app-icon-full-bleed-1024.png`.
- **Privacy policy URL:** `https://scrap.sector809labs.com/privacy`.
- **Account deletion:** `https://scrap.sector809labs.com/delete-account`
  (`public/delete-account.html`): the in-app steps, what's deleted and kept,
  and email to support for people who can't sign in (support deletes it from
  the admin dashboard: Accounts → Delete account…).
- **Data safety form:** email address (account, security notices), purchase
  history (Stripe), app activity (sign-in times, for the admin view); content
  is end-to-end encrypted and not readable by us; data is encrypted in
  transit; people can delete their data.
- Content rating questionnaire, target audience (not under 13), app access
  instructions for review (a test account; it's Free unless set to Pro from
  the admin dashboard).

## Steps

1. `npm i -g @bubblewrap/cli`, then
   `bubblewrap init --manifest https://scrap.sector809labs.com/manifest.webmanifest`
   (package name e.g. `com.sector809labs.scrapsheet`; launch URL
   `/?source=twa`; keep the signing key safe: losing it means a new app).
2. `bubblewrap build`, upload the `.aab` to an internal testing track.
3. Copy the Play app signing SHA-256 from Play Console (App integrity) into
   `assetlinks.json`, deploy, check with
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://scrap.sector809labs.com&relation=delegate_permission/common.handle_all_urls`.
4. On a phone from the testing track: full screen (no browser bar), sign in,
   share a photo from Gallery into ScrapSheet, upload, offline, dark mode.
5. Production release once the listing, data safety and deletion page are done.

## Google Play Billing (built)

How it works:

- The app opens `/?source=twa`; the page remembers it for that session only
  (the app shares Chrome's storage with the browser, so it must not stick).
- **Buying:** the page gets Google Play's prices with the Digital Goods API
  (`getDigitalGoodsService('https://play.google.com/billing')`), buys with
  Payment Request (`sku` = the product id), then sends the purchase token to
  `/.netlify/functions/play?action=verify`.
- **The server** (`netlify/functions/play.mjs`, `netlify/lib/play.mjs`) reads
  the subscription from the Google Play Developer API (`subscriptionsv2`),
  checks it's ScrapSheet Pro, refuses a purchase already linked to another
  account, **acknowledges** it (Google refunds anything not acknowledged within
  3 days), links the token (hashed) to the account and sets the plan. The page
  never decides Pro.
- **Google's notices** (Real-time developer notifications through Cloud
  Pub/Sub, pushed to `?action=rtdn&key=…`) trigger a fresh read: renewals,
  cancellations (Pro stays until the paid time ends), grace period, account
  hold (back to Free, nothing deleted), recovery, restore, expiry, refunds.
- **New install:** the page checks the purchases this Google account owns and
  links any not yet on the account.
- **Pending payments** say so and stay Free until Google confirms.
- **Delete account** cancels a renewing Play subscription first.
- The admin dashboard shows Play billing (never the purchase token) and can
  refresh it from Google.

Setup (once the app exists in Play Console):

1. **Products:** Play Console → Monetize → Products → Subscriptions. Create
   `scrapsheet_pro_month` (one auto-renewing monthly base plan, US $0.99) and
   `scrapsheet_pro_year` (one yearly base plan, US $9.99); set the other
   countries' prices; activate both. The ids must match exactly.
2. **Server access:** in Google Cloud, a project with the *Google Play Android
   Developer API* enabled, a service account, and a JSON key for it. In Play
   Console → Users and permissions, invite the service account's email with
   *View financial data* and *Manage orders and subscriptions*.
3. **Netlify environment variables** (site `scrapsheet`; the JSON key is a
   secret, entered only in Netlify's settings):
   - `PLAY_PACKAGE_NAME` = the app's package (e.g. `com.sector809labs.scrapsheet`)
   - `PLAY_SERVICE_ACCOUNT` = the whole JSON key
   - `PLAY_RTDN_SECRET` = a long random string
4. **Notices:** Cloud Pub/Sub topic (e.g. `scrapsheet-play`); give
   `google-play-developer-notifications@system.gserviceaccount.com` the
   *Pub/Sub Publisher* role on it; add a **push** subscription to
   `https://scrap.sector809labs.com/.netlify/functions/play?action=rtdn&key=<PLAY_RTDN_SECRET>`.
   In Play Console → Monetize → Monetization setup, enter the topic and send a
   test notification. The admin dashboard's Settings shows both as set.
5. **Bubblewrap:** in `twa-manifest.json`, `"features": { "playBilling": { "enabled": true } }`,
   and the launch URL `/?source=twa`; then `bubblewrap update` and `build`.
6. **Test:** add license testers in Play Console (test purchases are free and
   renew quickly), install from the internal testing track, buy, cancel in the
   Play Store, check the account follows.

## Before building

- Choose the package name (it can never change).
