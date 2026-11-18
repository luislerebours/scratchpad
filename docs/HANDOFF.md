# Handoff: where ScrapSheet stands (November 18, 2026)

For the next Claude session (or person) picking this up. **Read `CLAUDE.md`
first**: it describes how the app works and its rules. This file adds what
isn't there: what's in flight, why things are the way they are, the live
setup, how the owner likes to work, and what's left.

## 1. In flight: six pull requests, ready to merge

All built and tested on their own branches. Merge **one at a time, in this
order**, and only after the owner says to (each merge needs its own "yes",
see CLAUDE.md). Before each merge: bring the branch up to date with `main`,
resolve conflicts, rerun its test, then merge.

| Order | PR | What | Test |
|---|---|---|---|
| 1 | #70 `text-history` | Version history per sheet (20 versions, 30 days, encrypted copies) and Undo after Clear | `history` |
| 2 | #71 `files-tabs` | Rename and Move to… for files; drag tabs to reorder | `filestabs` |
| 3 | #72 `change-email` | Change email (code to the new address; keys re-derived on the device) | `emailchange` |
| 4 | #73 `devices-list` | Signed-in devices list, sign out one device | `devices` |
| 5 | #75 `share-password` | Optional password on share links | `sharepw` |
| 6 | #74 `help-page` | Help page at /help (25 Q&As) | (visual) |

Known follow-ups while merging:

- **#72 and #73 both change `netlify/functions/auth.mjs`.** After both are in,
  the `change-email` action must call `signedIn({ ...moved, sessions: [] }, {}, req)`
  so the device that changed its email gets a fresh entry in the devices list
  (every other device was signed out). Rerun `emailchange` and `devices`.
- **#70 and #73 each add a dialog.** The page-wide Escape handler in
  `public/app.js` (`document.addEventListener('keydown'…)`, near the download
  code) should close `historyModal` too, like it does `devicesModal`.
- **#74 (Help) before merging:** add a sentence about share link passwords to
  "How do share links work?", and check every answer is still true. Also add
  the new settings (Change email, Signed-in devices) to CLAUDE.md's profile menu
  line if a merge dropped them.
- CLAUDE.md is edited by every PR: resolve its conflicts by keeping all the
  new paragraphs.

## 2. The live setup

- **Netlify** site `scrapsheet` (id `66606ede-ffe3-4b49-9fbb-8fa51181afb0`),
  served at https://scrap.sector809labs.com and https://scrapsheet.netlify.app.
  Pushes to `main` deploy. Env vars in use (names only): `RESEND_API_KEY`,
  `MAIL_FROM`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (**still the
  sandbox**), `SYNC_URL` (https://sync.sector809labs.com), `FILES_R2=1`,
  `ADMIN_SETUP_TOKEN`. Not yet: `PLAY_PACKAGE_NAME`, `PLAY_SERVICE_ACCOUNT`,
  `PLAY_RTDN_SECRET`.
- **Cloudflare** (the account that holds sector809labs.com): Worker
  `scratchpad-sync` on the custom domain `sync.sector809labs.com`
  (`workers_dev = false`), Durable Objects for sync rooms, R2 bucket
  `scrapsheet-files` (location ENAM) bound as `FILES`. Deploy with
  `npx wrangler deploy` in `sync-worker/`. In a Claude Code cloud session the
  environment can hold a Cloudflare API token as a network secret for
  api.cloudflare.com: then run wrangler with `CLOUDFLARE_API_TOKEN=proxy-injected`
  and `CLOUDFLARE_ACCOUNT_ID` taken from `GET /client/v4/accounts`.
  `wrangler tail` doesn't get through the cloud proxy; to see R2 activity, list
  the bucket through the API instead.
- **Stripe**: sandbox "Sector 809 Labs LLC sandbox" works end to end. The live
  account isn't connected to Claude yet (see section 6). **Never touch the
  FinestIQ account** (the owner's other app).
- **Never touch the `ojpad` Netlify site** (a coworker's copy).
- Netlify logs: the Netlify connector's observability "get-request-logs"
  (filter `FunctionName`) was the fastest way to debug live problems.

## 3. Why things are the way they are (decisions)

- **End-to-end encryption** is a core promise ("Private to your account ·
  AES-256 encrypted"). Every feature must keep content unreadable to the
  server; that's why moving files re-locks keys on the device, version
  history stores copies of ciphertext, and share link passwords are checked
  with a one-way proof.
- **Files in Cloudflare R2** (since Nov 18) because Netlify charges ~$0.13/GB
  for downloads and R2 charges nothing. Pieces are 1 MB in R2 (a phone upload
  cut off by an app switch loses at most 1 MB), 4 MB on Netlify. Older files
  stay on Netlify.
- **Compatibility with old tabs:** files go to R2 only when the page sends
  `direct: 1` (a tab opened before R2 kept sending pieces to Netlify and every
  upload failed). Open tabs now reload themselves at quiet moments
  (`checkForUpdate()`), but server changes must still accept older pages.
- **Workplace networks** can block `sync.sector809labs.com` (the owner's work
  does). The app falls back: downloads through Netlify (`via=netlify`),
  uploads stored on Netlify, saves ask the server to notify other devices.
- **Phones abort uploads themselves on an app switch** (iOS fires `abort`).
  Only the Cancel button counts as cancelling; everything else is a dropped
  connection that's waited out and resumed.
- **Cost trims (Nov 18):** saves go out 1.5 s after typing stops (at least
  every 5 s), the device that saved posts the sync notice itself, and the
  safety-net check is every 5 minutes while live sync is up.
- **Billing stays on Stripe with Managed Payments** (Stripe is merchant of
  record: sales tax and VAT handled). The owner considered PayPal (cheaper
  per charge but no tax handling) and decided to keep Stripe. To cut fee
  share, the upgrade card shows **yearly first**.
- **Android = Trusted Web Activity (Bubblewrap)**, iOS later with Capacitor.
  Package `com.sector809labs.scrapsheet` is permanent.
- **Two-step sign-in for users** was offered and **declined for now**.
- Deferred bigger cost moves (only if usage justifies): text saves on the
  Cloudflare relay instead of Netlify; moving off Netlify entirely. At ~1 TB
  stored, Backblaze B2 would be a little cheaper than R2.

### Costs (estimates, from price lists)

Per user per month, after the R2 move and cost trims:

| User | Cost |
|---|---|
| Typical Free | ~$0.03 |
| Typical Pro (0.5 GB stored, 1.5 GB downloaded) | ~$0.08 |
| Heaviest Pro (5 GB, 20 GB downloaded, hours of typing daily) | ~$0.55 |

What a Pro subscriber leaves after fees, per month:

| Plan | You keep |
|---|---|
| Stripe monthly ($0.99) | $0.62 |
| Stripe yearly ($9.99) | $0.75 |
| Google Play monthly | $0.84 |

Fixed costs:
- Netlify Pro: $20/month (includes ~$20 of usage).
- Cloudflare Workers: $5/month.
- R2: $0 inside its free tier (10 GB, 1M writes, 10M reads a month).
- Resend: free up to 100 emails a day; Amazon SES if that's ever exceeded.

## 4. How the owner works

- Often away from the keyboard: prefers decisions as quick choices (the
  AskUserQuestion tool works well) and short replies.
- Says **"merge"** to approve a merge. Ask every time.
- Likes plain-language summaries, with screenshots of anything visual, and
  honest notes about what failed or wasn't tested.
- Tests on an **iPhone** and on **Windows PCs at work** (where the relay is
  blocked). A slow upload once turned out to be a 0.59 Mbps phone connection,
  not the app.
- Never put secrets in chat or code; never repeat a key; don't put the
  owner's email in code, requests or docs.
- Commit trailers and PR body endings come from the session's attribution
  settings; don't put model names in commits or PRs.

## 5. Testing

`tests/e2e/` holds the browser tests and a local copy of every service (see
its README): `NEW_ACCOUNT_PLAN=pro bash reset.sh`, then `node <test>.cjs`.
Restart the server after changing server code; reset when rate limits pile up.
Four older checks are known to be outdated (listed in the README).

## 6. What's left (needs the owner at a keyboard)

1. **Stripe live mode:**
   - **The owner:** activates the live account (business details, ID, bank), turns on Managed Payments, and pastes the live secret key into Netlify as `STRIPE_SECRET_KEY`.
   - **Then Claude**, once the live account is connected to the Stripe connector:
     - creates the "ScrapSheet Pro" product (tax code `txcd_10103000`) with prices by lookup key `scrapsheet_pro_month` $0.99 and `scrapsheet_pro_year` $9.99, tax inclusive;
     - sets up the customer portal;
     - creates the webhook to `/.netlify/functions/stripe-webhook`. The owner copies its signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Google Play:**
   - Play Console app setup: listing kit in `branding/play-store/`, answers in `docs/play-console-answers.md`.
   - The `PLAY_*` env vars on Netlify.
   - `bubblewrap build` (see `android/README.md`), and back up the upload key.
   - Add the SHA-256 fingerprints to `public/.well-known/assetlinks.json`.
   - Create a reviewer account at submission time (credentials only in Play Console).
   - Optional: retake the Play screenshots with the real Lisbon photo (`storeshots` + `storecompose`); the current ones use a drawn picture.
3. **sector809labs.com product page:** a marketing kit is in
   `marketing/sector809labs/` (copy, images, credits). The owner drops it into
   the session that maintains that website. The Lisbon photo needs its CC BY credit.
4. Open question: the front page still leads with "$0.99 / month" (yearly
   underneath). The owner hasn't asked to flip it.
