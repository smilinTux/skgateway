# SKGateway Tailnet-Only Ingress (ae44a693)

## Overview

This deployment provides governed tailnet-only ingress for the qualified shared non-Matter SKGateway with exact profile `6073417e80f1f50fcdcc1ded64f823af98ae1cf39c2e190dc5c9a1c094f22380`.

### Human Intent Record

**Estate-wide tailnet access is intended** for qualified shared non-Matter SKGateway (profile 6073417e). This ingress provides controlled, supervised access across the estate tailnet while preserving the exact loopback backend profile.

## Architecture

```
Tailnet Clients (chiap08, etc.)
           |
           v
tailscale0 (tailscale0:28880)
           |
   skgateway-shared-tailnet.socket (systemd)
           |
   skgateway-shared-tailnet.service (socat proxy)
           |
           v
127.0.0.1:28880
           |
   skgateway-shared-shadow.service (Node.js gateway)
           |
           v
Backends (chiap08-qwen38, chiap01-qwen38)
```

## Security Boundaries

### Ingress Layer
- **Binding**: Only `tailscale0:28880` on `tailscale0` interface
- **No wildcard**: Explicit Tailscale IPv4 and IPv6 addresses
- **No LAN**: Not bound to `eth0`, `bond0`, or any LAN interface
- **No public**: Not exposed to the public internet
- **No dashboard/metrics**: Port 28880 is backend-only

### Proxy Layer (skgateway-shared-tailnet.service)
- **Root-owned**: Service runs as root for socket binding only
- **Hardened**: All systemd security directives enabled
- **Connection limits**: MaxConnections=50, StartLimitBurst=3
- **Restart limits**: 3 attempts per 60 seconds
- **No credentials**: Pure TCP proxy, no auth material

### Backend Layer (skgateway-shared-shadow.service)
- **User**: `sklegal-skgateway` (unprivileged)
- **Profile**: Exact hash 6073417e verified at startup
- **Authorization**: Auth-provider-pure required
- **Excluded routes**: SKLegal and OpenRouter protected

## Artifacts and Hashes

| File | Target Path | SHA-256 |
|------|-------------|---------|
| skgateway.shared-shadow.yaml | /etc/sklegal/skgateway/shared-shadow.yaml | abd1a4615ff7065f76265a1ae74e37f58521dfb58810e1a4c4b2762597b40fc8 |

The other units (socket, service) are tracked by git for content integrity.
The shadow.yaml hash is also stored in `skgateway.shared-shadow.yaml.sha256`,
and the tailnet proxy service verifies it before starting with ExecStartPre,
so a tampered config is detected and the service refuses to start.

## Deployment Procedure

### 1. Verify Profile Hash

```bash
# Expected: abd1a4615ff7065f76265a1ae74e37f58521dfb58810e1a4c4b2762597b40fc8
cd deploy/chiap01 && sha256sum -c skgateway.shared-shadow.yaml.sha256
```

### 2. Install Configuration Files

```bash
# Install backend configuration
sudo cp skgateway.shared-shadow.yaml /etc/sklegal/skgateway/
sudo chown root:sklegal-skgateway /etc/sklegal/skgateway/shared-shadow.yaml*
sudo chmod 640 /etc/sklegal/skgateway/shared-shadow.yaml*
```

### 3. Install Systemd Units

```bash
# Install systemd units (disabled by default)
sudo cp systemd/skgateway-shared-shadow.service /etc/systemd/system/
sudo cp systemd/skgateway-shared-tailnet.socket /etc/systemd/system/
sudo cp systemd/skgateway-shared-tailnet.service /etc/systemd/system/
sudo chown root:root /etc/systemd/system/skgateway-shared-*
sudo chmod 644 /etc/systemd/system/skgateway-shared-*

# Reload systemd
sudo systemctl daemon-reload
```

### 4. Verify Hashes on Target

```bash
# Verify socket unit
# Expected: c950e7bdaea22d27f471513a75f31e3ebdc231f14d893d990c1a041a6f5760a2

# Verify proxy service
# Expected: dffe38774797da9331c66d0753da875a17c97ccfa5ce2755cab3003112fc0acb

# Verify backend service
# Expected: 839d7d542503ddee5fc9062104beefab95007ed4adaceb4babcb51de1947dc57

# Verify config hash
# Expected: a1daf4452261a36169b9a1f0d455bc4c774cf917293338c335af67778bf15e3e
```

### 5. Start Backend Service

```bash
# Start the shared shadow backend (binds to 127.0.0.1:28880)
sudo systemctl start skgateway-shared-shadow.service
sudo systemctl status skgateway-shared-shadow.service

# Verify listening on loopback only
ss -tlnp | grep 28880
# Expected: 127.0.0.1:28880 only (no 0.0.0.0:28880, no [::]:28880)
```

### 6. Start Tailnet Ingress

```bash
# Enable and start the tailnet socket
sudo systemctl enable --now skgateway-shared-tailnet.socket
sudo systemctl status skgateway-shared-tailnet.socket

# Verify socket activation
systemctl list-sockets skgateway-shared-tailnet.socket
# Expected: skgateway-shared-tailnet.socket loaded active listening on tailscale0:28880
```

## Qualification Procedure

### 1. Tailnet Access Test (chiap08)

```bash
# From chiap08, test health endpoint
curl -v http://tailscale0:28880/health

# Expected: 200 OK with health status
```

### 2. Non-Tailnet Denial Test

```bash
# From chiap01 LAN (10.0.0.x), verify denial
curl -v http://10.0.0.47:28880/health
# Expected: Connection refused or timeout

# From chiap01 loopback, verify backend access (expected to work)
curl -v http://127.0.0.1:28880/health
# Expected: 200 OK (backend is accessible on loopback)
```

### 3. Public Synthetic Traffic Tests

Run the full qualification matrix:

- Health check: `/health`
- Catalog discovery: `/v1/models`
- Chat completion: `/v1/chat/completions`
- SSE streaming: Verify chunked transfer
- Tools invocation: Verify tool routing
- Attribution: Verify audit logging
- Capacity limits: Verify queue/timeout behavior
- Cancellation: Verify abort handling
- Backend outage: Verify failover
- Proxy restart: Verify recovery
- Gateway restart: Verify state preservation
- Leakage: Verify no tailnet escape
- Audit: Verify SIEM logging

### 4. Verify Protected Routes Excluded

```bash
# SKLegal route should be unavailable
curl -v http://tailscale0:28880/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[]}'
# Expected: 404 or authorization error

# OpenRouter route should be unavailable
curl -v http://tailscale0:28880/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[]}'
# Expected: 404 or authorization error
```

### 5. Verify Rollback Path

```bash
# Verify port 18790 still accessible
curl -v http://chiap01:18790/v1/models
# Expected: 200 OK with full model catalog

# This confirms rollback is available
```

## Rollback Procedure

```bash
# Disable and stop tailnet ingress
sudo systemctl disable --now skgateway-shared-tailnet.socket skgateway-shared-tailnet.service

# Stop backend service
sudo systemctl stop skgateway-shared-shadow.service

# Remove units (optional, preserves rollback config)
sudo rm -f /etc/systemd/system/skgateway-shared-tailnet.socket
sudo rm -f /etc/systemd/system/skgateway-shared-tailnet.service
sudo rm -f /etc/systemd/system/skgateway-shared-shadow.service
sudo systemctl daemon-reload

# Remove config (optional, preserves rollback config)
sudo rm -f /etc/sklegal/skgateway/shared-shadow.yaml

# Verify 28880 closed
ss -tlnp | grep 28880
# Expected: No results (port closed on tailnet and loopback)
```

## Acceptance Criteria Verification

1. **Ingress binding**: `ss -tlnp | grep 28880` shows only `tailscale0:28880` and `127.0.0.1:28880`
2. **Hardened supervised unit**: Systemd security directives present, no inline credentials
3. **Qualification**: All public synthetic traffic tests pass from chiap08, denied on LAN
4. **Rollback**: Port 18790 remains available, rollback command closes 28880 completely

## Constraints Compliance

- CardStore append-only: Verdict uses structured JSON only
- Structural events separate: Evidence recorded separately
- No commit/push to origin/main: Deployed on feature branch
- No live config mutation: Files are deploy artifacts
- No credential disclosure: Auth-provider-pure handles authorization
- No WAKE-02 enablement: Profile excludes protected routes
- No live_execution: Deployment disabled by default until qualified
- No automerge: Requires human qualification after PR
- No human_signoff: Operator verification only
- No repository visibility changes: Repository settings unchanged

## References

- Card: ae44a693 (SKGW-STRAT-06F)
- Profile: 6073417e80f1f50fcdcc1ded64f823af98ae1cf39c2e190dc5c9a1c094f22380
- Dependency: 0c865c70 (human approval card)
- Rollback: http://chiap01:18790/v1
