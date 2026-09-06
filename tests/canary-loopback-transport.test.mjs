import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unit = await readFile(new URL('../deploy/chiap08/systemd/skgateway-canary-loopback.service', import.meta.url), 'utf8');
const health = await readFile(new URL('../deploy/chiap08/skgateway-canary-loopback-health', import.meta.url), 'utf8');

test('canary transport is exact, supervised, and secret-free', () => {
  assert.match(unit, /-L 127\.0\.0\.1:28882:127\.0\.0\.1:28880 chiap01/);
  for (const option of [
    'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes',
    'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ClearAllForwardings=yes',
  ]) assert.ok(unit.includes(option), option);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StartLimitBurst=3/);
  assert.doesNotMatch(unit, /IdentityFile|PrivateKey|OPENROUTER|18790/);
  assert.match(health, /http:\/\/127\.0\.0\.1:\$\{port\}\/health/);
});
