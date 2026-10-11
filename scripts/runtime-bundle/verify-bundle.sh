#!/usr/bin/env bash
#
# verify-bundle.sh
# Verifies the integrity and authenticity of an immutable runtime bundle
#
# Usage: verify-bundle.sh <bundle-tar.gz>
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
fatal() { log_error "$1"; exit 1; }

if [ $# -lt 1 ]; then
  echo "Usage: $0 <bundle-tar.gz>"
  exit 1
fi

BUNDLE_FILE="$1"
BUNDLE_DIR=$(dirname "$BUNDLE_FILE")
BUNDLE_NAME=$(basename "$BUNDLE_FILE" .tar.gz)

log_info "Verifying bundle: $BUNDLE_FILE"
log_info "Bundle name: $BUNDLE_NAME"

# Check if bundle exists
if [ ! -f "$BUNDLE_FILE" ]; then
  fatal "Bundle file not found: $BUNDLE_FILE"
fi

# Extract to temp directory
EXTRACT_DIR=$(mktemp -d -t skg-verify-XXXXXX)
trap "rm -rf $EXTRACT_DIR" EXIT

log_info "Extracting bundle..."
tar -xzf "$BUNDLE_FILE" -C "$EXTRACT_DIR"

BUNDLE_CONTENTS="$EXTRACT_DIR/$BUNDLE_NAME"

# Verify required files exist
log_info "Verifying required files..."
for required_file in MANIFEST.json SOURCE.tar.gz RUNTIME.tar.gz CHECKSUMS.sha256 INVENTORY.txt; do
  if [ ! -f "$BUNDLE_CONTENTS/$required_file" ]; then
    fatal "Missing required file: $required_file"
  fi
  log_info "  ✓ $required_file"
done

# Verify checksums
log_info "Verifying checksums..."
cd "$BUNDLE_CONTENTS"

# Read checksums and verify
while read -r checksum filename; do
  # Skip comments
  [[ "$filename" =~ ^# ]] && continue
  [ -z "$filename" ] && continue

  if [ ! -f "$filename" ]; then
    log_warn "  File in checksums but not found: $filename"
    continue
  fi

  actual_checksum=$(sha256sum "$filename" | awk '{print $1}')
  if [ "$actual_checksum" = "$checksum" ]; then
    log_info "  ✓ $filename"
  else
    fatal "Checksum mismatch for $filename:
      Expected: $checksum
      Actual:   $actual_checksum"
  fi
done < CHECKSUMS.sha256

# Verify GPG signature if present
SIGNATURE_FILE="$BUNDLE_DIR/${BUNDLE_NAME}.sha256.asc"
CHECKSUM_FILE="$BUNDLE_DIR/${BUNDLE_NAME}.sha256"

if [ -f "$SIGNATURE_FILE" ] && [ -f "$CHECKSUM_FILE" ]; then
  log_info "Verifying GPG signature..."
  if gpg --verify "$SIGNATURE_FILE" "$CHECKSUM_FILE" 2>/dev/null; then
    log_info "  ✓ GPG signature valid"
    SIGNER=$(gpg --verify "$SIGNATURE_FILE" "$CHECKSUM_FILE" 2>&1 | grep "using" | sed 's/.*using \(.*\) key.*/\1/')
    log_info "  Signed by: $SIGNER"
  else
    log_warn "  GPG signature verification failed"
  fi
else
  log_info "  No GPG signature found (optional)"
fi

# Parse and display manifest
log_info ""
log_info "=========================================="
log_info "Bundle Manifest"
log_info "=========================================="

if command -v jq &> /dev/null; then
  jq '.' MANIFEST.json
else
  cat MANIFEST.json
fi

log_info "=========================================="
log_info ""
log_info "✓ Bundle verification passed!"
log_info "Bundle: $BUNDLE_FILE"
log_info "ID: $BUNDLE_NAME"

exit 0
