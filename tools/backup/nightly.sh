#!/usr/bin/env bash
# The nightly backup to Google Drive (run by .github/workflows/backup.yml;
# what's where and how to restore: docs/RECOVERY.md). In "ScrapSheet backups":
#   READ ME FIRST - ScrapSheet recovery guide.md   (replaced every night)
#   last-backup.txt                                when and how much (counts only)
#   code/<day>/scrapsheet-code-<day>.zip           the code as files
#   code/<day>/scrapsheet-code-<day>.bundle        the code with all its history (git clone it)
#   locked/   (encrypted with the backup passphrase, names too; open it as "vault:")
#     blobs/<store>/<key>   every Netlify Blobs record: accounts, sheets, files, images, links…
#     r2/files/…            every file piece kept in Cloudflare R2
#     manifest.json, manifests/<day>.json   what the site held each night
#     old/<day>/…           what changed or was deleted that night (the earlier copy)
# Day folders (code, old, manifests) are kept KEEP_DAYS (45) days. Nothing in
# blobs/ or r2/ is ever removed except by moving it to old/<day>.
# Env: BACKUP_PASSPHRASE, SITE, TOKEN (GitHub's signed token), R2_* (see
# remotes.sh), ALLOW_BIG_DELETE=1, and for tests: DRIVE_DIR, R2_SRC, DAY.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=remotes.sh
source "$here/remotes.sh"

DAY="${DAY:-$(date -u +%F)}"
KEEP_DAYS="${KEEP_DAYS:-45}"
CUTOFF="$(date -u -d "$DAY - $KEEP_DAYS days" +%F)"
R2_SRC="${R2_SRC:-r2:scrapsheet-files}"
WORK="$(mktemp -d)"
# Git Bash on Windows: a path node and rclone both read the same way.
if command -v cygpath > /dev/null; then WORK="$(cygpath -m "$WORK")"; fi
trap 'rm -rf "$WORK"' EXIT
RC=(rclone --retries 3 --low-level-retries 10 --stats 0)

# 1. The code, and the recovery guide on top.
git -C "$repo" bundle create "$WORK/scrapsheet-code-$DAY.bundle" --all 2>/dev/null
git -C "$repo" archive --format=zip -o "$WORK/scrapsheet-code-$DAY.zip" HEAD
"${RC[@]}" copyto "$WORK/scrapsheet-code-$DAY.zip" "$DRIVE_DIR/code/$DAY/scrapsheet-code-$DAY.zip"
"${RC[@]}" copyto "$WORK/scrapsheet-code-$DAY.bundle" "$DRIVE_DIR/code/$DAY/scrapsheet-code-$DAY.bundle"
"${RC[@]}" copyto "$repo/docs/RECOVERY.md" "$DRIVE_DIR/READ ME FIRST - ScrapSheet recovery guide.md"
echo "Code: copied."

# 2. Netlify Blobs: only what changed since last night.
if "${RC[@]}" lsf vault: --files-only 2>/dev/null | grep -qx 'manifest.json'; then
  "${RC[@]}" copyto vault:manifest.json "$WORK/prev.json"
fi
SITE="$SITE" TOKEN="$TOKEN" PREV="$WORK/prev.json" OUT="$WORK/out" node "$repo/tools/backup/pull.mjs"
"${RC[@]}" copy "$WORK/out/blobs" vault:blobs --backup-dir "vault:old/$DAY/blobs"
if [ -s "$WORK/out/deleted.txt" ]; then
  "${RC[@]}" move vault:blobs "vault:old/$DAY/blobs" --files-from "$WORK/out/deleted.txt" --no-traverse
fi
# The manifest last: if anything above failed, tomorrow fetches it all again.
"${RC[@]}" copyto "$WORK/out/manifest.json" "vault:manifests/$DAY.json"
"${RC[@]}" copyto "$WORK/out/manifest.json" vault:manifest.json

# 3. Cloudflare R2: the file pieces, mirrored.
r2note="R2: not set up (add the R2_* secrets)"
if [ -n "${R2_ACCESS_KEY_ID:-}" ] || [ "$R2_SRC" != "r2:scrapsheet-files" ]; then
  have=$({ "${RC[@]}" lsf -R --files-only vault:r2 2>/dev/null || true; } | wc -l)
  limit=$(( have / 10 > 50 ? have / 10 : 50 ))
  [ "${ALLOW_BIG_DELETE:-}" = 1 ] && limit=-1
  if ! "${RC[@]}" sync "$R2_SRC" vault:r2 --backup-dir "vault:old/$DAY/r2" --max-delete "$limit"; then
    echo "::error::The R2 copy stopped. If many file pieces are gone from R2 (more than $limit), that's on purpose: the backup keeps them. Expected? Run the workflow by hand with \"allow big delete\" ticked."
    exit 1
  fi
  r2note="R2: $("${RC[@]}" lsf -R --files-only vault:r2 | wc -l) file pieces"
fi
echo "$r2note"

# 4. Day folders older than KEEP_DAYS.
for spot in "$DRIVE_DIR/code" vault:old; do
  for d in $("${RC[@]}" lsf "$spot" --dirs-only 2>/dev/null); do
    d="${d%/}"
    if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$d" < "$CUTOFF" ]]; then "${RC[@]}" purge "$spot/$d"; fi
  done
done
for f in $("${RC[@]}" lsf vault:manifests --files-only 2>/dev/null); do
  if [[ "${f%.json}" < "$CUTOFF" ]]; then "${RC[@]}" deletefile "vault:manifests/$f"; fi
done

# 5. A note on top saying how it went.
{
  echo "Last backup: $DAY ($(date -u +%H:%M) UTC)"
  node -e 'const s=require(process.argv[1]);console.log(`Netlify Blobs: ${s.stores} stores, ${s.blobs} records (${s.fetched} new or changed tonight, ${s.deleted} gone)`)' "$WORK/out/summary.json"
  echo "$r2note"
  echo "Kept: day folders for $KEEP_DAYS days. How to restore: READ ME FIRST - ScrapSheet recovery guide.md"
} > "$WORK/last-backup.txt"
"${RC[@]}" copyto "$WORK/last-backup.txt" "$DRIVE_DIR/last-backup.txt"
cat "$WORK/last-backup.txt"

# Space left in Drive (only a warning).
free=$("${RC[@]}" about "${DRIVE_DIR%%:*}:" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.free??"")}catch{console.log("")}})' || true)
if [ -n "$free" ]; then
  echo "Google Drive: $(( free / 1000000000 )) GB free"
  if [ "$free" -lt 2000000000 ]; then echo "::warning::Google Drive has less than 2 GB free. The backup stops when it's full."; fi
fi
exit 0
