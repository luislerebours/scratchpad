# ScrapSheet for Android (Bubblewrap / Trusted Web Activity)

`twa-manifest.json` is the whole Android app: Bubblewrap generates the
project from it. Everything else in this folder is generated and ignored
(see `.gitignore`), and so is the signing key.

What it sets (tested with a full build, November 2026):

- Package `com.sector809labs.scrapsheet` (permanent), name ScrapSheet,
  version 1.0.0 (code 1). Raise `appVersionCode` for every upload.
- Opens `https://scrap.sector809labs.com/?source=twa`, full screen.
- **Target Android 16 (API 36)**, as Play requires: needs Bubblewrap
  **1.27 or later**.
- **Minimum Android 7.0 (API 24)**: Android Browser Helper and its Play
  Billing part won't build for anything older.
- Google Play Billing on (`features.playBilling`): the billing permission and
  service that Chrome's Digital Goods API uses.
- ScrapSheet in the Android Share menu (text, and any file, one or several)
  from the web manifest's `share_target`.
- Notifications switched on (`enableNotifications`) only because Bubblewrap
  1.27 refuses Play Billing without it (the billing service rides on the same
  delegation). ScrapSheet never asks for notification permission or sends any,
  so Android never shows the prompt.
- Status and navigation bars: warm paper `#F5F1EB` in light, navy `#091524`
  in dark. Icons come from the live site (the approved 3D app icon, plus the
  maskable version).

## Build (on your computer)

Needs Node.js. Bubblewrap offers to download a JDK and the Android SDK the
first time.

```bash
npm i -g @bubblewrap/cli
```

```bash
cd android
```

```bash
bubblewrap update --skipVersionUpgrade
```

(`update` raises the version each time unless told not to; drop the flag for
a new release, or raise `appVersionCode` by hand.)

```bash
bubblewrap build --skipPwaValidation
```

(The flag skips an online quality check of the website that the app doesn't
need.)

**The upload key** `scrapsheet-upload.keystore` (alias `scrapsheet-upload`)
was made on November 18, 2026 and lives only on the owner's PC (and its
backup), never in the repo. `build` asks for its passwords (the same one
twice) but never creates a key: only `bubblewrap init` does. To make one again,
run the JDK's keytool in a regular PowerShell window (the Claude app's terminal
doesn't pass hidden password typing to Java):

```powershell
& "$env:USERPROFILE.bubblewrapjdkjdk-17.0.11+9inkeytool.exe" -genkeypair -v -keystore scrapsheet-upload.keystore -alias scrapsheet-upload -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Sector 809 Labs LLC, O=Sector 809 Labs LLC, C=US"
```

With Play App Signing (the default), Google holds the real app signing key,
and a lost upload key can be reset through Play Console support.

`build` makes `app-release-bundle.aab` (upload this to Play Console) and a
signed `app-release-signed.apk` (to install on a phone directly).

If Gradle fails with "429 Too Many Requests" from Maven Central, wait a minute
and run `bubblewrap build` again (downloads are cached).

## Fingerprints (Digital Asset Links)

The upload key's SHA-256 is already in `public/.well-known/assetlinks.json` and
`twa-manifest.json` (`fingerprints`), so a phone with the APK installed
directly opens full screen.

After the first upload:

1. Play Console → Test and release → App integrity → App signing: copy the
   **SHA-256** of the app signing key.
2. Add it to `public/.well-known/assetlinks.json` (and `fingerprints`) and deploy. Without it the
   app shows a browser bar instead of running full screen. Check it with
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://scrap.sector809labs.com&relation=delegate_permission/common.handle_all_urls`.
