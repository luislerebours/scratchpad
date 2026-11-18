#!/bin/bash
# Fresh local test setup: empty database, the site server (port 8970, Netlify
# Blobs on 8971), a fake Google Play API (8972) and the sync relay with R2
# simulated (wrangler dev, 8787), with matching keys.
#   NEW_ACCOUNT_PLAN=pro|free  plan for new accounts (default free)
#   FILES_R2=1|0               new uploads to R2 or Netlify (default 1)
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$HERE" || exit 1
for pid in $(pgrep -f "node serve.mjs"); do kill "$pid"; done
for pid in $(pgrep -f "node playmock.mjs"); do kill "$pid"; done
for pid in $(pgrep -f "wrangler|workerd"); do kill -9 "$pid" 2>/dev/null; done
sleep 1
rm -rf ./blobdata
mkdir -p out
# A throwaway service-account key for the fake Play API (never a real one).
[ -f playkey.json ] || node make-playkey.mjs
nohup node playmock.mjs > playmock.log 2>&1 &
bash "$HERE/start-server.sh" > server.log 2>&1
sleep 2
node seed.mjs
KEY=$(curl -s "http://localhost:8970/.netlify/functions/sync?action=key" | python3 -c "import sys,json; print(json.load(sys.stdin)['publicKey'])")
echo "$KEY" > pubkey.txt
(cd "$REPO/sync-worker" && nohup npx wrangler dev --local --port 8787 --var "PUBLIC_KEY:$KEY" > "$HERE/wrangler.log" 2>&1 &)
for i in $(seq 1 40); do grep -q "Ready on" wrangler.log && break; sleep 1; done
curl -s -o /dev/null -w "relay %{http_code}\n" http://localhost:8787/
sleep 5
echo ready
