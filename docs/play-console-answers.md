# Play Console answers

What to enter in Play Console's App content forms for
`com.sector809labs.scrapsheet`, worked out from what the app and server
actually do (November 2026). If the app's data handling changes, update this
and the privacy policy together.

## Data safety

Google's rules that decide the answers
([Data safety help](https://support.google.com/googleplay/android-developer/answer/10787469)):

- *Collected* means sent off the device. Data that is **end-to-end encrypted**
  so that no intermediary, including the developer, can read it is **not**
  collected. ScrapSheet's content (sheet text and names, pasted images, files,
  file names and types, thumbnails) is locked on the device with AES-256 and
  the server never has the keys, so none of it is declared.
- Sending data to a **service provider** that processes it for us (Netlify
  hosting, Resend email, Stripe, Google Play, Cloudflare sync relay and R2 file
  storage) is not
  *sharing*.

### Overview questions

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (HTTPS everywhere; content is also end-to-end encrypted) |
| Do you provide a way for users to request that their data is deleted? | **Yes**: in the app (Account & security → Delete account) and at https://scrap.sector809labs.com/delete-account |
| Account creation methods | **Username, password, and other authentication** (email, password, and an emailed code) |
| Delete account URL | https://scrap.sector809labs.com/delete-account |
| Delete some data without deleting the account (optional) | Left blank: Play asks for a page with those steps, and there isn't one |

### Data types

Declare only these. For each: **Collected: yes · Shared: no · Processed
ephemerally: no**.

| Type | What it is | Required or optional | Purposes |
|---|---|---|---|
| Personal info → **Email address** | The account's email: signs in, sign-in codes, security notices | Required | App functionality, Account management |
| Personal info → **Name** | The name people may choose for themselves in the account menu (else one made from the email); shown only to them | Optional | App functionality, Account management |
| Financial info → **Purchase history** | Plan (Free/Pro), subscription status and renewal date, Stripe or Google Play subscription identifiers | Optional (only people who buy Pro) | App functionality, Account management |
| App activity → **App interactions** | Sign-in count and times, the days the app was opened (last 60), shown to staff in the admin dashboard; for each signed-in device, its kind ("Chrome on Windows"), sign-in time and last use, shown to the user (Signed-in devices) | Required | Analytics, Account management, Security |
| App activity → **Other actions** | Storage used and how many sheets, files and share links an account has (sizes and counts, never content) | Required | App functionality (plan limits), Account management |
| App info and performance → **Other app performance data** | Server error reports: which function, path and status failed (no email, content or IP), kept 30 days | Required | App functionality |

Not collected (leave unchecked): location, phone, address, contacts,
messages, photos and videos, audio, files and docs, calendar, health, web
browsing, device or other IDs, payment info (Stripe and Google Play take card
details themselves; we never see them), crash logs from the device.

Notes for the reviewer if asked:
- IP addresses are used only to limit sign-in code requests; counters are
  stored under a one-way hash and cleared within a day.
- Security notice emails name the kind of device ("Safari on iPhone"), read
  from the browser for that email. The signed-in devices list keeps the same
  kind of label per signed-in device (no device IDs), removed on sign-out.

## Content rating (IARC questionnaire)

Entered Nov 2026 (category **All Other App Types**, contact support@sector809labs.com).
Result: ESRB Everyone, PEGI 3, USK all ages, IARC 3+, ClassInd 14+ (Brazil
rates "users interact" higher); all with "Users Interact, In-App Purchases".

- Sharing follow-ups (asked after "users exchange content: Yes"): shared content
  is not the primary content · no public sharing of nudity or graphic violence ·
  no block, report or chat moderation · **interactions can be limited to invited
  friends only: Yes** (a link reaches only whoever it's sent to, optionally with
  a password).
- Online content not in the download (catalogues, AI content, news): **No**.
- Random-item purchases, cash rewards/NFTs, web browser or search engine, news
  or education: **No**.
- **Category:** All Other App Types.
- Violence, fear, sexual content, nudity, profanity, drugs, alcohol, tobacco,
  gambling, simulated gambling, hate: **No** to all.
- Does the app let users interact or exchange content with other users?
  **Yes, limited**: people can make a share link to a file or sheet that
  anyone with the link can open. There is no chat, no public feed and no
  discovery of other users.
- Does the app share the user's current location with other users? **No**.
- Does the app allow users to purchase digital goods? **Yes** (Pro subscription).
- Expected result: rated for everyone (e.g. IARC 3+ / Everyone), with
  "In-App Purchases".

## Target audience and content

| Question | Answer |
|---|---|
| Target age groups | **13–15, 16–17, 18 and over** (decided: 13 and older; a TWA can't target under 13) |
| Could the app unintentionally appeal to children? | No |
| Ads | **No ads** |
| Advertising ID | **No** (the built manifest has no AD_ID permission) |
| App access | Sign-in required: provide a reviewer account (created on the live site at submission time; credentials go only in Play Console's app access notes, never in the repo) |
| News app | No |
| COVID-19 contact tracing / status | No |
| Government app | No |
| Financial features | No |
| Health | No |
| Data safety, privacy policy URL | https://scrap.sector809labs.com/privacy |
| Account deletion URL | https://scrap.sector809labs.com/delete-account |
