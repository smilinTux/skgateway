import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load as yamlLoad } from 'js-yaml';

const sharedShadow = yamlLoad(readFileSync('deploy/chiap01/skgateway.shared-shadow.yaml', 'utf8'));
const sharedSystemd = readFileSync('deploy/chiap01/systemd/skgateway-shared-shadow.service', 'utf8');
const tailnetService = readFileSync('deploy/chiap01/systemd/skgateway-shared-tailnet.service', 'utf8');
const tailnetSocket = readFileSync('deploy/chiap01/systemd/skgateway-shared-tailnet.socket', 'utf8');
const QWEN_IDS = [
  'qwen3.8-27b-huihui-abliterated-q4_k_m',
  'qwen3.8-27b-ud-q5_k_xl',
  'qwen3.8-27b',
  'qwen38-abliterated',
];

test('shared shadow config is provider-pure: Qwen-only backends, no Codex, OpenRouter disabled', () => {
  const backends = sharedShadow.backends;
  const backendNames = Object.keys(backends ?? {});
  assert.deepEqual(backendNames, ['chiap01-qwen38', 'chiap08-qwen38']);
  for (const name of backendNames) {
    const b = backends[name];
    assert.equal(b.auth_type, 'none');
    assert.deepEqual(b.models, QWEN_IDS);
  }
  assert.equal('codex' in backends, false);
  assert.equal('openrouter' in backends, false);
  const disc = (sharedShadow.discovery && sharedShadow.discovery.providers) || {};
  assert.equal(disc.openrouter && disc.openrouter.enabled, false);
  assert.equal(disc.codex && disc.codex.enabled, false);
});

test('shared shadow service is instance-scoped, credential-free, ProtectHome-compatible, and not started', () => {
  assert.ok(sharedSystemd.includes('WorkingDirectory=/var/lib/sklegal/skgateway/shared-shadow'));
  assert.ok(sharedSystemd.includes('ReadWritePaths=/var/lib/sklegal/skgateway /var/log/sklegal/skgateway'));
  assert.ok(sharedSystemd.includes('ProtectHome=true'));
  assert.ok(sharedSystemd.includes('Restart=on-failure'));
  assert.ok(sharedSystemd.includes('RestartSec=5'));
});

test('tailnet ingress socket binds exactly the Tailscale interface, not a wildcard', () => {
  assert.ok(tailnetSocket.includes('BindToDevice=tailscale0'));
  assert.ok(tailnetSocket.includes('ListenStream=28880'));
  assert.ok(!/ListenStream=.*0\.0\.0\.0/.test(tailnetSocket));
});

test('tailnet proxy service is root-owned, hardened, and forwards to loopback backend', () => {
  assert.ok(tailnetService.includes('User=root'));
  assert.ok(tailnetService.includes('systemd-socket-proxyd'));
  assert.ok(tailnetService.includes('127.0.0.1:28880'));
  assert.ok(tailnetService.includes('ProtectHome=true'));
  assert.ok(tailnetService.includes('Restart=on-failure'));
  assert.ok(tailnetService.includes('StartLimitBurst=3'));
});
