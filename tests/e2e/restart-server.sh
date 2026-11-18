#!/bin/bash
# Restarts only the site server (keeps the data and the relay), e.g. after
# changing server code or to switch NEW_ACCOUNT_PLAN / FILES_R2.
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1
for pid in $(pgrep -f "node serve.mjs"); do kill "$pid"; done
sleep 1
bash "$HERE/start-server.sh"
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8970/ && break; sleep 0.5; done
echo restarted
