# SKGateway Immutable Runtime Bundle Architecture

## Problem Statement

Prior to this work, all SKGateway instances were running from a single mutable shared directory (`/home/skuser01/work/skgateway`), creating several critical issues:

1. **Drift Risk**: In-flight edits affect all running instances immediately
2. **No Rollback**: No mechanism to revert to a known-good state
3. **No Versioning**: No record of which code is actually running
4. **No Attribution**: Cannot trace runtime behavior to exact commits
5. **Hard Auditing**: No way to verify what's deployed vs what's committed

## Solution: Immutable Versioned Runtime Bundles

### Core Principles

1. **Immutable Runtime**: Bundle contents never change after creation
2. **Reproducible Builds**: Two builds from same commit produce byte-identical outputs
3. **Versioned Artifacts**: Every bundle is tied to a specific git commit
4. **Separation of Concerns**: Code, config, and data are in separate locations
5. **Atomic Rollback**: Can revert to previous version instantly

### Bundle Structure

```
skgateway-{version}-{commit}.tar.gz
└── skgateway-{version}-{commit}/
    ├── MANIFEST.json              # Metadata, provenance, requirements
    ├── SOURCE.tar.gz              # Complete source tree at commit
    ├── RUNTIME.tar.gz             # Dependencies (node_modules/)
    ├── INVENTORY.txt              # SHA256 hashes of all source files
    └── CHECKSUMS.sha256           # Integrity verification
```

### MANIFEST.json Schema

```json
{
  "bundle_format": "skgateway-runtime-v1",
  "bundle_id": "skgateway-0.1.0-7231a0ab298c",
  "created_at": "2024-01-01T00:00:00Z",
  "created_by": "skcapstone-builder",
  "source_repository": "https://github.com/smilinTux/skgateway.git",
  "source_commit": "7231a0ab298c1787b5ae654516835c67082de8d5",
  "source_branch": "main",
  "version": "0.1.0",
  "node_version": "22.23.2",
  "dependencies": {
    "fastify": "^4.25.0",
    "pino": "^8.17.0"
  },
  "files": {
    "count": 127,
    "sha256": "abc123..."
  },
  "artifacts": {
    "source": {
      "file": "SOURCE.tar.gz",
      "sha256": "def456..."
    },
    "runtime": {
      "file": "RUNTIME.tar.gz",
      "sha256": "ghi789..."
    }
  },
  "entry_point": "src/index.mjs",
  "runtime_requirements": {
    "node": ">=22.0.0",
    "platform": "linux-x64"
  }
}
```

## Deployment Architecture

### Directory Layout

```
/opt/skgateway/
├── bundles/                          # Immutable bundle storage (read-only)
│   ├── skgateway-0.1.0-7231a0ab298c/
│   ├── skgateway-0.1.1-a1b2c3d4e5f6/
│   └── skgateway-0.2.0-feedfacebeef/
│
├── active/                           # Symlinks to active bundles
│   ├── lifecycle -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   ├── authz -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   ├── rail-attrib -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   ├── attrib-1 -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   ├── attrib-2 -> ../bundles/skgateway-0.1.0-7231a0ab298c
│   └── authz-2 -> ../bundles/skgateway-0.1.0-7231a0ab298c
│
└── rollout/                          # Staging for new deployments
    ├── lifecycle -> ../bundles/skgateway-0.1.1-a1b2c3d4e5f6
    └── ...
```

### Configuration Separation

```
/etc/skgateway/
├── lifecycle.yaml
├── authz.yaml
├── rail-attrib.yaml
├── attrib-1.yaml
├── attrib-2.yaml
└── authz-2.yaml
```

### Data Separation

```
/var/lib/skgateway/
├── lifecycle/
│   └── data/
├── authz/
│   └── data/
├── rail-attrib/
│   └── data/
├── attrib-1/
│   └── data/
├── attrib-2/
│   └── data/
└── authz-2/
    └── data/
```

### Systemd Service Template

```ini
[Unit]
Description=SKGateway Instance %i
After=network.target

[Service]
Type=simple
User=skgateway
Group=skgateway
Environment=NODE_ENV=production
ExecStart=/opt/skgateway/active/%i/bin/node /opt/skgateway/active/%i/src/index.mjs \
          --config /etc/skgateway/%i.yaml
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Health Probe

Each bundled instance exposes a `/healthz` endpoint:

```javascript
// Added to src/healthz.mjs
export async function healthzHandler(request, reply) {
  reply.send({
    status: 'healthy',
    bundle: process.env.SKG_BUNDLE_ID || 'unknown',
    commit: process.env.SKG_COMMIT_SHA || 'unknown',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}
```

## Build Process

### Reproducibility Guarantees

1. **Fixed Timestamps**: All tar entries use `2024-01-01T00:00:00Z`
2. **Deterministic Dependencies**: `npm ci` from locked `package-lock.json`
3. **Source Pinning**: Exact git commit is recorded and used
4. **Build Isolation**: Clean temp directory for each build
5. **Checksum Verification**: All artifacts have SHA256 checksums

### Build Steps

1. **Clone at Exact Commit**: `git checkout --detach <commit>`
2. **Create Source Archive**: `tar -czf SOURCE.tar.gz` (with fixed mtime)
3. **Install Dependencies**: `npm ci` in clean directory
4. **Create Runtime Archive**: `tar -czf RUNTIME.tar.gz node_modules/`
5. **Generate Inventory**: `find . -type f | sha256sum > INVENTORY.txt`
6. **Create Manifest**: Assemble MANIFEST.json with all metadata
7. **Generate Checksums**: `sha256sum MANIFEST.json SOURCE.tar.gz RUNTIME.tar.gz INVENTORY.txt > CHECKSUMS.sha256`
8. **Seal Bundle**: `tar -czf skgateway-{version}-{commit}.tar.gz {bundle}/`

## Rollback Procedure

### Atomic Symlink Swap

```bash
# 1. New version already staged in /opt/skgateway/rollout/
# 2. Swap symlinks atomically
ln -sfn /opt/skgateway/bundles/skgateway-0.1.0-7231a0ab298c \
       /opt/skgateway/active/lifecycle.tmp
mv -T /opt/skgateway/active/lifecycle.tmp \
      /opt/skgateway/active/lifecycle

# 3. Restart service
systemctl restart skgateway@lifecycle

# 4. Verify health
curl http://localhost:18951/healthz
```

### Rollback to Previous

```bash
# Rollback is simply swapping back to the previous bundle
ln -sfn /opt/skgateway/bundles/skgateway-0.0.9-previouscommit \
       /opt/skgateway/active/lifecycle.tmp
mv -T /opt/skgateway/active/lifecycle.tmp \
      /opt/skgateway/active/lifecycle
systemctl restart skgateway@lifecycle
```

## Security Considerations

1. **Bundle Signing (Optional)**: GPG signatures on checksums file
   ```bash
   SKG_BUNDLE_SIGN_KEY=ABCDEF... ./build-immutable-bundle.sh ...
   ```

2. **Read-Only Bundles**: Bundle directories are mounted/owned read-only
   ```bash
   chown -R root:root /opt/skgateway/bundles/
   chmod -R 555 /opt/skgateway/bundles/
   ```

3. **Least Privilege Service**: Dedicated `skgateway` user
   ```bash
   useradd -r -s /bin/false skgateway
   ```

4. **Checksum Verification**: Verify bundle before activation
   ```bash
   ./verify-bundle.sh /opt/skgateway/bundles/skgateway-0.1.0-7231a0ab298c.tar.gz
   ```

## Qualification Tests

Before deploying to production, run these tests:

### 1. Request Continuity
- Send sample requests to both old and new instances
- Compare response schemas (JSON path matching)
- Assert all required fields present

### 2. Token Continuity
- Test auth flow with valid tokens
- Verify token validation unchanged
- Check error messages for invalid tokens

### 3. Cost Continuity
- Send known requests through both instances
- Compare cost attribution in SKCounter
- Verify billing tags preserved

### 4. Latency Continuity
- Measure P50, P95, P99 latencies
- Compare against baseline (within 10% threshold)
- Check for regression

### 5. Queue Continuity
- Measure queue depth at steady state
- Compare drain rates under load
- Verify no queue buildup

### 6. Attribution Continuity
- Trace requests through to SKCounter
- Verify agent/request IDs preserved
- Check telemetry metadata

### 7. Collector Continuity
- Verify SKCounter integration working
- Check metrics are being emitted
- Validate metric schema

## Migration Path

### Phase 1: Bundle Infrastructure (This Card)
- ✅ Create bundling scripts
- ✅ Generate first bundle
- ✅ Document architecture
- ✅ Create deployment manifests

### Phase 2: Canary Deployment (Separate Card)
1. Install bundle infrastructure on chiap03
2. Deploy first bundle to canary instance
3. Run qualification tests
4. Fix any issues found
5. Expand to all instances on chiap03

### Phase 3: Multi-Host Rollout (Separate Cards)
1. Inventory remaining hosts (chiap01, chiap02, chiap04, chiap08)
2. Deploy bundle infrastructure to each host
3. Create host-specific bundles
4. Execute qualification per host

### Phase 4: Production Rollout (Human Decision)
1. Prepare rollout plan
2. Schedule maintenance window
3. Deploy to production with rollback ready
4. Monitor for 24 hours
5. Decommission mutable deployments

## Metrics and Monitoring

### Bundle Deployment Metrics

- `skgateway_bundle_deployed_total{version, commit, instance}` - Counter
- `skgateway_bundle_rollback_total{from_version, to_version}` - Counter
- `skgateway_bundle_deploy_duration_seconds{instance}` - Histogram

### Runtime Metrics (via /healthz)

- `bundle_id` - Bundle identifier
- `commit_sha` - Git commit SHA
- `uptime_seconds` - Process uptime
- `timestamp` - Last health check

## References

- Card: 8f2d6a10 (SKGATEWAY-IMMUTABLE-NODE-RUNTIME-01)
- Evidence: `~/.skcapstone/evidence/work/8f2d6a10/`
- Scripts: `scripts/runtime-bundle/`
