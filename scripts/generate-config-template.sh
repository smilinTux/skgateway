#!/usr/bin/env bash
#
# generate-config-template.sh: regenerate the contents of the public
# smilinTux/skgateway-config-template repo from this repo's
# deploy/example-config-repo/, the single source of truth (task G2b).
#
# Usage:
#   scripts/generate-config-template.sh <output-dir>
#
# Copies deploy/example-config-repo/ verbatim into <output-dir>: no
# placeholder substitution happens here because deploy/example-config-repo/
# already contains nothing but placeholders. Used both to publish/update the
# template repo by hand and by the CI drift check
# (.github/workflows/config-template-drift.yml), which runs this against a
# fresh checkout and diffs the result against the published template repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../deploy/example-config-repo"
OUT="${1:?usage: generate-config-template.sh <output-dir>}"

[ -d "$SRC" ] || { echo "generate-config-template.sh: error: missing source: $SRC" >&2; exit 2; }

mkdir -p "$OUT"
# Clear OUT first so a stale file left over from a previous run (e.g. one
# since removed from the source) doesn't survive the diff undetected.
find "$OUT" -mindepth 1 -delete
cp -a "$SRC"/. "$OUT"/
