# ScrapSheet recovery guide (READ ME FIRST)

Everything needed to bring ScrapSheet back if Netlify, GitHub, Cloudflare or your computer is lost, hacked or
deleted, in about an hour. **No secret values are in this guide.** They live in your password manager (Bitwarden),
the one thing you must keep safe.

A fresh copy of this guide goes to Google Drive every night (ScrapSheet backups › "READ ME FIRST - ScrapSheet
recovery guide.md"). It's also in the code (`docs/RECOVERY.md`). Claude keeps it current: a change that adds a
setting, a service or a kind of data updates this guide in the same pull request.

**Honest status (2026-11-19):** the backup and a full restore were tested on a computer, with folders standing in
for Google Drive and R2 (`tests/e2e/backup.cjs`). A real rebuild of the live site from Drive hasn't been practised
yet: the first time, do it with Claude's help.

## 1. The two things you must have

1. **Your password manager** (Bitwarden), with every login and secret named below.
2. **The backup passphrase**, an entry named "ScrapSheet backup passphrase". The data part of every backup is
   locked with it. Without it nobody can open the backup, you included. It's also saved in GitHub as
   `BACKUP_PASSPHRASE`, where it can be replaced but never read back.

## 2. Where the copies are

Google Drive, in the same Google account as the FinestIQ backups, folder **ScrapSheet backups**:

| What | Where in "ScrapSheet backups" | Kept |
|---|---|---|
| This guide | `READ ME FIRST - ScrapSheet recovery guide.md` | Always current |
| How last night went | `last-backup.txt` (date, how many records and file pieces) | Always current |
| The code as files (also every note: `CLAUDE.md`, `docs/`, `branding/`, `marketing/`) | `code/<day>/scrapsheet-code-<day>.zip` | 45 days |
| The code with its whole history and every branch | `code/<day>/scrapsheet-code-<day>.bundle` (`git clone` it) | 45 days |
| Every Netlify Blobs record: accounts, sign-ins, sheets, files kept on Netlify, pasted images, share links, versions, admin dashboard records, the sync signing key | `locked/` › `blobs/` | Always (the latest of each) |
| Every file piece kept in Cloudflare R2 | `locked/` › `r2/` | Always (the latest) |
| What changed or was deleted each night (the earlier copy) | `locked/` › `old/<day>/` | 45 days |
| What the site held each night (a list) | `locked/` › `manifests/<day>.json` | 45 days |

`locked/` is encrypted by rclone with the backup passphrase: file contents and names. In Drive it shows as
folders and files with scrambled names. Section 5 shows how to open it.

People's sheets, file names and files are end-to-end encrypted on their devices, so even unlocked the backup holds
only scrambled content: only each person's password or recovery key opens their own data. A restore gives every
account back exactly as it was. What isn't end-to-end encrypted (emails, plans, billing links, sign-in records,
admin records) is why the backup is locked as well.

The backup runs every night at about 3:37 am New York time (GitHub › luislerebours/scratchpad › Actions › Nightly
backup). GitHub emails you if it fails, and so does Pushover if it's set up. It copies only what changed since the
night before.

**Not in the backup:** secret settings (in your password manager, section 4), settings held by Stripe, Google Play,
Resend and Cloudflare (each keeps its own), and Claude's notes on your PC (`C:\Users\Personal\.claude`). The
code's notes are in the code.

## 3. Your accounts

| Account | What it does for ScrapSheet | If it's lost |
|---|---|---|
| **Google** (your Gmail) | Google Drive (the backups), Google Play Console (the Android app), Google Cloud (the Play service account; the project "ScrapSheet backups" with the "rclone" Drive client) | The most important login. Keep its recovery codes and phone current |
| **GitHub** (user `luislerebours`, repo `scratchpad`, public) | The code; pushes to `main` deploy the site; runs the nightly backup | Code: from the Drive bundle (section 6, "If GitHub is lost") |
| **Netlify** (site `scrapsheet`) | Runs the site and its functions; stores the data (Blobs) and some files | Section 6, "If Netlify is lost" |
| **Cloudflare** (the account with sector809labs.com) | DNS for scrap.sector809labs.com and sync.sector809labs.com (DNS only); the sync relay Worker `scratchpad-sync`; R2 bucket `scrapsheet-files` (files uploaded since Nov 18, 2026) | Section 6, "If Cloudflare is lost" |
| **Resend** | Sends every email (sign-in codes, security notices) | New account, verify the sending domain in Cloudflare DNS, new key into Netlify |
| **Stripe** ("Sector 809 Labs LLC", Managed Payments) | Pro subscriptions on the web. Never the FinestIQ account | Its customers and subscriptions stay in Stripe; only the keys go into Netlify |
| **Google Play Console** | The Android app `com.sector809labs.scrapsheet`, Pro bought in the app | The app's upload key: back it up (android/README.md) |
| **Pushover** (optional) | A phone alert when the nightly backup fails | GitHub's email still comes |

## 4. Every secret setting, by name

### Netlify › site › Project configuration › Environment variables

| Name | What it's for | Where a new one comes from |
|---|---|---|
| `RESEND_API_KEY` | Email | Resend › API keys |
| `MAIL_FROM` | The sender address (not secret) | — |
| `STRIPE_SECRET_KEY` | Stripe | Stripe › Developers › API keys |
| `STRIPE_WEBHOOK_SECRET` | Checks Stripe's messages | Stripe › Developers › Webhooks › the endpoint (`/.netlify/functions/stripe-webhook`) |
| `SYNC_URL` | The relay: `https://sync.sector809labs.com` (not secret) | — |
| `FILES_R2` | `1`: new uploads go to R2 (not secret) | — |
| `ADMIN_SETUP_TOKEN` | Enrolls the first admin once | Make up a long random string |
| `PLAY_PACKAGE_NAME` | `com.sector809labs.scrapsheet` (not secret) | — |
| `PLAY_SERVICE_ACCOUNT` | Reads Play purchases (a JSON key) | Google Cloud › the service account › Keys |
| `PLAY_RTDN_SECRET` | Checks Google Play's notices | Make up a long random string; the same in the Pub/Sub push address |

Tests only (never on the live site): `NEW_ACCOUNT_PLAN`, `SCRATCHPAD_DEV_MAIL`, `PLAY_API_BASE`, `PLAY_TOKEN_URL`.
No longer used: `OWNER_EMAIL`.

### GitHub › scratchpad › Settings › Secrets and variables › Actions

| Name | Kind | What it's for |
|---|---|---|
| `BACKUP_PASSPHRASE` | Secret | Locks the backup (the same as in your password manager) |
| `RCLONE_CONFIG` | Secret | Lets the backup write to Google Drive (only to the files it made itself) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Secrets | A read-only R2 key, to copy the file pieces |
| `R2_ACCOUNT_ID` | Variable | Your Cloudflare account ID (in the R2 page's address) |
| `PUSHOVER_TOKEN`, `PUSHOVER_USER` | Secrets (optional) | The phone alert; the same values as FinestIQ's |
| `SITE_URL` | Variable (optional) | The site's address if it moves (default `https://scrapsheet.netlify.app`) |

### Cloudflare

The relay's `PUBLIC_KEY` is in the code (`sync-worker/wrangler.toml`). It matches the sync signing key in the
backup, so a restored site works with the relay as it is.

## 5. Opening the backup on a computer

1. Install rclone (Windows: `winget install Rclone.Rclone`) and Node.js 22, and Git.
2. Sign rclone in to Google Drive (section 7, steps 1–2; any client works for reading what you can see in Drive,
   but the "rclone" client from Bitwarden sees the backup folder for sure).
3. Get the code: download `code/<newest day>/scrapsheet-code-<day>.bundle` from Drive and run
   `git clone scrapsheet-code-<day>.bundle scrapsheet`, then `cd scrapsheet` and `npm install`.
4. In Git Bash, in that folder:

   ```bash
   read -rs BACKUP_PASSPHRASE; export BACKUP_PASSPHRASE   # type it, then Enter
   source tools/backup/remotes.sh
   rclone lsf vault:            # blobs/ manifest.json manifests/ old/ r2/
   rclone copy vault:blobs ./restore-blobs -P
   ```

   (`vault:` is the unlocked view of `ScrapSheet backups/locked`. An earlier version of one record is in
   `vault:old/<day>/blobs/…`.)

## 6. What to do if…

### Netlify is lost (site or data gone, account hacked)

About an hour. Do it in this order:

1. **Code:** from GitHub, or from the Drive bundle (section 5, step 3).
2. **A new site:** in Netlify (a new account if needed) › Add new project › Import from GitHub › `scratchpad`.
   No GitHub? In the code folder: `npx netlify-cli login`, `npx netlify-cli sites:create`, then
   `npx netlify-cli deploy --prod`.
3. **Settings:** add every variable in section 4 (from your password manager).
4. **Data, before anyone signs in:** section 5, step 4, then:

   ```bash
   export NETLIFY_SITE_ID=...          # the new site › Project configuration › Project ID
   export NETLIFY_AUTH_TOKEN=...       # Netlify › User settings › Applications › Personal access tokens (delete it after)
   node tools/backup/restore-blobs.mjs ./restore-blobs --dry-run
   node tools/backup/restore-blobs.mjs ./restore-blobs --overwrite
   ```

   `--overwrite` because the new site may have made a few records of its own (like a new sync key) on its first
   visit; the backup's must win. Then delete `restore-blobs` (it holds account records) and the token.
5. **Address:** Netlify › the site › Domain management › add `scrap.sector809labs.com`; in Cloudflare › DNS change
   the `scrap` CNAME to the new `<site>.netlify.app` (DNS only). If the site's own name changed, set the GitHub
   variable `SITE_URL` so the backup follows it, and update the Android app's address only if
   `scrap.sector809labs.com` itself changed (it shouldn't).
6. **Stripe webhook:** if the address changed, point it at the new one.
7. Sign in to your own account and open a sheet and a file to check.

Files kept in R2 never left Cloudflare, so they work as soon as the site is back.

### GitHub is lost

The code is in Drive every night: clone the newest bundle (section 5, step 3). It has every branch and the whole
history. Push it to a new repository (`git remote add origin <new>` then `git push --all`), connect the Netlify site
to it, and set up the backup secrets there (section 7). The backup checks which repository it runs in
(`netlify/lib/github-oidc.mjs`): change `REPOSITORY_ID` and `OWNER_ID` to the new one's (Claude can do this).

### Cloudflare is lost

1. The domain: sector809labs.com is registered there. Losing the account is the worst case: recover it first.
2. **R2 files:** create the bucket `scrapsheet-files` again, make an R2 key with write access, then
   `rclone copy vault:r2 r2:scrapsheet-files -P` (with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   set before `source tools/backup/remotes.sh`).
3. **The relay:** in `sync-worker/`, `npx wrangler login`, then `npx wrangler deploy`. DNS records: `scrap` CNAME to
   the Netlify site; `sync` is made by the Worker's custom domain.

### The backup fails

Open the run (GitHub › Actions › Nightly backup). Common causes:

- **"Add the repository secret …"**: section 7.
- **Drive sign-in expired or refused:** set `RCLONE_CONFIG` up again (section 7). Expired after a week: the
  Google project was left in Testing; publish it first.
- **"The R2 copy couldn't sign in"**: make a new read-only R2 key (section 7).
- **"… are gone from the site. Stopped so the backup keeps them."**: the site has far fewer records than last
  night. If you didn't delete many accounts, something is wrong with the site: don't change anything, call Claude.
  If it's expected, Actions › Nightly backup › Run workflow, tick "Allow big delete".
- **Google Drive full:** the log warns below 2 GB free. Free space or buy more storage.

## 7. Setting up the nightly backup (once, or again)

All in GitHub › luislerebours/scratchpad › Settings › Secrets and variables › Actions.

**Google Drive (`RCLONE_CONFIG`).** ScrapSheet has its own Google client, in its own Google Cloud project
"ScrapSheet backups" (on the Google account that holds the FinestIQ backups). Saved in Bitwarden as
"ScrapSheet Google Drive backup (rclone)". If it's lost, make it again:

- console.cloud.google.com › new project "ScrapSheet backups" › APIs & Services › Library › **Google Drive API** ›
  Enable.
- OAuth consent screen (Google Auth Platform): External. **Branding**: app name ScrapSheet backups, your support
  email, home page `https://scrap.sector809labs.com`, privacy `…/privacy`, terms `…/terms`, authorized domain
  `sector809labs.com` (no dot at the end). Leave the logo empty (a logo needs Google's review).
- **Audience** › Publish app (In production). Left in Testing, the sign-in stops working after 7 days.
- **Clients** › Create client › Desktop app, name "rclone". Save its Client ID and Client secret in Bitwarden.

Then:

1. In PowerShell: `rclone config create drive drive scope=drive.file client_id=<Client ID> client_secret=<Client secret>`.
   A browser opens: sign in to the Google account that holds the FinestIQ backups and allow access ("Google hasn't
   verified this app": Advanced › Go to ScrapSheet backups; it's your own app). If a sign-in fails halfway,
   `rclone config delete drive` and try again.
2. Put the settings into GitHub, then delete them from the computer (PowerShell):
   `Get-Content $env:APPDATA\rclone\rclone.conf -Raw | gh secret set RCLONE_CONFIG -R luislerebours/scratchpad`
   then `Remove-Item $env:APPDATA\rclone\rclone.conf`. (Elsewhere, `rclone config file` says where the file is.)

**The passphrase (`BACKUP_PASSPHRASE`).** Make one in Bitwarden (20+ characters), save it as "ScrapSheet backup
passphrase", then `gh secret set BACKUP_PASSPHRASE -R luislerebours/scratchpad` and paste it when asked.
Changing it later: the earlier backup stays locked with the old one, so start a new `locked/` (rename the old
folder in Drive and keep it, with its passphrase, until the new one has a few weeks).

**R2 (read-only key).** Cloudflare › R2 › API Tokens › Create Account API token: name "ScrapSheet R2 backup key
(read only)", permission **Object Read only**, specific bucket `scrapsheet-files`. The next page shows the values
once: save them in Bitwarden under that name before leaving it. Of the three values, use the two under "S3
clients": the **Access Key ID** (32 characters) and the **Secret Access Key** (64). The "Token value" at the top
(about 53 characters) is not used. Then `gh secret set R2_ACCESS_KEY_ID -R luislerebours/scratchpad` and
`gh secret set R2_SECRET_ACCESS_KEY -R luislerebours/scratchpad` (paste each when asked). `R2_ACCOUNT_ID` is
already set (`gh variable set R2_ACCOUNT_ID -R luislerebours/scratchpad --body <account id>` if it isn't: the long
id in the R2 page's address). Delete any older backup token in that list so only one is left.

**Phone alert (optional).** `gh secret set PUSHOVER_TOKEN` and `PUSHOVER_USER` with FinestIQ's values.

Then Actions › Nightly backup › Run workflow, and check Drive for "ScrapSheet backups".
