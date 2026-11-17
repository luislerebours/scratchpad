# ScrapSheet branding

## App icon

`app-icon.png` (1254 × 1254) is **the** ScrapSheet app icon, as approved: a soft
teal spiral notepad with two text lines on a mint page, on a cream tile. Every
installed or store icon comes from it:

- `app-icon-full-bleed-1024.png`: the same art on a full-bleed cream square at
  a tighter margin than the original, notepad ~79% of the icon (platforms
  round the corners themselves). Source of
  the web app's home-screen/taskbar icons (`public/assets/apple-touch-icon.png`,
  `icon-192.png`, `icon-512.png`, `icon-source.png`), and of the iOS App Store
  icon and Android launcher icon later.
- `app-icon-maskable-1024.png`: the art smaller, inside Android's safe zone, for
  adaptive/maskable icons (`public/assets/icon-maskable-512.png`).

Don't add rounded corners or shadows to store artwork: iOS, Android and Windows
apply their own shape.

**Only for the installed app's icon.** The 3D icon and its versions are used
only where the app itself appears as an icon: home screens, taskbars, app
launchers and the App Store / Play Store. Never inside the website or app, in
emails, or on link-preview cards; those use the kit's flat marks and logos.

## Brand kit (`kit/`)

The full kit as supplied (start with `kit/START_HERE.md` and
`kit/06_Guidelines/`): logos (horizontal, stacked, wordmark; primary, all-teal,
black, white), flat marks and app artwork, social images, email signature,
print (business cards, letterhead) and web files.

From the kit, the site uses:

- Browser-tab favicons: `kit/07_Web/favicon.svg`, `favicon.ico`, `icon-64.png`
  (the flat mark stays crisp at 16–64 px) → `public/favicon.ico`,
  `public/assets/favicon.svg`, `public/assets/favicon.png`.
- Link previews: `kit/03_Social/sharing-card-1200x630.png` →
  `public/assets/sharing-card.png` (Open Graph / Twitter tags in `index.html`).
- In-app and email logo: `kit/02_Icons/mark-primary.svg`, cropped tight to the
  drawing and rendered at 256 px on a transparent background →
  `public/assets/mark-light.png` (teal, mint fill) and `public/assets/mark.png`
  (same shape in cyan #68DEFA with a faint fill, for dark mode).

Palette: teal `#247F82`, cream `#F5F2EB`, mint `#DDF5EE`, ink `#1C1C1C`
(`kit/07_Web/brand-tokens.css`). The app's own UI colors stay as the tokens in
`public/styles.css`.
