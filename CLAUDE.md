# Scratch Pad

A shared scratch pad (five sheets of text, images and files) hosted on Netlify.
Pushes to `main` deploy straight to the live site.

## Rules

- Always ask before merging into `main`, every time. Approval for one merge
  does not carry over to the next.
- Work on a branch, test, push the branch, then ask.

## Layout

- `public/` is the static site (`index.html`, `app.js`, `styles.css`).
- `netlify/functions/` holds the API, backed by Netlify Blobs:
  - `state.mjs`: sheet text/html, sheet names, current sheet
  - `files.mjs`: per-sheet file uploads in 4 MB chunks (up to 100 MB)
  - `images.mjs`: images in the text (chunked original plus a display copy)
- Netlify functions take about 4.5 MB per request, so anything larger travels
  in chunks.
- Anyone with the URL can edit, so stored html is sanitized on every load and save.
