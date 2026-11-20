# End-to-end tests

Browser tests (Playwright) against a local copy of everything: the site and
its functions (`serve.mjs`, port 8970, with Netlify Blobs on 8971), the sync
relay with R2 simulated (`wrangler dev`, 8787) and a fake Google Play API
(`playmock.mjs`, 8972). Nothing touches the live site.

## Run

From the repo: `npm install` once (the server uses `@netlify/blobs` from it).
Playwright and Chromium must be available (`require('playwright')`; in a
Claude Code cloud session they're preinstalled; elsewhere
`npm install --no-save playwright` and `npx playwright install chromium`).
The relay needs `npx wrangler` (`npm install` in `sync-worker/`, or downloaded
on first use). Works on Linux, macOS and Windows (Git Bash; Python as
`python` for `exportdata` and `storecompose`).

```bash
cd tests/e2e
```

```bash
NEW_ACCOUNT_PLAN=pro bash reset.sh
```

```bash
node r2files.cjs
```

Each test prints `PASS`/`FAIL` lines and ends with `ALL PASS` or `N FAILED`
(`sharet` prints `errors: [] | fails: 0`). Screenshots go to `out/`.

- `reset.sh` starts everything fresh with an empty database. Settings:
  `NEW_ACCOUNT_PLAN=pro|free` (plan for new accounts, default free) and
  `FILES_R2=1|0` (new uploads to R2 or Netlify, default 1).
- `restart-server.sh` restarts only the site server, keeping data and relay.
  **Run it after changing server code** (the server loads the functions once),
  or to switch `NEW_ACCOUNT_PLAN` / `FILES_R2`.
- Sign-in codes are printed to `server.log` (`[dev mail] to … code …`); tests
  read them from there. Security emails show as `security <kind>`.

## Gotchas

- **Don't pipe `reset.sh` into another command** (`| tail`, `| grep`): the relay
  it starts in the background keeps the pipe open, so the command never ends.
  Send its output to a file or `/dev/null` instead.
- **Rate limits carry over between runs.** After many sign-ups (or the
  share-password guessing test) a test can stall at the code step or get 429:
  run `reset.sh`. Locally every request comes from the same "unknown" IP.
- **Plan per test.** Most need Pro (`NEW_ACCOUNT_PLAN=pro`). `playbilling` and
  the last part of `costtrims` (the upgrade card) need Free.
- **`e2ee`** reads stored pieces from Blobs directly, so run it with R2 off:
  `FILES_R2=0 NEW_ACCOUNT_PLAN=pro bash restart-server.sh`.
- **`offlineview`** occasionally fails once right after a reset (a request
  already on its way finishes after the page goes offline); it passes when run
  again, on main too.
- **`blockedrelay`** imitates a network that blocks the relay with a second
  Chromium that can't resolve `localhost` (the app is opened at 127.0.0.1).
- **`autoupdate`** uses Playwright's fake clock and `deploy-salt.txt` (the
  server mixes it into its ETags) to imitate a new deploy.
- `storeshots.cjs` + `storecompose.cjs` remake the Play Store images
  (`out/store/`), from a demo account with the CC BY 4.0 Lisbon photo in
  `imgs/` ("Panoramic View from Miradouro da Senhora do Monte in Lisbon" by
  Dale Cruse, cropped). Copy the results to `branding/play-store/`.

## Known outdated checks (fail the same way on main)

- `playbilling`: one check expects monthly first on the upgrade card (yearly
  is first since the cost trims).
- `swipe`: expects the attachment count as "3 attachments" (now just "3").
- `img`: times out at the start (written before a later editor change).
- `admdashB`: some checks predate retiring the legacy admin account.

Fixing these is fine: update the expectation, not the app.

## The suites

| Test | Covers |
|---|---|
| `aestip` | The AES-256 note and its info popup on the sign-in page |
| `attachbtn` | The attach button and uploads |
| `autoupdate` | Open tabs reloading for a new version, only at quiet moments |
| `backup` | The nightly backup whole (local folders as Drive and R2; needs rclone): who may call it, encryption, only changes fetched, old versions kept, the stop on mass deletes, 45-day clean-up, and a restore that matches byte for byte |
| `blockedrelay` | A network that blocks the relay: files through Netlify, edits still reach other devices |
| `costtrims` | Save cadence, device-sent sync notices, 5-minute safety check, yearly first |
| `delacctB` | Deleting an account |
| `deletepage` | The public /delete-account page and admin deletion |
| `devices` | Signed-in devices list, signing one device out |
| `e2ee` | End-to-end encryption of everything stored (R2 off) |
| `emailchange` | Change email |
| `exportdata` | Download my data (.zip) |
| `filestabs` | Rename and move files, drag tabs to reorder |
| `history` | Version history and Undo after Clear |
| `instantopen` | Opening from the device's encrypted copy |
| `iosabort` | Uploads surviving the phone aborting them on an app switch, stalled pieces |
| `linkreasons` | Why a share link ended |
| `mshare` | Sharing on phones |
| `offlineview` | Offline = view only |
| `oldtab` | Tabs from before R2 still upload |
| `playbilling` | Google Play Billing (fake Play API) |
| `profilemenu` | The account menu |
| `pwchange` | Change password, trash button on file rows |
| `r2files` | Files in R2: upload, download, passes, deletes |
| `ratehash.mjs` | Rate-limit counters stored under hashes |
| `secnotice` | Security emails |
| `sharepw` | Password-protected share links |
| `sharet` | Share links |
| `sharetarget` | Share to ScrapSheet (Android share target) |
| `sync` | Live sync between two devices |
| `toobig` | The too-big file warning |
| `uploadresume` | Uploads and downloads pausing and resuming |
| `zip64.mjs` | The .zip writer past 4 GB |

Tests for features still in open pull requests (`history`, `filestabs`,
`emailchange`, `devices`, `sharepw`) pass on their branches and will on main
once those are merged.
