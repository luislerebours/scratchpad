# Android app: launch notes

Researched November 17, 2026. Store rules change often (Google's US rules are
still moving under the Epic v. Google settlement), so check the linked pages
again right before submitting.

## The short version

1. Package the web app as a **Trusted Web Activity (TWA)** with Bubblewrap.
   It's the same site in a full-screen Chrome view, so every change we ship to
   the web reaches the Android app at once, with no app update needed.
2. Launch with **no purchase button inside the Android app** ("reader" style):
   people sign in to the account they already have, and Pro bought on the web
   works in the app. This is the safe path everywhere.
3. Then decide on in-app Pro:
   - **Google Play Billing** in the TWA (Digital Goods API) works worldwide.
     It's real work: a second billing system next to Stripe, kept in step by
     our server.
   - **US only:** Google currently allows other billing and links to the web
     (see below), so a US-only "Upgrade on the web" link is possible, but its
     fees and rules are still being settled in court.

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

- Free is small (1 sheet, 1 file, 10 MB). Android users who can't upgrade in
  the app will notice, so Play Billing is probably worth adding soon after
  launch.
- If we add Play Billing, the account keeps one `plan`; the server verifies
  Play purchases (Google Play Developer API) the way the webhook verifies
  Stripe today, and records `user.play` beside `user.stripe`. Someone who pays
  in one place must not be offered the other; cancelling is done where they
  paid.
- Purchases must be acknowledged within 3 days or Google refunds them.

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
  `/?source=twa` so the page can hide purchase buttons (and later switch to
  Play Billing) without guessing.
- TWAs can't be used for apps aimed at children under 13.

## Play Console checklist

- Developer account under **Sector 809 Labs LLC** (organization accounts need
  a D-U-N-S number; check whether the 14-day closed-testing rule for new
  personal accounts applies).
- Store listing: name, short and full description, screenshots (phone and
  7"/10" tablet), feature graphic, icon from `branding/app-icon-full-bleed-1024.png`.
- **Privacy policy URL:** `https://scrap.sector809labs.com/privacy`.
- **Account deletion:** Play requires a web link where people can ask to
  delete their account and data, besides the in-app option. Point it to a
  short page explaining Account menu → Account & security → Delete account,
  with support@sector809labs.com for people who can't sign in.
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

## Before building

- Hide Upgrade / Manage billing / prices when launched with `?source=twa`.
- Add the account-deletion web page.
- Decide: reader-only at launch, or Play Billing from day one.
