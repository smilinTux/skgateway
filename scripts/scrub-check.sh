#!/usr/bin/env bash
#
# scrub-check.sh: fail if any file under the given path(s) contains what
# looks like a real fleet hostname, domain or private IP, as opposed to a
# placeholder. Guards published, public content (the config-template source
# at deploy/example-config-repo/) against accidentally leaking a real
# infrastructure identifier. This is NOT a secrets scanner (see
# .github/workflows/secret-scan.yml / gitleaks for that); it only looks for
# identifiers that reveal real topology.
#
# Usage:
#   scripts/scrub-check.sh <path>...
#
# Exits 1 and prints every match to stderr if anything is found, 0 otherwise.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: scrub-check.sh <path>..." >&2; exit 2; }

# Private IP ranges that could point at real SK* infrastructure:
# 10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12.
PRIVATE_IP_RE='\b(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})\b'

# Allowed "documentation" addresses: RFC 5737 TEST-NET-1/2/3 (not actually
# private, but harmless to allow-list here too) plus a short list of generic
# placeholder addresses that show up in illustrative examples everywhere and
# identify no real SK* host.
DOC_IP_ALLOW_RE='^(192\.0\.2\.[0-9]{1,3}|198\.51\.100\.[0-9]{1,3}|203\.0\.113\.[0-9]{1,3}|192\.168\.1\.1|192\.168\.0\.1|10\.0\.0\.1|10\.0\.0\.2|172\.16\.0\.1)$'

# Real fleet domains. A bare "example.<domain>" hostname is exempt (RFC
# 2606-style placeholder), everything else under these suffixes is not.
DOMAIN_RE='([A-Za-z0-9-]+\.)*(douno\.it|nativeassetmanagement\.com|skworld\.io)'
DOMAIN_EXEMPT_RE='(^|[^A-Za-z0-9.-])example\.(douno\.it|nativeassetmanagement\.com|skworld\.io)'

found=0

check_file() {
  local f="$1"

  while IFS=: read -r lineno rest; do
    [ -n "$lineno" ] || continue
    local ip
    ip="$(printf '%s\n' "$rest" | grep -oE "$PRIVATE_IP_RE" | head -n1)"
    [ -n "$ip" ] || continue
    if printf '%s\n' "$ip" | grep -qE "$DOC_IP_ALLOW_RE"; then
      continue
    fi
    echo "SCRUB: $f:$lineno: possible real private IP ($ip): $rest" >&2
    found=1
  done < <(grep -nE "$PRIVATE_IP_RE" "$f" 2>/dev/null || true)

  while IFS=: read -r lineno rest; do
    [ -n "$lineno" ] || continue
    echo "SCRUB: $f:$lineno: possible real fleet domain: $rest" >&2
    found=1
  done < <(grep -nE "$DOMAIN_RE" "$f" 2>/dev/null | grep -vE "$DOMAIN_EXEMPT_RE" || true)
}

while IFS= read -r -d '' f; do
  check_file "$f"
done < <(find "$@" -type f -print0)

exit "$found"
