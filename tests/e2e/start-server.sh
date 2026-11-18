#!/bin/bash
# Starts the site server in the background with the local test settings.
# (Used by reset.sh and restart-server.sh; output goes to server.log.)
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1
FILES_R2=${FILES_R2-1} \
PLAY_PACKAGE_NAME=com.sector809labs.scrapsheet \
PLAY_API_BASE=http://localhost:8972 \
PLAY_TOKEN_URL=http://localhost:8972/token \
PLAY_RTDN_SECRET=local-rtdn-secret-0123456789 \
PLAY_SERVICE_ACCOUNT="$(cat playkey.json)" \
NEW_ACCOUNT_PLAN=${NEW_ACCOUNT_PLAN:-free} \
NODE_USE_ENV_PROXY=1 \
STRIPE_SECRET_KEY=proxy-injected \
STRIPE_WEBHOOK_SECRET=whsec_local_test_only \
SYNC_URL=http://localhost:8787 \
SCRATCHPAD_DEV_MAIL=1 \
ADMIN_SETUP_TOKEN=${ADMIN_SETUP_TOKEN-local-test-setup-token-0123456789} \
nohup node serve.mjs >> server.log 2>&1 &
