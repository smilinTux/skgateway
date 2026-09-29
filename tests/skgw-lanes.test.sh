#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
server_pid=""
cleanup() { [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/bin" "$tmp/home/skgateway-codex/data" "$tmp/cap/evidence/fleet-live" \
  "$tmp/cap/evidence/fleet-rotation/run" "$tmp/cap/fleet/objects/node" \
  "$tmp/cap/fleet/status/node-n1"

# The local default database is deliberately stale/wrong. With no explicit DB,
# the report must obtain the open database from the gateway host over SSH.
python3 - "$tmp/home/skgateway-codex/data/metrics.db" "$tmp/remote.db" <<'PY'
import sqlite3,sys,time
for path, backend in ((sys.argv[1], "local-stale"), (sys.argv[2], "codex")):
    c=sqlite3.connect(path)
    c.execute('create table request_log(backend text, model text, status_code integer, total_ms integer, started_at integer)')
    c.execute('insert into request_log values(?,?,?,?,?)',(backend,'sk-codex-mid',200,10,int(time.time()*1000)))
    c.commit()
PY

cat >"$tmp/bin/ssh" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift 2;; *) break;; esac
done
host=$1; shift
if [ "$1" = python3 ] && [ "$2" = - ]; then
  shift 2
  exec python3 - "$@"
fi
case "$*" in
  *'find "/proc/$pid/fd"'*) printf '%s\n' "$MOCK_REMOTE_DB";;
  *) exec "$@";;
esac
EOF
cat >"$tmp/bin/herdr" <<'EOF'
#!/bin/sh
printf '%s\n' '{"result":{"agents":[{"name":"ds-card1","agent_status":"working"}]}}'
EOF
chmod +x "$tmp/bin/"*

cat >"$tmp/mock_server.py" <<'PY'
import json,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = ({"pool":{"totalActive":1,"totalQueued":0,"totalCapacity":32,"utilization":0.03125},
                 "backends":{"codex":{"active":1,"max":32,"queued":0}}}
                if self.path == "/queue" else {"backends":{"codex":{"status":"up"}}})
        raw=json.dumps(body).encode(); self.send_response(200); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self,*args): pass
HTTPServer(("0.0.0.0",int(sys.argv[1])),Handler).serve_forever()
PY
port=$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()
PY
)
python3 "$tmp/mock_server.py" "$port" & server_pid=$!
host_ip=$(hostname -I | awk '{print $1}')
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$port/queue" >/dev/null 2>&1 && break; sleep .05; done

now=$(date +%s); iso=$(date -u +%FT%TZ)
printf '{"host":"n1","ts":%s,"workers":[{"card_id":"card1","owner":"noncanonical-owner","lane":"deepseek"},"bad-worker"]}' "$now" >"$tmp/cap/evidence/fleet-live/n1.json"
printf '[]' >"$tmp/cap/evidence/fleet-live/not-object.json"
printf '{bad json' >"$tmp/cap/evidence/fleet-live/malformed.json"
printf 'LAUNCHED|n1|x|card1|lane=deepseek\nLAUNCH_FAILED|n1|x|card2\nWORKSPACE_BLOCKED|n1|x|why\nPOOL_AUTHORITY|n1|source=POOL_V2|ready=7|legacy_ready=8\nPOOL_V2|n1|population=10|ready=7|ineligible=3|reasons={"dependency":2,"backoff":1}\nSLOTS|n1|codex=0/30 glm=0/9|total_free=39\nCYCLE_RECEIPT|n1|seat=niobe|launched=1|attempted=2|receipts=1\n' >"$tmp/cap/evidence/fleet-rotation/run/actions.log"
printf '{"name":"node-n1","spec":{"address":{"hostname":"n1"},"cordoned":false}}' >"$tmp/cap/fleet/objects/node/node-n1.json"
printf '"not-an-object"' >"$tmp/cap/fleet/objects/node/bad.json"
printf '{"ts":"%s"}' "$iso" >"$tmp/cap/fleet/status/node-n1/heartbeat.json"
printf '%s\n' '{"event":"owner_backend_down"}' '{"event":"context_overflow"}' >"$tmp/journal.log"
printf '{"ts":"%s","event":"semantic_cache.shadow","observed":10,"would_hit":7,"similarity":0.92,"embed_ms":4}\n' "$iso" >"$tmp/audit.jsonl"

touch -d now "$tmp/cap/evidence/fleet-rotation/run/actions.log"
out=$(HOME="$tmp/home" SKCAPSTONE_HOME="$tmp/cap" MOCK_REMOTE_DB="$tmp/remote.db" \
  SKGW_GATEWAY_URL="http://$host_ip:$port" SKGW_JOURNAL_FILE="$tmp/journal.log" \
  SKGW_AUDIT="$tmp/audit.jsonl" NO_PROXY="$host_ip,127.0.0.1,localhost" no_proxy="$host_ip,127.0.0.1,localhost" \
  PATH="$tmp/bin:$PATH" "$ROOT/scripts/skgw-lanes" 60)

grep -q "metrics source: $host_ip:$tmp/remote.db" <<<"$out"
grep -q 'codex.*sk-codex-mid.*1' <<<"$out"
! grep -q 'local-stale' <<<"$out"
grep -q 'pool active=1 queued=0 capacity=32 utilization=3%' <<<"$out"
grep -q 'codex.*1/32.*health=up.*state=active' <<<"$out"
grep -q 'n1.*deepseek.*card=card1' <<<"$out"
grep -q 'launches: deepseek=1' <<<"$out"
grep -q 'failures: LAUNCH_FAILED=1' <<<"$out"
grep -q 'blockers: WORKSPACE_BLOCKED=1' <<<"$out"
grep -q 'node-n1.*Ready.*workers=1.*rotation=recent' <<<"$out"
grep -q 'n1.*eligible=7.*attempted=2.*launched=1' <<<"$out"
grep -q 'ineligible: dependency=2 backoff=1' <<<"$out"
grep -q 'deepseek.*working=1' <<<"$out"
grep -q 'owner_backend_down.*1' <<<"$out"
grep -q 'context_overflow.*1' <<<"$out"
grep -q 'observed=10 would_hit=7 (70.0% upper bound)' <<<"$out"
grep -q 'fleet-live files=2' <<<"$out"
grep -q 'fleet-live workers=1' <<<"$out"
grep -q 'node files=1' <<<"$out"
echo 'skgw-lanes test: PASS'
