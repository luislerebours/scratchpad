# Scratch Pad

A shared scratch pad (five sheets of text, images and files) hosted on Netlify.
Pushes to `main` deploy straight to the live site.

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
  - `state.mjs`: sheet list (starts at 5, up to 10 per account), sheet text/html, current sheet
  - `admin.mjs`: admin-only (the `OWNER_EMAIL` account) list of accounts with data
    used, sign-ins and active days
  - `files.mjs`: per-sheet file uploads in 4 MB chunks (up to 100 MB)
  - `images.mjs`: images in the text (chunked original plus a display copy)
- Netlify functions take about 4.5 MB per request, so anything larger travels
  in chunks.
- `netlify/lib/auth.mjs` is shared: sessions, `requireUser`, and `userStore`,
  which keeps each account's data in its own stores (`u-<id>-…`). The account
  whose email matches the `OWNER_EMAIL` env var owns the original `scratchpad…`
  stores from before accounts existed.
- Email goes through Resend: `RESEND_API_KEY` and `MAIL_FROM` env vars on Netlify.
  Locally, `SCRATCHPAD_DEV_MAIL=1` logs codes instead of sending them.
- Stored html is sanitized on every load and save.
