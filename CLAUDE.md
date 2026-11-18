# ScrapSheet (formerly Scratch Pad)

A shared scratch pad (sheets of text, images and files) hosted on Netlify
at https://scrap.sector809labs.com (Netlify site `scrapsheet`; DNS is a
DNS-only CNAME in Cloudflare). https://scrapsheet.netlify.app must keep working
too (some networks block new domains): never redirect it to the new one. The two
are separate sites to the browser (own sign-in, own kept keys), and share links
use whichever address they were made on.
The app is called ScrapSheet everywhere people see it. Internal names keep
"scratchpad" (repo, stores, keys, the `scratchpad-e2ee-v1` salt): never rename
those, the salt least of all (it would lock every account out).
Pushes to `main` deploy straight to the live site.

## Roadmap

1. Web app: get it fully running (Stripe live mode next).
2. Android app, built from this web app as a Trusted Web Activity with
   Bubblewrap (package `com.sector809labs.scrapsheet`, decided: it can never
   change). TWA, not Capacitor, because Play Billing uses Chrome's Digital
   Goods API and Share to ScrapSheet uses the manifest's share_target, both
   TWA-only (see `docs/android.md`). The app itself is
   `android/twa-manifest.json` (Bubblewrap 1.27+, target API 36, min API 24);
   the generated project and the signing key are never committed.
3. iOS app, after the Android launch, with Capacitor (WKWebView, StoreKit for
   in-app purchase).

Keep the web app ready to be wrapped: everything works in a WebView, the
manifest and icons stay complete, no browser-only shortcuts that an app shell
can't offer. Store billing rules (Google Play Billing, Apple in-app purchase)
may require their own billing beside Stripe for Pro bought in the app: check
the current policies before building the Android app. `docs/android.md` has the
researched rules (Nov 2026), the Play Console checklist and Bubblewrap steps;
`docs/play-console-answers.md` the Data safety and rating answers (keep them true
to what the app collects); `branding/play-store/` the listing kit.

## Rules

- Never touch the `ojpad` Netlify site (a coworker's copy) unless explicitly asked.

- Always ask before merging into `main`, every time. Approval for one merge
  does not carry over to the next.
- Work on a branch, test, push the branch, then ask.

## Layout

- `public/` is the static site (`index.html`, `app.js`, `styles.css`).
- `netlify/functions/` holds the API, backed by Netlify Blobs:
  - `auth.mjs`: accounts (emailed animal+4-digit code, then a password),
    one-year session cookie renewed on each visit
  - `state.mjs`: sheet list (starts at 5, up to 10 per account), sheet text/html, current sheet,
    and every sheet at once (`meta=all`) so the page can switch tabs instantly
  - `admin-api.mjs`: the admin dashboard's API (see "Admin dashboard" below)
  - `files.mjs`: per-sheet file uploads in chunks (up to 100 MB): 4 MB on
    Netlify, 1 MB in R2 (`record.chunkSize`; a piece cut off on a slow phone
    connection loses less),
    plus a small thumbnail for images (made in the browser, `thumb=1`).
    With `FILES_R2=1` (and `SYNC_URL`), new uploads' chunks live in Cloudflare
    R2 (`netlify/lib/r2.mjs`, record `store: 'r2'`): the page PUTs each piece
    to the relay (`/files/up`) with a pass Netlify signs with the sync key;
    `finish` checks sizes through the relay; chunk GETs (owner and share
    links, still counted per piece) 302 to the relay's `/files/get`, so
    downloads never pass through Netlify. Networks that block the relay
    (a workplace filter): a piece whose redirect fails is asked for again
    with `via=netlify` (Netlify fetches it from R2 and passes it on; the page
    keeps doing so for 30 minutes, `fetchPiece()` in `app.js` and `share.js`);
    uploads go to R2 only while live sync is connected (`relayUsable()`), else
    to Netlify; and saves then send `notify: 1` so the server tells the other
    devices. Older files stay in Blobs. Deleting
    a file for good, or wiping a sheet slot, clears its R2 objects. The relay
    never overwrites a stored piece.
  - `images.mjs`: images in the text (chunked original plus a display copy)
  - `share.mjs`: share links. A file, or a sheet with its text, images and
    files, for anyone with `/s/<token>` (viewer: `public/share.html`/`share.js`)
    until it expires (1, 7 or 30 days) or is turned off. One link per file or
    sheet; a link stops working if what it shares is deleted. Links live in the
    `scratchpad-shares` store; each account lists its tokens in `meta/shares`.
    Downloads are capped per link per hour (about 2.4 GB, counted by piece size). Viewer pages are noindex/no-referrer.
- Storage: `netlify/lib/usage.mjs` sums an account's text, files and images.
  Default limit 5 GB per account (`quotaBytes` on the account: -1 = none),
  enforced when an upload starts; an admin can change it from the admin
  dashboard. Files show their age; ones over 30 days (not "Kept")
  prompt a gentle "still need them?" card. Nothing is deleted automatically.
- Plans (`netlify/lib/plans.mjs`): Free (1 sheet, 1 file, files up to 10 MB,
  10 MB storage, no share links) and Pro (10 sheets, 5 GB, 100 MB files, share
  links). New accounts get `plan: 'free'`; accounts from before plans have no
  `plan` and stay Pro. Every account follows its plan. Limits apply to adding
  things (`needsPro` → 403 `{ upgrade: true }`, the page shows its upgrade
  card). Admins can switch an account's plan from the admin dashboard.
- Billing is Stripe with Managed Payments (Stripe is merchant of record: tax,
  fraud, disputes). Sandbox account "Sector 809 Labs LLC sandbox"
  (acct_1UcXIzE4JMAT8oxx); never touch the FinestIQ account. Product
  "ScrapSheet Pro" (tax code txcd_10103000) with prices found by lookup key
  `scrapsheet_pro_month` ($0.99) and `scrapsheet_pro_year` ($9.99), tax
  inclusive. `billing.mjs`: Checkout (subscription, managed_payments) and the
  customer portal (default config: card, invoices, switch monthly/yearly,
  cancel at period end). `stripe-webhook.mjs` checks the signature, re-reads
  the subscription and sets `plan` + `user.stripe` (active/trialing/past_due
  keep Pro). REST via fetch, API version 2026-04-22.dahlia. Env:
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; `NEW_ACCOUNT_PLAN=pro` is for
  local tests only.
- Google Play Billing (Pro bought in the Android app; `netlify/lib/play.mjs`,
  `netlify/functions/play.mjs`, `docs/android.md`): the app opens
  `/?source=twa` (remembered per session in `sessionStorage`, never
  `localStorage`: the app shares Chrome's storage). There Upgrade uses the
  Digital Goods API + Payment Request with products `scrapsheet_pro_month` /
  `scrapsheet_pro_year`; the token goes to `play?action=verify`, which reads
  `subscriptionsv2` from Google, acknowledges, links the token (hashed,
  `play-tokens/…` in the auth store) and sets `plan` + `user.play`. Google's
  notices (Pub/Sub push to `play?action=rtdn&key=PLAY_RTDN_SECRET`) only
  trigger a fresh read. Pro holds while either Stripe or Play pays
  (`stripeKeepsPro` / `playKeepsPro` in plans.mjs); `planInfo().billing.source`
  says which. Manage billing for Play opens the Play Store. Delete account
  cancels a renewing Play subscription. Env: `PLAY_PACKAGE_NAME`,
  `PLAY_SERVICE_ACCOUNT` (JSON key, secret), `PLAY_RTDN_SECRET`.
- Download my data (Account & security, `downloadMyData()` in `app.js`): put
  together on the device, since only it can unlock anything. One .zip
  (`makeZip`, stored, Zip64 past 4 GB): README.txt, account.json, then a folder
  per sheet that holds anything (`NN Name/`) with the sheet as `.html` (images
  pointing at `images/`) and `.txt`, its pasted images (originals) and `files/`.
  Recently Deleted isn't included. Needs a connection.
- Delete account (account menu, `auth?action=delete-account`): needs the password
  as the sign-in secret. `deleteAccount()` in `netlify/lib/account.mjs` cancels
  a paying Stripe or Google Play subscription first (stops if that fails), then
  erases every sheet, file, image, share link and the account; other devices
  are signed out. Support can do the same for someone who can't sign in (asked
  from the account's email) from the admin dashboard (Accounts → Delete
  account…, email typed to confirm, audited, owner emailed). The public page
  `/delete-account` (`public/delete-account.html`, also Play's deletion URL)
  explains both; keep it true to what deletion does.
- Admin dashboard at `/admin` (`public/admin.html`/`admin.js`/`admin.css`,
  `netlify/functions/admin-api.mjs`, `netlify/lib/admin.mjs`). Admins are their
  own records in the `scratchpad-admin` store, never ScrapSheet accounts: email,
  scrypt password (12+ chars), TOTP authenticator (RFC 6238, replay-protected)
  and ten one-time recovery codes (hashed). Cookie `ss_admin` (12 h, HttpOnly,
  SameSite=Strict); `requireAdmin` checks origin, cookie, admin active and
  session version on every request. Admin rights never touch plans: Free/Pro
  come only from the account. The first admin enrolls with the
  `ADMIN_SETUP_TOKEN` env var (works once); more admins by one-time invite link.
  Tabs: Overview, Accounts (plan, storage limit, refresh from Stripe, sign out
  devices, deactivate/reactivate), Errors, Audit log, Admins, Settings
  (sign-ups open/closed, which services are set up). Every admin action and
  sign-in (also failed ones) goes to the audit log (`audit/…`). Admins never see
  content: only emails, plans, billing status, sizes, counts and activity.
- Deactivating an account (`disabledAt` on the user) keeps all its data: it bumps
  `version` (every session ends), stops sign-in, codes and password resets, and
  turns its share links off. `requireUser` and `/api/check` refuse it.
- Errors: every function is wrapped in `withErrors` (`netlify/lib/errors.mjs`):
  thrown errors and 5xx responses are kept 30 days in `scratchpad-admin`
  (`errors/…`): function, method, path, action, status, message. Never bodies,
  query values or cookies.
- New features support the standard user experience and the admin dashboard
  only: no special cases for particular accounts.
- Netlify functions take about 4.5 MB per request, so anything larger travels
  in chunks.
- Rate limits (`allow()` in `netlify/lib/auth.mjs`) keep counters under a sha256
  of their key (an email or IP address, never readable) and clear ones untouched
  for a day (`pruneRates`), so the privacy policy's "IP addresses, briefly" holds.
- `netlify/lib/auth.mjs` is shared: sessions, `requireUser`, and `userStore`,
  which keeps each account's data in its own stores (`u-<id>-…`). The account
  with `ns: ''` holds the original `scratchpad…` stores from before accounts
  existed (the retired legacy admin account, now deactivated; `OWNER_EMAIL` is
  no longer used). There are no account-specific exceptions in the code.
- Email goes through Resend: `RESEND_API_KEY` and `MAIL_FROM` env vars on Netlify.
  Locally, `SCRATCHPAD_DEV_MAIL=1` logs codes instead of sending them.
- Every email uses the one template in `netlify/lib/email.mjs` (`sendEmail`):
  a card on warm paper with the teal logo and "ScrapSheet", a divider, a
  heading, a short message, a tinted box for the key fact or code, a teal
  button, and the footer "Drop it here. Pull it up anywhere." / "ScrapSheet by
  Sector 809 Labs". New emails pass content only (heading, intro, box, button,
  note), never their own HTML; a plain-text part is made from the same content.
- Security notices (`securityNotice()` in `netlify/lib/notices.mjs`): one email when the
  password changes (reset), the account is started over, a new recovery key is
  made, every device is signed out, or the account is deleted (says if Pro was
  cancelled). Box: time (UTC) and the kind of device from the browser
  ("Safari on iPhone"), never stored. A notice that can't be sent never stops
  the action. New accounts and ordinary sign-ins send none.
- Saving while typing (`onEditorChanged()` in `app.js`): 1.5 s after typing
  stops, and at least every 5 s while it goes on (each save is a server call,
  and other devices fetch it); leaving the page or switching sheets saves at once.
- Sync is real-time: every write sets a change marker (`bumpRev`) and posts a
  signed notice to the relay (text saves use `bumpRevForDevice`: the server
  returns the signed notice and the device that saved posts it to the relay,
  so the save doesn't wait on it) in `sync-worker/` (a Cloudflare Worker with one
  Durable Object room per account, at `SYNC_URL`). Devices hold a WebSocket to
  their room and fetch only what changed. Netlify signs passes and notices with
  an Ed25519 key kept in Blobs; the Worker has only the public key (`PUBLIC_KEY`).
  `netlify/edge-functions/check.js` (`/api/check`) is the safety-net check: every
  5 minutes while live sync is connected, on return to the page, and every 2 s while the relay is unreachable.
  Without `SYNC_URL`, devices just use the 2-second check.
- Deploy the relay from `sync-worker/` with `npx wrangler deploy` (it binds the R2
  bucket `scrapsheet-files`: create it once with
  `npx wrangler r2 bucket create scrapsheet-files` before deploying).
- Stored html is sanitized on every load and save.
- UI: colors and sizes are tokens at the top of `public/styles.css`: dark in
  `:root`, light (warm paper, teal) in `:root[data-theme="light"]`. Use tokens,
  never raw colors. Hover styles go inside `@media (hover: hover)` (phones keep
  :hover stuck on whatever ends up under the finger). `public/theme.js` (loaded first in each page's head) sets
  `data-theme` from the account menu's Appearance choices (System/Light/Dark,
  kept in localStorage). Light is the default for everyone who hasn't chosen;
  System follows the device; tapping the logo and name
  (`#brandBtn`) flips light ⇄ dark. The logo has a teal `mark-light.png`. Sheet
  and file actions live in menus built by `openMenu()` in `app.js`
  (clear/delete always confirm in a bottom sheet).
- Profile menu (`#profileModal`, `openProfile()` in `app.js`): a popover on
  desktop, a bottom sheet under 700px. Main view: name (from the email, accounts
  have no separate name), email, Free/Pro badge with Upgrade or Manage billing,
  then Files & share links, Recently deleted, Account & security (Appearance
  System/Light/Dark, Generate new recovery key, Download my data, Sign out, Sign out of all devices, Delete
  account in red at the bottom) and Help & support (support, privacy, terms).
  Sub-views open in place with Back; Escape goes back, then closes.
- Files & share links (`#libraryModal`, `openLibrary()`): full screen on phones,
  a large dialog on desktop. Files tab: storage used vs the limit
  (`state?meta=usage`), a search, and every file across the sheets (fresh lists
  per sheet, names unlocked on the device) with type, size, sheet, Open sheet and
  the usual ••• file actions; table on desktop, compact list on phones. Shared
  links tab: active links with their file/sheet, status, Copy/Share and Turn off;
  ended ones only after "See inactive links", each with why it ended (share
  records keep `revokedReason`: you, replaced, admin, encryption; or expired). The green dot (server
  connection) sits in the editor toolbar beside the save state, which shows
  "Synced" only after the server confirms.
- Sign-in page (`#authScreen` in `index.html`) doubles as the front page:
  pitch, device row, Free/Pro plan cards, features and footer around the
  sign-in card, where every auth step (code, password, unlock, recovery) shows.
  Its own type is Montserrat served from `public/fonts/` (no Google
  requests) and its own `--auth-*` tokens (brighter cyan on dark, teal on
  light). `.only-wide` / `.only-narrow` swap copy at 860px; the sun/moon is
  `#authThemeBtn`. Help/Support go to support@sector809labs.com.
- Privacy policy and Terms of service: `public/privacy.html` and `public/terms.html`
  (served at `/privacy` and `/terms`, styled by `legal.css`; also in the account
  menu). Keep them true to what the app does: update them when data handling,
  providers, plans or prices change. Terms are governed by New York law.
- Branding lives in `branding/` (see its README): `app-icon.png` is the approved
  app icon; every installed or store icon (web app home screen/taskbar, Android,
  iOS) is made from it (`app-icon-full-bleed-1024.png`, maskable version for
  Android). `branding/kit/` is the full brand kit (logos, marks, social, email,
  print, guidelines). Tab favicons and the link-preview card come from the kit.
  Bump the `?v=` on icon links when icons change. The in-app logo
  (`mark-light.png` teal with mint fill, `mark.png` cyan for dark) is the kit's
  `mark-primary.svg` cropped tight to the drawing (256 px, transparent); also the
  email logo. `img[data-mark]` / `.brand-icon` nudge it up so its middle sits on
  the middle of the "ScrapSheet" capitals.
  The 3D app icon (`app-icon*.png`, `public/assets/apple-touch-icon.png`,
  `icon-192/512`, `icon-maskable-512`, `icon-source`) is ONLY the installed
  app's icon (home screen, taskbar, app stores): never use it inside the site,
  app, emails or link cards; those use the kit's flat marks and logos.
- Files can be swiped left to delete (touch only). The server delete waits
  5 s for Undo, and happens at once if the page is closed.
- Recently Deleted (`netlify/lib/files.mjs`, `state?meta=trash`): deleting a
  file marks it `deletedAt`; deleting a sheet moves it to `meta/trash` and keeps
  its slot (text, files, images) so nothing new lands on top of it. Both are
  deleted for good after 30 days (checked when lists are read) or from the
  Recently Deleted panel. They still count toward storage until then.
- End-to-end encryption (`public/crypto.js`, Web Crypto only): the password
  never leaves the device. PBKDF2 (600k, salted with the email) gives a sign-in
  secret (sent; the server keeps a scrypt hash, `authV: 2`) and a key that opens
  the account's master key. The keyring (`user.keyring`) holds the master key
  wrapped by the password and by a recovery key (shown once; "New recovery key…"
  in the account menu). Each sheet has a key (wrapped by the master key, on its
  entry) that locks its text, name and pasted images; each file has a key
  (wrapped by its sheet's key) that locks its name, type, chunks and thumbnail
  (pasted images' types are locked with the sheet key; older ones are locked
  once in the background, then the account gets `typesSealedAt`). The
  device keeps the master key unextractable in IndexedDB until sign-out; without
  it the page asks for the password ("Unlock"). Once an account has a keyring the
  server refuses anything unlocked. Share links carry the item's key after `#`.
  Password reset needs the recovery key, or "Start over" erases the account.
  Accounts from before: the first sign-in sends the password once, makes the
  keyring, and the page locks everything (text, images, files, Recently Deleted)
  and turns old share links off, then marks the account `migratedAt`.
  Server-side search, previews or recovery of content are impossible by design.
- Instant open (`paintFromSnapshot()` / `saveSnapshot()` in `app.js`): an
  encrypted copy of the tabs, kept sheet html (open sheet first, up to ~4 MB),
  file lists, tab status and plan is sealed with the device's master key and
  kept in the `scratchpad-keys` IndexedDB store (key `snapshot`), saved 1.5 s
  after changes and when the page is hidden. On open it's drawn before any
  request, read-only until the server is checked; `/auth` failing to connect
  retries (only a 401 signs out). A different account, a 401 or sign-out clears
  it with the keys. Without a copy, faint placeholder lines and tabs show.
- Offline = view only (`enterViewOnly()` / `blockedOffline()` in `app.js`): sync
  has no merge, so nothing is edited without the server. After 3 s without a
  connection (confirmed by one more `/api/check`; at once on the browser's
  `offline` event) the editor locks, the status reads "Offline · view only",
  uploads/new sheet/rename/delete/keep/share/restore and paste/drop say why and
  do nothing; viewing, search, copy stay. A save that can't reach the server
  counts as offline. While view only the 2-second check runs; when the server
  answers, words typed just before the drop are saved and editing unlocks.
  The notice "You’re offline. Reconnect to edit." shows once on going
  offline, then only when someone tries to type (a tap on the text or a key) or
  to change something.
  Guard new actions that change data with `if (blockedOffline()) return;`.
- Transfers already running (uploads, pasted images, downloads) don't fail when
  the page goes to the background or offline: `withRetry` waits (`whenActive`)
  without using up tries and carries on from the piece it was on (pieces already
  sent stay sent). A piece stuck after coming back restarts after 8 s, and
  one with no progress for 30 s in front, or when the browser goes offline, is
  sent again (`restartIfStuck`); an abort only counts as Cancel when the Cancel
  signal fired (phones abort transfers themselves on an app switch). Only a refusal from the server (4xx) or Cancel ends one.
  Upload rows say "Keep ScrapSheet open until uploads finish."; a page that is
  closed (or that the phone discards) still loses its upload.
- Share to ScrapSheet (installed app on Android): `share_target` in the
  manifest posts to `/share-target`; `public/sw.js` (the only service worker
  job: it caches nothing and passes every other request through) keeps the
  files and text in IndexedDB `scratchpad-share` and opens `/?shared=1`.
  `receiveShared()` (after `startApp`) offers them for the open sheet ("Add to
  <sheet>" / Discard): files go through `uploadFiles` (locked like any other),
  text is added at the end of the sheet. Kept while signed out or offline.
  Without the worker, netlify.toml sends `/share-target` home (303).
- Search runs on the device over the kept copies of every sheet and its file
  list (`state?meta=all` returns both), so typing makes no requests.
