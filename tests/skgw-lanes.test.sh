#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/gw/data" "$tmp/cap/evidence/fleet-live" "$tmp/cap/evidence/fleet-rotation/run" "$tmp/cap/fleet/objects/node" "$tmp/cap/fleet/status/node-n1"
python3 - "$tmp/home/gw/data/metrics.db" <<'PY'
import sqlite3,sys,time
c=sqlite3.connect(sys.argv[1]); c.execute('create table request_log(backend text, model text, status_code integer, total_ms integer, started_at integer)')
c.execute('insert into request_log values(?,?,?,?,?)',('codex','sk-codex-mid',200,10,int(time.time()*1000))); c.commit()
PY
cat >"$tmp/bin/systemctl" <<EOF
#!/bin/sh
[ "\$1" = --user ] && [ "\$2" = show ] && { echo "$tmp/home/gw"; exit; }
EOF
cat >"$tmp/bin/curl" <<'EOF'
#!/bin/sh
exit 1
EOF
cat >"$tmp/bin/herdr" <<'EOF'
#!/bin/sh
printf '%s\n' '{"result":{"agents":[{"name":"ds-card1","agent_status":"working"}]}}'
EOF
chmod +x "$tmp/bin/"*
now=$(date +%s); iso=$(date -u +%FT%TZ)
printf '{"host":"n1","ts":%s,"workers":[{"card_id":"card1","owner":"pi-deepseek-n1-card1"}]}' "$now" >"$tmp/cap/evidence/fleet-live/n1.json"
printf 'LAUNCHED|n1|x|card1|lane=deepseek\nWORKSPACE_BLOCKED|n1|x|why\n' >"$tmp/cap/evidence/fleet-rotation/run/actions.log"
printf '{"name":"node-n1","spec":{"address":{"hostname":"n1"},"cordoned":false}}' >"$tmp/cap/fleet/objects/node/node-n1.json"
printf '{"ts":"%s"}' "$iso" >"$tmp/cap/fleet/status/node-n1/heartbeat.json"
out=$(HOME="$tmp/home" SKCAPSTONE_HOME="$tmp/cap" SKGW_METRICS_DB="$tmp/home/gw/data/metrics.db" SKGW_GATEWAY_URL=http://127.0.0.1:1 PATH="$tmp/bin:$PATH" "$ROOT/scripts/skgw-lanes" 60)
grep -q 'codex.*sk-codex-mid.*1' <<<"$out"
grep -q 'n1.*deepseek.*card=card1' <<<"$out"
grep -q 'launches: deepseek=1' <<<"$out"
grep -q 'WORKSPACE_BLOCKED=1' <<<"$out"
grep -q 'node-n1.*Ready.*workers=1' <<<"$out"
grep -q 'deepseek.*working=1' <<<"$out"
echo 'skgw-lanes test: PASS'
