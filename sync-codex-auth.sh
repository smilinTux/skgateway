#!/usr/bin/env bash
# Sync the chiap08 Codex CLI auth.json (READ-ONLY copy) to this host.
# The chiap08 CLI owns refresh; this gateway only consumes. Never writes back.
set -euo pipefail
SRC="skuser01@100.81.238.58:/home/skuser01/.codex/auth.json"
DST="$HOME/skgateway-codex/secrets/codex-auth.json"
TMP="$(mktemp)"
scp -q -o BatchMode=yes -o ConnectTimeout=10 "$SRC" "$TMP"
python3 - "$TMP" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
t=d.get('tokens') or {}
assert t.get('access_token'), 'no access_token in synced auth.json'
PY
mv "$TMP" "$DST"
chmod 600 "$DST"
