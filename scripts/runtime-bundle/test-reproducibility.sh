#!/usr/bin/env bash
#
# test-reproducibility.sh
# Verifies that two builds from the same commit produce byte-identical bundles
#
# Usage: test-reproducibility.sh <repo-path> <commit>
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ $# -lt 2 ]; then
  echo "Usage: $0 <repo-path> <commit>"
  exit 1
fi

REPO_PATH="$1"
COMMIT="$2"
BUILD_SCRIPT="$(dirname "$0")/build-immutable-bundle.sh"

if [ ! -f "$BUILD_SCRIPT" ]; then
  echo "Error: Build script not found: $BUILD_SCRIPT"
  exit 1
fi

# Make executable
chmod +x "$BUILD_SCRIPT"

# Create temp directory for builds
BUILD_DIR=$(mktemp -d -t skg-repro-XXXXXX)
trap "rm -rf $BUILD_DIR" EXIT

log_info "Testing reproducibility for commit: $COMMIT"
log_info "Build directory: $BUILD_DIR"
log_info ""

# Build first bundle
log_info "Building first bundle..."
BUNDLE1_DIR="$BUILD_DIR/build1"
mkdir -p "$BUNDLE1_DIR"
"$BUILD_SCRIPT" "$REPO_PATH" "$COMMIT" "$BUNDLE1_DIR" > /dev/null 2>&1

BUNDLE1=$(find "$BUNDLE1_DIR" -name "*.tar.gz" | head -1)
BUNDLE1_SHA256=$(sha256sum "$BUNDLE1" | awk '{print $1}')
BUNDLE1_SIZE=$(stat -c%s "$BUNDLE1")

log_info "  Bundle 1: $(basename "$BUNDLE1")"
log_info "  SHA256:   $BUNDLE1_SHA256"
log_info "  Size:     $BUNDLE1_SIZE bytes"
log_info ""

# Wait 1 second to ensure different timestamps
sleep 1

# Build second bundle
log_info "Building second bundle..."
BUNDLE2_DIR="$BUILD_DIR/build2"
mkdir -p "$BUNDLE2_DIR"
"$BUILD_SCRIPT" "$REPO_PATH" "$COMMIT" "$BUNDLE2_DIR" > /dev/null 2>&1

BUNDLE2=$(find "$BUNDLE2_DIR" -name "*.tar.gz" | head -1)
BUNDLE2_SHA256=$(sha256sum "$BUNDLE2" | awk '{print $1}')
BUNDLE2_SIZE=$(stat -c%s "$BUNDLE2")

log_info "  Bundle 2: $(basename "$BUNDLE2")"
log_info "  SHA256:   $BUNDLE2_SHA256"
log_info "  Size:     $BUNDLE2_SIZE bytes"
log_info ""

# Compare
log_info "=========================================="
log_info "Comparison Results"
log_info "=========================================="

if [ "$BUNDLE1_SHA256" = "$BUNDLE2_SHA256" ]; then
  log_info "✓ SHA256: MATCH"
else
  log_error "✗ SHA256: MISMATCH"
fi

if [ "$BUNDLE1_SIZE" = "$BUNDLE2_SIZE" ]; then
  log_info "✓ Size:   MATCH"
else
  log_error "✗ Size:   MISMATCH"
fi

if cmp -s "$BUNDLE1" "$BUNDLE2"; then
  log_info "✓ Bytes:  IDENTICAL"
  log_info "=========================================="
  log_info ""
  log_info "SUCCESS: Two clean builds produce byte-identical sealed bundles"
  log_info ""
  exit 0
else
  log_error "✗ Bytes:  DIFFER"
  log_info "=========================================="
  log_info ""
  log_error "FAILURE: Bundles differ - reproducibility not achieved"
  log_info ""

  # Show differences
  log_info "Analyzing differences..."
  EXTRACT1=$(mktemp -d)
  EXTRACT2=$(mktemp -d)
  trap "rm -rf $BUILD_DIR $EXTRACT1 $EXTRACT2" EXIT

  tar -xzf "$BUNDLE1" -C "$EXTRACT1"
  tar -xzf "$BUNDLE2" -C "$EXTRACT2"

  DIR1=$(find "$EXTRACT1" -mindepth 1 -maxdepth 1 -type d)
  DIR2=$(find "$EXTRACT2" -mindepth 1 -maxdepth 1 -type d)

  log_info "Comparing MANIFEST.json..."
  if ! diff -q "$DIR1/MANIFEST.json" "$DIR2/MANIFEST.json"; then
    log_warn "  MANIFEST.json differs"
  fi

  log_info "Comparing SOURCE.tar.gz..."
  if ! cmp -s "$DIR1/SOURCE.tar.gz" "$DIR2/SOURCE.tar.gz"; then
    log_warn "  SOURCE.tar.gz differs"
  fi

  log_info "Comparing RUNTIME.tar.gz..."
  if ! cmp -s "$DIR1/RUNTIME.tar.gz" "$DIR2/RUNTIME.tar.gz"; then
    log_warn "  RUNTIME.tar.gz differs"
  fi

  log_info "Comparing CHECKSUMS.sha256..."
  if ! diff -q "$DIR1/CHECKSUMS.sha256" "$DIR2/CHECKSUMS.sha256"; then
    log_warn "  CHECKSUMS.sha256 differs"
  fi

  exit 1
fi
