#!/usr/bin/env bash
#
# build-skcounter-bundle.sh
# Creates an immutable runtime bundle for SKCounter
# SKCounter is Python-based, so bundling differs from Node.js SKGateway
#
# Usage: build-skcounter-bundle.sh <repo-path> <commit> <output-dir>
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

if [ $# -lt 2 ]; then
  echo "Usage: $0 <repo-path> <commit> [output-dir]"
  exit 1
fi

REPO_PATH="$1"
COMMIT="$2"
OUTPUT_DIR="${3:-./bundles}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_HOST=$(hostname)
BUILD_USER=$(whoami)

if [ ! -d "$REPO_PATH/.git" ]; then
  fatal "Not a git repository: $REPO_PATH"
fi

mkdir -p "$OUTPUT_DIR"

BUILD_DIR=$(mktemp -d -t skc-bundle-XXXXXX)
trap "rm -rf $BUILD_DIR" EXIT

log_info "Building SKCounter bundle for commit: $COMMIT"

# Clone repo at exact commit
log_info "Cloning repository at exact commit..."
git clone --no-local --depth 1 "$REPO_PATH" "$BUILD_DIR/repo" 2>/dev/null || \
  git clone --depth 1 "$REPO_PATH" "$BUILD_DIR/repo"

cd "$BUILD_DIR/repo"
git fetch origin "$COMMIT" 2>/dev/null || true
git checkout -q "$COMMIT"
git reset --hard "$COMMIT"

FULL_COMMIT=$(git rev-parse HEAD)
SHORT_COMMIT=$(git rev-parse --short=12 HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
REMOTE=$(git config --get remote.origin.url || echo "unknown")

# Read version
if [ -f "pyproject.toml" ]; then
  VERSION=$(grep "^version" pyproject.toml | head -1 | sed 's/version = "\([^"]*\)"/\1/' || echo "0.0.0")
  NAME="skcounter"
else
  VERSION="0.0.0"
  NAME="skcounter"
fi

BUNDLE_NAME="${NAME}-${VERSION}-${SHORT_COMMIT}"
BUNDLE_DIR="$BUILD_DIR/$BUNDLE_NAME"
mkdir -p "$BUNDLE_DIR"

log_info "Bundle name: $BUNDLE_NAME"

# Detect Python version
PYTHON_VERSION=$(python3 --version 2>/dev/null | sed 's/Python //' || echo "unknown")

# Step 1: Create SOURCE.tar.gz
log_info "Creating SOURCE.tar.gz..."
tar -czf "$BUNDLE_DIR/SOURCE.tar.gz" \
  --exclude .git \
  --exclude __pycache__ \
  --exclude '*.pyc' \
  --exclude .pytest_cache \
  --exclude .mypy_cache \
  --exclude .ruff_cache \
  --exclude '*.egg-info' \
  --exclude build \
  --exclude dist \
  .

SOURCE_SHA256=$(sha256sum "$BUNDLE_DIR/SOURCE.tar.gz" | awk '{print $1}')

# Step 2: Capture Python dependencies
log_info "Capturing Python dependencies..."
if [ -f "requirements.txt" ]; then
  cp requirements.txt "$BUNDLE_DIR/requirements.txt"
  DEPS=$(cat requirements.txt | grep -v '^#' | grep -v '^$' | wc -l)
else
  touch "$BUNDLE_DIR/requirements.txt"
  DEPS=0
fi

# Create venv and freeze requirements
log_info "Creating Python environment and freezing dependencies..."
python3 -m venv "$BUILD_DIR/venv" > /dev/null 2>&1 || {
  log_warn "Could not create venv, using system python"
  DEPS_JSON='{}'
}

if [ -d "$BUILD_DIR/venv" ]; then
  source "$BUILD_DIR/venv/bin/activate"
  if [ -f "requirements.txt" ]; then
    pip install -q --upgrade pip
    pip install -q -r requirements.txt 2>/dev/null || log_warn "Some dependencies failed to install"
  fi
  pip freeze > "$BUNDLE_DIR/freeze.txt" 2>/dev/null || true

  # Create dependency JSON
  DEPS_JSON=$(python3 << 'PY'
import sys
try:
    with sys.stdin if False else open("freeze.txt") as f:
        deps = {}
        for line in f:
            line = line.strip()
            if line and not line.startswith('-') and '==' in line:
                name, version = line.split('==', 1)
                deps[name] = version
        import json
        print(json.dumps(deps, indent=2))
except:
    print('{}')
PY
)
  deactivate
fi

# Package venv
if [ -d "$BUILD_DIR/venv" ]; then
  log_info "Packaging Python environment..."
  cd "$BUILD_DIR"
  tar -czf "$BUNDLE_DIR/RUNTIME.tar.gz" \
    --exclude venv/lib/python*/site-packages/*.dist-info/__pycache__ \
    --exclude venv/lib/python*/site-packages/*/__pycache__ \
    venv/
  cd - > /dev/null
else
  touch "$BUNDLE_DIR/RUNTIME.tar.gz"
fi

RUNTIME_SHA256=$(sha256sum "$BUNDLE_DIR/RUNTIME.tar.gz" | awk '{print $1}')

# Step 3: File inventory
log_info "Creating file inventory..."
cd "$BUILD_DIR/repo"
find . -type f \
  -not -path './.git/*' \
  -not -path './__pycache__/*' \
  -not -path './.pytest_cache/*' \
  -not -path './.mypy_cache/*' \
  | sort \
  | while read -r file; do
    sha=$(sha256sum "$file" 2>/dev/null | awk '{print $1}' || echo "skipped")
    printf "%s  %s\n" "$sha" "$file"
  done > "$BUNDLE_DIR/INVENTORY.txt"

FILE_COUNT=$(wc -l < "$BUNDLE_DIR/INVENTORY.txt")
INVENTORY_SHA256=$(sha256sum "$BUNDLE_DIR/INVENTORY.txt" | awk '{print $1}')

# Step 4: Create MANIFEST.json
log_info "Creating MANIFEST.json..."
cat > "$BUNDLE_DIR/MANIFEST.json" << MANIFEST
{
  "bundle_format": "skcounter-runtime-v1",
  "bundle_id": "$BUNDLE_NAME",
  "created_at": "$TIMESTAMP",
  "created_by": "${BUILD_USER}@${BUILD_HOST}",
  "source_repository": "$REMOTE",
  "source_commit": "$FULL_COMMIT",
  "source_branch": "$BRANCH",
  "version": "$VERSION",
  "python_version": "$PYTHON_VERSION",
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
  "entry_points": {
    "edge_schedule": "edge/skcounter_schedule.py",
    "run_script": "edge/run-edge.sh"
  },
  "runtime_requirements": {
    "python": ">=3.10.0",
    "platform": "linux"
  }
}
MANIFEST

MANIFEST_SHA256=$(sha256sum "$BUNDLE_DIR/MANIFEST.json" | awk '{print $1}')

# Step 5: Create CHECKSUMS.sha256
log_info "Creating CHECKSUMS.sha256..."
(
  echo "# Checksums for bundle $BUNDLE_NAME"
  echo "# Generated: $TIMESTAMP"
  sha256sum "$BUNDLE_DIR/MANIFEST.json"
  sha256sum "$BUNDLE_DIR/SOURCE.tar.gz"
  sha256sum "$BUNDLE_DIR/RUNTIME.tar.gz"
  sha256sum "$BUNDLE_DIR/INVENTORY.txt"
  [ -f "$BUNDLE_DIR/requirements.txt" ] && sha256sum "$BUNDLE_DIR/requirements.txt"
  [ -f "$BUNDLE_DIR/freeze.txt" ] && sha256sum "$BUNDLE_DIR/freeze.txt"
) > "$BUNDLE_DIR/CHECKSUMS.sha256"

CHECKSUMS_SHA256=$(sha256sum "$BUNDLE_DIR/CHECKSUMS.sha256" | awk '{print $1}')

# Step 6: Create sealed bundle
log_info "Creating sealed bundle archive..."
cd "$BUILD_DIR"
tar -czf "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz" "$BUNDLE_NAME/"

BUNDLE_SHA256=$(sha256sum "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz" | awk '{print $1}')
BUNDLE_SIZE=$(stat -c%s "$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz")

# Step 7: Create bundle metadata
log_info "Creating bundle metadata..."
cat > "$OUTPUT_DIR/${BUNDLE_NAME}.json" << METADATA
{
  "bundle_format": "skcounter-runtime-v1",
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
  "python_version": "$PYTHON_VERSION",
  "manifest_sha256": "$MANIFEST_SHA256",
  "checksums_sha256": "$CHECKSUMS_SHA256",
  "dependencies_count": $DEPS
}
METADATA

log_info ""
log_info "=========================================="
log_info "SKCounter Bundle Created"
log_info "=========================================="
log_info "Bundle ID:        $BUNDLE_NAME"
log_info "Bundle File:      $OUTPUT_DIR/${BUNDLE_NAME}.tar.gz"
log_info "Bundle Size:      $BUNDLE_SIZE bytes"
log_info "Bundle SHA256:    $BUNDLE_SHA256"
log_info "Source Commit:    $FULL_COMMIT"
log_info "Version:          $VERSION"
log_info "Python Version:   $PYTHON_VERSION"
log_info "Dependencies:     $DEPS"
log_info "Files:            $FILE_COUNT"
log_info "=========================================="

exit 0
