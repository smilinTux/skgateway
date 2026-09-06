#!/usr/bin/env bash
# Sync the Codex CLI credential from the host where a human actually runs
# `codex login` into the credential the staged skgateway-codex instance reads.
#
# WHY THIS EXISTS, and why it failing silently was expensive: the gateway holds
# its own copy of the credential, separate from ~/.codex/auth.json. On
# 2026-08-27 the unit that runs this script had been failing 203/EXEC because
# the script was missing entirely, so the gateway kept serving from a credential
# last refreshed 2026-08-24, belonging to a DIFFERENT ChatGPT account than the
# one the operator had logged into. Nothing alerted. The gateway looked healthy
# because the access token had not expired yet, while the account behind it was
# out of quota.
#
# So this script fails LOUDLY and refuses to install anything it cannot verify.
set -euo pipefail

SRC_HOST="${CODEX_AUTH_SRC_HOST:-local}"
SRC_PATH="${CODEX_AUTH_SRC_PATH:-.codex/auth.json}"
DEST="${CODEX_AUTH_DEST:-$HOME/skgateway-codex/secrets/codex-auth.json}"
UNIT="${CODEX_GATEWAY_UNIT:-skgateway-codex}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# SRC_HOST=local reads this host's own ~/.codex/auth.json. That is the right
# source whenever a human runs `codex login` ON the gateway host, because the
# Codex CLI refreshes that file in place. Copying from another host instead
# would replace a self-refreshing credential with a snapshot that goes stale.
if [ "$SRC_HOST" = "local" ]; then
    if ! cat "$HOME/${SRC_PATH}" > "$TMP" 2>/dev/null; then
        echo "FATAL: could not read local ~/${SRC_PATH}" >&2
        exit 1
    fi
    echo "  source: local ~/${SRC_PATH}"
elif ! ssh -o BatchMode=yes -o ConnectTimeout=10 "skuser01@${SRC_HOST}" \
        "cat ~/${SRC_PATH}" > "$TMP" 2>/dev/null; then
    echo "FATAL: could not read ~/${SRC_PATH} from ${SRC_HOST}" >&2
    exit 1
fi

# Refuse to install anything that is not a usable credential. A truncated or
# empty file installed over a working one takes the whole fleet down.
python3 - "$TMP" <<'PY'
import json, sys, base64, datetime
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception as exc:
    sys.exit("FATAL: source is not valid JSON: %s" % exc)
t = d.get("tokens") or {}
if not t.get("refresh_token"):
    sys.exit("FATAL: source has no refresh_token; it would expire with no way to renew")
tok = t.get("access_token") or ""
if not tok:
    sys.exit("FATAL: source has no access_token")
if tok.count(".") == 2:
    b = tok.split(".")[1]; b += "=" * (-len(b) % 4)
    exp = json.loads(base64.urlsafe_b64decode(b)).get("exp")
    if exp:
        e = datetime.datetime.fromtimestamp(exp, datetime.timezone.utc)
        if e <= datetime.datetime.now(datetime.timezone.utc):
            sys.exit("FATAL: source access_token already expired at %s" % e)
        print("  source access_token valid until %s" % e.strftime("%Y-%m-%d %H:%M UTC"))
idt = t.get("id_token") or ""
if idt.count(".") == 2:
    b = idt.split(".")[1]; b += "=" * (-len(b) % 4)
    who = json.loads(base64.urlsafe_b64decode(b)).get("email")
    if who:
        print("  source account: %s" % who)
PY

if [ -f "$DEST" ] && cmp -s "$TMP" "$DEST"; then
    echo "  credential unchanged; not restarting ${UNIT}"
    exit 0
fi

[ -f "$DEST" ] && cp -p "$DEST" "${DEST}.bak-$(date +%Y%m%d-%H%M%S)"
install -m 600 "$TMP" "$DEST"
echo "  credential updated at ${DEST}"

systemctl --user restart "$UNIT"
sleep 3
if systemctl --user is-active --quiet "$UNIT"; then
    echo "  ${UNIT} restarted and active"
else
    echo "FATAL: ${UNIT} did not come back after the credential update" >&2
    exit 1
fi
