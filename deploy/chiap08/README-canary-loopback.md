# chiap08 canary loopback transport

This supervised SSH client exposes only `127.0.0.1:28882` on chiap08 and
forwards it only to `127.0.0.1:28880` as seen by `chiap01`. Port 28882 was
recorded collision-free on chiap08 during qualification. The existing SSH host
alias supplies the identity reference and known-hosts file. The unit overrides
that alias's permissive enrollment setting with `StrictHostKeyChecking=yes`.
No key value or inline secret is present.

## Install and qualify

The commands below are an operator runbook. This repository change does not
activate or mutate a live service.

```sh
sudo install -o root -g root -m 0755 \
  deploy/chiap08/skgateway-canary-loopback-health \
  /usr/local/libexec/skgateway-canary-loopback-health
sudo install -o root -g root -m 0644 \
  deploy/chiap08/systemd/skgateway-canary-loopback.service \
  /etc/systemd/system/skgateway-canary-loopback.service
sudo systemctl daemon-reload
sudo systemctl enable --now skgateway-canary-loopback.service

systemctl is-enabled skgateway-canary-loopback.service
systemctl is-active skgateway-canary-loopback.service
ss -H -lnt '( sport = :28882 )'
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:28882/health
sha256sum /etc/systemd/system/skgateway-canary-loopback.service \
  /usr/local/libexec/skgateway-canary-loopback-health

sudo systemctl restart skgateway-canary-loopback.service
systemctl is-active skgateway-canary-loopback.service
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:28882/health

# Failure proof: temporarily stop only the chiap01 shared-shadow service in an
# approved maintenance window, or use a fixture SSH target with 28880 closed.
# The unit must fail health, retry no more than StartLimitBurst=3 per minute,
# and recover after the target returns. Never stop 18790 for this test.
systemctl show skgateway-canary-loopback.service \
  -p NRestarts -p ActiveState -p SubState -p Result
journalctl -u skgateway-canary-loopback.service --since '-2 minutes' --no-pager
```

Before and after qualification, record hashes and service/listener state for
18790 and all approved consumer configuration. Do not send inference traffic,
protected traffic, or OpenRouter traffic. The health request is the only
application request required.

## Rollback

```sh
sudo systemctl disable --now skgateway-canary-loopback.service
sudo rm -f /etc/systemd/system/skgateway-canary-loopback.service \
  /usr/local/libexec/skgateway-canary-loopback-health
sudo systemctl daemon-reload
sudo systemctl reset-failed skgateway-canary-loopback.service
! ss -H -lnt '( sport = :28882 )' | grep -q .
```

Rollback touches only the canary transport files and local port 28882.
