#!/usr/bin/env bash
#
# build-immutable-bundle.sh
# Creates an immutable, reproducible runtime bundle for SKGateway or SKCounter
#
# Usage: build-immutable-bundle.sh <repo-path> <commit> <output-dir>
#
# Environment variables:
#   SKG_BUNDLE_SIGN_KEY  - GPG key ID for signing (optional)
#   NODE_VERSION         - Node version to require (default: auto-detect)
#

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
fatal() { log_error "$1"; exit 1; }

# Validate arguments
if [ $# -lt 2 ]; then
  cat << USAGE
Usage: $0 <repo-path> <commit> [output-dir]

Arguments:
  repo-path    Path to git repository (e.g., /home/skuser01/work/skgateway)
  commit       Git commit SHA or tag to bundle
  output-dir   Directory to write bundle (default: ./bundles)

Environment:
  SKG_BUNDLE_SIGN_KEY  GPG key ID for bundle signing
  NODE_VERSION         Node version to require (default: auto-detect)

Example:
  $0 /home/skuser01/work/skgateway 7231a0ab298c1787b5ae654516835c67082de8d5 /tmp/bundles
USAGE
  exit 1
fi

REPO_PATH="$1"
COMMIT="$2"
OUTPUT_DIR="${3:-./bundles}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_HOST=$(hostname)
BUILD_USER=$(whoami)

# Validate repo path
if [ ! -d "$REPO_PATH/.git" ]; then
  fatal "Not a git repository: $REPO_PATH"
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Create temp build directory
BUILD_DIR=$(mktemp -d -t skg-bundle-XXXXXX)
trap "rm -rf $BUILD_DIR" EXIT

log_info "Building bundle for commit: $COMMIT"
log_info "Build directory: $BUILD_DIR"

# Clone repo at exact commit
log_info "Cloning repository at exact commit..."
git clone --no-local --depth 1 "$REPO_PATH" "$BUILD_DIR/repo" 2>/dev/null || \
  git clone --depth 1 "$REPO_PATH" "$BUILD_DIR/repo"

cd "$BUILD_DIR/repo"
git fetch origin "$COMMIT" 2>/dev/null || true
git checkout -q "$COMMIT"
git reset --hard "$COMMIT"

# Get repo info
FULL_COMMIT=$(git rev-parse HEAD)
SHORT_COMMIT=$(git rev-parse --short=12 HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
REMOTE=$(git config --get remote.origin.url || echo "unknown")

# Store SHORT_COMMIT early for use in bundle_id
SOURCE_COMMIT="$SHORT_COMMIT"

# Read package.json
if [ -f "package.json" ]; then
  VERSION=$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || echo "0.0.0")
  NAME=$(node -e 'console.log(require("./package.json").name)' 2>/dev/null || echo "unknown")
else
  VERSION="0.0.0"
  NAME="unknown"
fi

BUNDLE_NAME="${NAME}-${VERSION}-${SHORT_COMMIT}"
BUNDLE_DIR="$BUILD_DIR/$BUNDLE_NAME"
mkdir -p "$BUNDLE_DIR"

# Fixed timestamp for reproducible builds
FIXED_TIMESTAMP="2024-01-01T00:00:00Z"

log_info "Bundle name: $BUNDLE_NAME"

# Detect Node version
if [ -n "${NODE_VERSION:-}" ]; then
  DETECTED_NODE="$NODE_VERSION"
else
  DETECTED_NODE=$(node --version 2>/dev/null | sed 's/v//' || echo "unknown")
fi

# Step 1: Create SOURCE.tar.gz
log_info "Creating SOURCE.tar.gz..."
tar -czf "$BUNDLE_DIR/SOURCE.tar.gz" \
  --mtime "$FIXED_TIMESTAMP" \
  --exclude .git \
  --exclude node_modules \
  --exclude .npm \
  --exclude .cache \
  --exclude '*.log' \
  --exclude .DS_Store \
  .

SOURCE_SHA256=$(sha256sum "$BUNDLE_DIR/SOURCE.tar.gz" | awk '{print $1}')

# Step 2: Install dependencies reproducibly
log_info "Installing dependencies with npm ci..."
if [ -f "package.json" ] && [ -f "package-lock.json" ]; then
  cp package.json package-lock.json "$BUNDLE_DIR/"

  # Create minimal package.json for ci install
  mkdir -p "$BUILD_DIR/ci-build"
  cp package.json package-lock.json "$BUILD_DIR/ci-build/"
  cd "$BUILD_DIR/ci-build"

  npm ci --legacy-peer-deps --quiet 2>&1 | grep -v 'npm WARN' || true

  # Package node_modules
  log_info "Packaging node_modules..."
  tar -czf "$BUNDLE_DIR/RUNTIME.tar.gz" \
    --mtime "$FIXED_TIMESTAMP" \
    --exclude node_modules/.cache \
    --exclude '*/.bin/*' \
    node_modules/

  cd - > /dev/null
else
  log_warn "No package.json found, skipping dependencies"
  touch "$BUNDLE_DIR/RUNTIME.tar.gz"
fi

RUNTIME_SHA256=$(sha256sum "$BUNDLE_DIR/RUNTIME.tar.gz" | awk '{print $1}')

# Step 3: Collect file inventory
log_info "Creating file inventory..."
cd "$BUILD_DIR/repo"
INVENTORY_FILE="$BUNDLE_DIR/INVENTORY.txt"
find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path './.npm/*' \
  -not -path './test*' \
  -not -path './.cache/*' \
  | sort \
  | while read -r file; do
    sha=$(sha256sum "$file" 2>/dev/null | awk '{print $1}' || echo "skipped")
    printf "%s  %s\n" "$sha" "$file"
  done > "$INVENTORY_FILE"

FILE_COUNT=$(wc -l < "$INVENTORY_FILE")
INVENTORY_SHA256=$(sha256sum "$INVENTORY_FILE" | awk '{print $1}')

# Step 4: Extract dependency versions
log_info "Extracting dependency metadata..."
if [ -f "package.json" ]; then
  DEPS_JSON=$(node -e '
    const pkg = require("./package.json");
    const deps = pkg.dependencies || {};
    const result = {};
    for (const [name, version] of Object.entries(deps)) {
      // Extract exact version from package-lock.json
      try {
        const lock = require("./package-lock.json");
        const lockEntry = lock.packages?.["node_modules/" + name];
        if (lockEntry) {
          result[name] = lockEntry.version;
        } else {
          result[name] = version;
        }
      } catch (e) {
        result[name] = version;
      }
    }
    console.log(JSON.stringify(result, null, 2));
  ' 2>/dev/null || echo '{}')
else
  DEPS_JSON='{}'
fi

# Step 5: Create MANIFEST.json
log_info "Creating MANIFEST.json..."
cat > "$BUNDLE_DIR/MANIFEST.json" << MANIFEST
{
  "bundle_format": "skgateway-runtime-v1",
  "bundle_id": "$BUNDLE_NAME",
  "created_at": "$FIXED_TIMESTAMP",
  "created_by": "skcapstone-builder",
  "source_repository": "$REMOTE",
  "source_commit": "$FULL_COMMIT",
  "source_branch": "$BRANCH",
  "version": "$VERSION",
  "node_version": "$DETECTED_NODE",
  "dependencies": $DEPS_JSON,
  "files": {
    "count": $FILE_COUNT,
    "sha256": "$INVENTORY_SHA256"
  },
  "artifacts": {
    "source": {
      "file": "SOURCE.tar.gz",
      "sha256": "$SOURCE_SHA256"
    },
    "runtime": {
      "file": "RUNTIME.tar.gz",
      "sha256": "$RUNTIME_SHA256"
    }
  },
  "entry_point": "src/index.mjs",
  "runtime_requirements": {
    "node": ">=22.0.0",
    "platform": "linux-x64"
  }
}
MANIFEST

MANIFEST_SHA256=$(sha256sum "$BUNDLE_DIR/MANIFEST.json" | awk '{print $1}')

# Step 6: Create CHECKSUMS.sha256
log_info "Creating CHECKSUMS.sha256..."
(
  echo "# Checksums for bundle $BUNDLE_NAME"
  echo "# Generated: $FIXED_TIMESTAMP"
  cd "$BUNDLE_DIR"
  sha256sum MANIFEST.json SOURCE.tar.gz RUNTIME.tar.gz INVENTORY.txt
) > "$BUNDLE_DIR/CHECKSUMS.sha256"

CHECKSUMS_SHA256=$(sha256sum "$BUNDLE_DIR/CHECKSUMS.sha256" | awk '{print $1}')

# Step 7: Create sealed bundle
log_info "Creating sealed bundle archive..."
cd "$BUILD_DIR"
tar -czf "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz" \
  --mtime "$FIXED_TIMESTAMP" \
  "$BUNDLE_NAME/"

BUNDLE_SHA256=$(sha256sum "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz" | awk '{print $1}')
BUNDLE_SIZE=$(stat -c%s "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz")

# Step 8: Sign bundle if GPG key provided
if [ -n "${SKG_BUNDLE_SIGN_KEY:-}" ]; then
  log_info "Signing bundle with GPG key: $SKG_BUNDLE_SIGN_KEY"
  cd "$OUTPUT_DIR"
  sha256sum "${BUNDLE_NAME}.tar.gz" > "${BUNDLE_NAME}.sha256"
  gpg --detach-sign --armor --local-user "$SKG_BUNDLE_SIGN_KEY" \
    --output "${BUNDLE_NAME}.sha256.asc" "${BUNDLE_NAME}.sha256" || {
    log_warn "GPG signing failed, continuing without signature"
  }
fi

# Step 9: Create bundle metadata
log_info "Creating bundle metadata..."
cat > "$OUTPUT_DIR/${BUNDLE_NAME}.json" << METADATA
{
  "bundle_format": "skgateway-runtime-v1",
  "bundle_id": "$BUNDLE_NAME",
  "bundle_file": "${BUNDLE_NAME}.tar.gz",
  "bundle_size_bytes": $BUNDLE_SIZE,
  "bundle_sha256": "$BUNDLE_SHA256",
  "created_at": "$TIMESTAMP",
  "created_by": "${BUILD_USER}@${BUILD_HOST}",
  "source_repository": "$REMOTE",
  "source_commit": "$FULL_COMMIT",
  "source_branch": "$BRANCH",
  "version": "$VERSION",
  "node_version": "$DETECTED_NODE",
  "manifest_sha256": "$MANIFEST_SHA256",
  "checksums_sha256": "$CHECKSUMS_SHA256",
  "signed": $([ -f "$OUTPUT_DIR/${BUNDLE_NAME}.sha256.asc" ] && echo "true" || echo "false")
}
METADATA

# Success
log_info ""
log_info "=========================================="
log_info "Bundle created successfully!"
log_info "=========================================="
log_info "Bundle ID:        $BUNDLE_NAME"
log_info "Bundle File:      $OUTPUT_DIR/${BUNDLE_NAME}.tar.gz"
log_info "Bundle Size:      $BUNDLE_SIZE bytes"
log_info "Bundle SHA256:    $BUNDLE_SHA256"
log_info "Source Commit:    $FULL_COMMIT"
log_info "Version:          $VERSION"
log_info "Node Version:     $DETECTED_NODE"
log_info "Files:            $FILE_COUNT"
log_info "Signed:           $([ -f "$OUTPUT_DIR/${BUNDLE_NAME}.sha256.asc" ] && echo "yes" || echo "no")"
log_info "=========================================="
log_info ""
log_info "Verify with:"
log_info "  sha256sum ${BUNDLE_NAME}.tar.gz"
log_info "  tar -tzf ${BUNDLE_NAME}.tar.gz | head"
log_info "  tar -xzf ${BUNDLE_NAME}.tar.gz && cat ${BUNDLE_NAME}/MANIFEST.json"
log_info ""

exit 0
