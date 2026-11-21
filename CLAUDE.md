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

## Subdomains of sector809labs.com: catch-all redirect

Cloudflare (zone `sector809labs.com`) sends every subdomain it doesn't know to a
"this address doesn't exist" page, https://sector809labs.com/unknown-subdomain, which
then goes on to the home page:

- DNS: `AAAA *` → `100::`, proxied.
- Rules › Redirect Rules › **Unknown subdomains**: a 302 for every host that is *not*
  in its list. The list today: `sector809labs.com`, `www`, `scrap`, `sync`, `rsend` and
  `send` (each `.sector809labs.com`).

**Adding a subdomain of sector809labs.com** (a DNS record, a Worker custom domain or
route, a Pages or R2 custom domain, a Netlify site, anything): add its full hostname to
that list as well (Cloudflare › sector809labs.com › Rules › Redirect Rules › Unknown
subdomains › Edit, then Deploy). A proxied (orange-cloud) name that isn't on the list is
redirected to the "doesn't exist" page instead of reaching its app, and Worker and Pages
custom domains are always proxied. DNS-only names aren't affected, but list them anyway
so the list stays complete. Check afterwards: `curl -sI https://NAME.sector809labs.com`
must not answer `302` to `/unknown-subdomain`. When removing a subdomain, take it off the
list too.

Full write-up: the `sector809labs-website` repo's README, section "Unknown subdomains".

## App store developer accounts

- **Google Play (Play Console):** the company's own Google account (the Sector 809 Labs Gmail), not the owner's
  personal Gmail.
- **Apple Developer / App Store Connect:** the company's organization account for Sector 809 Labs LLC (approved
  2026-11-20), signed in with a sector809labs.com address, not a personal Apple ID.

This repo is public, so the sign-in addresses aren't written here: ask the owner if you need them. Use these accounts
for all store work, and never create a second developer account on either store.

## Testing and handoff

- `tests/e2e/` has the browser tests and a local copy of every service (site,
  Blobs, sync relay with R2, fake Google Play): `NEW_ACCOUNT_PLAN=pro bash
  reset.sh`, then `node <test>.cjs`. See its README for settings and gotchas.
  Add a test there for every new feature.
- `docs/HANDOFF.md`: what's in flight, the live setup, past decisions and
  costs, how the owner works, and what's left.
- `docs/RECOVERY.md`: the owner's recovery guide (rebuild in about an hour if
  Netlify, GitHub or Cloudflare is lost), copied to Google Drive every night as
  "READ ME FIRST". A change that adds or removes an env var, a GitHub secret,
  an outside service or a kind of stored data updates it in the same PR. Names
  only, never values.
- Nightly backup (`.github/workflows/backup.yml`, `tools/backup/`, about 3:37 am
  New York): to Google Drive "ScrapSheet backups", the same Google account as
  FinestIQ's. The code (zip + git bundle of every branch), and, locked with
  `BACKUP_PASSPHRASE` (rclone crypt, names too), every Netlify Blobs record and
  every R2 file piece, mirrored: only what changed is fetched; the earlier copy
  of anything changed or deleted goes to `old/<day>` (45 days). It stops instead
  of emptying the mirror when much of the site's data is gone. The workflow
  reads Blobs through `netlify/functions/backup.mjs` (read-only), which only
  accepts GitHub's signed token for that workflow on main
  (`netlify/lib/github-oidc.mjs`); R2 with a read-only R2 key. The repo is
  public: the log shows counts only, no GitHub artifacts. Restore:
  `tools/backup/restore-blobs.mjs`. Test: `backup`.

## Layout

- `public/` is the static site (`index.html`, `app.js`, `styles.css`).
- `netlify/functions/` holds the API, backed by Netlify Blobs:
  - `auth.mjs`: accounts (emailed animal+4-digit code, then a password),
    one-year session cookie renewed on each visit. Each sign-in has an id
    (`sid` in the cookie) and an entry in `user.sessions` ({ id, device kind
    from `lib/device.mjs`, createdAt, lastSeen }, newest 20, lastSeen updated at
    most hourly); `requireUser` and `/api/check` refuse a cookie whose entry is
    gone. Signed-in devices (`auth?action=devices`, `signout-device`) lists them
    and signs one out; Sign out removes this device's entry; a version bump
    (sign out everywhere, password change or reset, admin sign-out or
    deactivation) clears the list. Cookies from before ids work and get one on renewal.
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
    Optional password (`linkPassword()` in `app.js`, `vault.linkPasswordKeys`):
    PBKDF2 of the password and a salt gives a proof and a key; the link's part
    after `#` becomes `p.<salt>.<item key locked with that key>`; the share keeps
    `pw` { kdfSalt, scrypt hash of the proof } and `linkFragment` (that part,
    locked with the sheet key, for the owner's devices). The viewer posts the
    proof (`action=unlock`, limited per link and IP) for a 12-hour pass (`p`)
    sent with every request; without it the link serves nothing (401 with the
    salt). A link never changes once made: only Turn off link (or expiry, or
    deleting what it shares) ends one. Adding, changing or removing the password
    later (`linkPasswordChange()`) keeps the link and ends old passes. A link made
    without a password carries the key itself, so the server just asks for the
    proof (or stops). A link made with one carries the key locked with that first
    password, so the device locks the key again with PBKDF2 of the new password
    (or none) + "\n" + the whole part after `#`, and the share keeps that as
    `rekey` { salt, wrapped }: no use without the link, which never reaches the
    server. The viewer gets `wrapped` with its pass (401 says `bound`), or
    `rekey` in the open answer when no password is left. Links whose password an
    older version of the app removed (no `rekey`) ask for that password and
    check it on the device.
    New link on a phone (`prepareShare()`, `saveNewLink()` in `app.js`): iOS
    opens its share menu only straight from a tap, so while the Create link view
    is open the page picks the link's token (24 chars; `create` takes `token`)
    and works out its key part (a password's slow key work as it's typed). The
    tap opens the share menu with the finished link at once and saves it
    meanwhile: retried until the server answers, and a repeat of the same
    `create` returns the link already made (a token in use for anything else:
    409). A refusal shows "That link wasn’t saved" in the box. The viewer asks
    again for a few seconds for a link not found yet. Not ready at the tap (a
    password just typed): the old way, link first, then Share….
    Share records are rewritten whole: the view count is added to a fresh read.
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
  Complimentary Pro (the plan box's third choice; `user.comp` { at, by },
  `compKeepsPro` in plans.mjs) is free Pro that stays whatever billing says
  (a Stripe or Play subscription ending doesn't end it) until an admin picks
  Free or Pro. `planInfo().complimentary` (true only while nothing pays) makes
  the account menu read "Complimentary"; the dashboard labels and filters them.
  It's the way to give Pro away (friends, family): it works in the web and
  store apps alike. Never add a redeem-a-code box to the apps (store rules).
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
  password changes (reset or Change password), the email changes (to the old
  address), the account is started over, a new recovery key is
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
  desktop, a bottom sheet under 700px. Main view: name (tap it to change it: `auth?action=set-name`,
  `user.name`, 40 characters at most, plain text, shown only to its owner; empty =
  made from the email; other devices hear of it through the relay, part
  `account`), email, Free/Pro badge with Upgrade or Manage billing,
  then Files & share links, Recently deleted, Account & security (Appearance
  System/Light/Dark, Change email, Change password, Generate new recovery key, Download my data,
  Delete account (plain text, still confirms), Signed-in devices, Sign out of
  all devices, then a divider and Sign out last in the accent color) and Help & support (support, privacy, terms).
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
- Help (`public/help.html`, served at `/help`, legal.css): short answers by
  topic (getting started, sheets, files and sharing, syncing, privacy and
  security, plans, account), linked from Help & support (Help center), the
  front page's Help link and the legal pages' nav. Keep it true to the app:
  update it when a feature, limit or price changes.
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
  The app icon (green notepad reading "Scrap Sheet", on white, `app-icon*.png`, `public/assets/apple-touch-icon.png`,
  `icon-192/512`, `icon-maskable-512`, `icon-source`) is ONLY the installed
  app's icon (home screen, taskbar, app stores): never use it inside the site,
  app, emails or link cards; those use the kit's flat marks and logos.
- Change password (`openChangePassword()` in `app.js`, `auth?action=change-password`):
  current password, new one twice. The device opens the master key with the
  current password and locks it with the new one (`byPassword`); nothing else is
  re-encrypted and the recovery key keeps working. The server checks the current
  sign-in secret, bumps `version` (every other device signed out; this one gets a
  new cookie) and sends the `password` security notice.
- Version history (`netlify/lib/versions.mjs`, `state?sheet=N&meta=versions[&at=]`,
  `openHistory()` in `app.js`): before a save replaces a sheet's text, the stored
  text is kept as a version (a copy, so locked text stays locked): at most once
  every 10 minutes while typing, and always when the save sends `checkpoint: 1`
  (clearing, restoring, or most of the text gone). Up to 20 per sheet for 30
  days, in the state store (`versions/<sheet>/<at>`, index `vindex/<sheet>` with
  sizes and image ids). They count toward storage, their images aren't cleaned
  up, and wiping a sheet slot clears them. Sheet menu → Version history…: list,
  Show (unlocked on the device), Restore (with Undo). Clear sheet text has Undo.
- Change email (`openChangeEmail()` in `app.js`, `auth?action=email-code` then
  `change-email`): new email + password, then a code sent to the new address.
  The email salts the password key, so the device re-derives the sign-in secret
  and `byPassword` from the new email and the same password (the recovery key
  doesn't depend on the email). The server moves `users/<ek>` to the new email
  key, leaves `email-moves/<old ek>` → new (erased with the account, via
  `previousKeys`), points Stripe (`stripe-customers/…`, customer and
  subscription metadata) and the Play token at the new key (`followEmail` in
  `lib/moves.mjs`; Stripe/Play lookups go through `currentUserKey`), bumps
  `version` and emails a notice to the old address (`email`, new address masked).
- File rows: Download, Delete (trash, not red; asks first like the ••• menu)
  and •••. The ••• menu also has Rename… (the rename dialog, `openRenameModal({ file })`;
  the new name locked with the file's key, `files?action=rename`) and Move to…
  (`moveFile()`): the page re-locks the file's key for the other sheet and drives
  `move-start` / `move-piece` (one piece per call, from Netlify or R2 into the
  same kind of storage) / `move-finish` (checks every piece, keeps the dates,
  deletes the original for good, so its share link ends).
- Sheet tabs can be dragged to reorder them: press and hold 260 ms
  (`TAB_HOLD_MS`), mouse and touch alike, then drag; `meta=sheets` action
  `reorder`. Moving before the hold is a swipe that scrolls the row: a finger
  scrolls natively, a mouse or pen moves the row with it and it glides on after
  letting go (`swipeTabs()` / `endTabSwipe()`); a mouse wheel over the row
  scrolls it sideways. Tabs out of sight show a small round arrow on that edge, over the
  fade (`#tabsMoreStart` / `#tabsMoreEnd`, the count only in its label), that scrolls
  that way. A mouse held still and let go is a click (opens the tab).
  A tab list redrawn during the hold is fine (`beginTabDrag` finds the new tab). The picked-up tab rises off the row (up 7px, `scale: 1.07`,
  deeper shadow) while the others dim to half, and it follows the pointer along
  the row (`translate`). The row scrolls sideways, which clips above and below
  too, so only while a tab is held or settling it reaches up and down (padding
  with matching negative margins, nothing moves) to show the rise and shadow. The
  others slide aside in 200 ms when its edge passes their middle (FLIP in
  `slideTabs()`); letting go it glides into its slot. Holding near an edge
  scrolls the row. Reduced motion: no sliding. A tab list that arrives
  mid-drag is drawn once the drag and glide are over (`tabsRenderPending`).
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
- Updates (`checkForUpdate()` / `reloadIfQuiet()` in `app.js`): a tab left open
  notes the ETags of `/app.js` and `/` when it loads, checks again on return to
  the page (at most every 10 minutes) and hourly, and when either changed it
  reloads at a quiet moment: in the background, right on return, or after 2
  minutes without use; never with unsaved edits, a transfer or pasted image
  uploading, a delete waiting for Undo or a dialog open, and at most once every
  10 minutes per tab (`sessionStorage`). Instant open makes the reload quick.
  Server changes still have to work with pages from before them (an open tab
  can be hours old): e.g. files go to R2 only when the page sends `direct: 1`.
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
