# SKGateway Immutable Runtime Bundles

This directory contains tooling for creating immutable, versioned runtime bundles for SKGateway instances.

## Overview

The bundle system addresses the critical issue where gateway instances were running from a single mutable shared directory, creating drift risk and eliminating rollback capability.

## Bundle Format

A bundle is a tarball containing:

```
skgateway-{version}-{commit}/
├── MANIFEST.json          # Metadata and provenance
├── SOURCE.tar.gz          # Source at exact commit
├── RUNTIME.tar.gz         # Dependencies (node_modules/)
├── INVENTORY.txt          # File hashes
└── CHECKSUMS.sha256       # Integrity verification
```

## Scripts

### build-immutable-bundle.sh

Creates a reproducible, immutable runtime bundle.

```bash
./build-immutable-bundle.sh <repo-path> <commit> [output-dir]
```

**Features:**
- Byte-identical reproducible builds
- Fixed timestamps for determinism
- SHA256 checksums for all artifacts
- Optional GPG signing via `SKG_BUNDLE_SIGN_KEY`

**Example:**
```bash
./build-immutable-bundle.sh \
  /home/skuser01/work/skgateway \
  7231a0ab298c1787b5ae654516835c67082de8d5 \
  /tmp/bundles
```

### verify-bundle.sh

Verifies bundle integrity and checksums.

```bash
./verify-bundle.sh <bundle-file>
```

**Example:**
```bash
./verify-bundle.sh /tmp/bundles/skgateway-0.1.0-7231a0ab298c.tar.gz
```

### test-reproducibility.sh

Tests that two independent builds produce byte-identical bundles.

```bash
./test-reproducibility.sh <repo-path> <commit>
```

### generate-deployment-manifest.sh

Creates deployment manifests for multiple gateway instances.

```bash
./generate-deployment-manifest.sh <bundle-path> [instances.json]
```

### build-skcounter-bundle.sh

Creates bundles for SKCounter (Python-based collector).

```bash
./build-skcounter-bundle.sh <repo-path> <commit> [output-dir]
```

## Architecture

### Deployment Model

1. **Immutable Storage**: Bundles stored in `/opt/skgateway/bundles/` (read-only)
2. **Activation via Symlinks**: `/opt/skgateway/active/{instance}` → bundle
3. **Data Separation**:
   - Configs: `/etc/skgateway/`
   - Data: `/var/lib/skgateway/`
4. **Rollback**: Atomic symlink swap for instant rollback

### Directory Structure

```
/opt/skgateway/
├── bundles/              # Immutable bundles (read-only)
│   └── skgateway-0.1.0-7231a0ab298c/
├── active/               # Symlinks to active bundles
│   ├── lifecycle -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   ├── authz -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   └── ...
└── rollout/              # Staging for new versions
```

### Systemd Integration

Service units use the symlink paths:

```ini
[Service]
ExecStart=/opt/skgateway/active/lifecycle/bin/node /opt/skgateway/active/lifecycle/src/index.mjs --config /etc/skgateway/lifecycle.yaml
```

## Qualification

Before deploying a new bundle to production, run qualification tests to verify:

1. **Request continuity** - Response schemas match baseline
2. **Token continuity** - Auth validation unchanged
3. **Cost continuity** - Billing attribution preserved
4. **Latency continuity** - P50/P95/P99 within thresholds
5. **Queue continuity** - Depth and drain rates stable
6. **Attribution continuity** - Agent/request tracing intact
7. **Collector continuity** - SKCounter integration working

See `criterion_3_qualification_plan.md` in the card evidence for detailed test procedures.

## Security

1. **Bundle Signing**: Optional GPG signature support
2. **Read-Only Runtime**: Bundle directories are immutable
3. **Least Privilege**: Dedicated `skgateway` user
4. **Checksum Verification**: SHA256 hashes for all artifacts

## Migration Path

### Phase 1: Bundle Creation (This Card)
- ✅ Create bundling scripts
- ✅ Generate first bundle
- ✅ Document deployment model

### Phase 2: Canary Deployment (Separate Card)
- Deploy canary to one host
- Execute qualification tests
- Fix any issues

### Phase 3: Production Rollout (Separate Card, Human Decision)
- Deploy to all hosts
- Monitor production
- Decommission mutable deployments

## Evidence Location

Bundle evidence and documentation are stored at:
```
~/.skcapstone/evidence/work/8f2d6a10/
```

## Related Cards

- **8f2d6a10**: SKGATEWAY-IMMUTABLE-NODE-RUNTIME-01 (this card)
- Subsequent cards for multi-host inventory
- Canary deployment card for qualification
- Production rollout card (human decision)

## Contact

Card: 8f2d6a10
Agent: pi-glm-chiap03-8f2d6a10
