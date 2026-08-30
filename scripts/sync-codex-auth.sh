#!/usr/bin/env bash
# Copy a Codex CLI credential file from its read-only owner to a local gateway.
# The source remains authoritative. This script never writes back to it.
set -euo pipefail

SOURCE="${SKGATEWAY_CODEX_AUTH_SOURCE:-${1:-}}"
DESTINATION="${SKGATEWAY_CODEX_AUTH_DEST:-${2:-}}"

if [[ -z "$SOURCE" || -z "$DESTINATION" ]]; then
  echo "usage: sync-codex-auth.sh SOURCE ABSOLUTE_DESTINATION" >&2
  exit 64
fi
if [[ "$SOURCE" == -* || "$SOURCE" == *$'\n'* ]]; then
  echo "refusing unsafe credential source" >&2
  exit 64
fi
if [[ "$DESTINATION" != /* || "$DESTINATION" == *$'\n'* ]]; then
  echo "credential destination must be an absolute path" >&2
  exit 64
fi

destination_dir="$(dirname -- "$DESTINATION")"
if [[ ! -d "$destination_dir" || -L "$destination_dir" ]]; then
  echo "credential destination directory must exist and must not be a symlink" >&2
  exit 65
fi
if [[ -L "$DESTINATION" || ( -e "$DESTINATION" && ! -f "$DESTINATION" ) ]]; then
  echo "credential destination must be a regular file, not a symlink" >&2
  exit 65
fi

temporary="$(mktemp "$destination_dir/.codex-auth.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT HUP INT TERM

scp -q -o BatchMode=yes -o ConnectTimeout=10 -- "$SOURCE" "$temporary"
python3 - "$temporary" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
tokens = document.get("tokens") or {}
if not isinstance(tokens.get("access_token"), str) or not tokens["access_token"]:
    raise SystemExit("synced Codex credential has no access_token")
PY

chmod 600 "$temporary"
mv -f -- "$temporary" "$DESTINATION"
trap - EXIT HUP INT TERM
