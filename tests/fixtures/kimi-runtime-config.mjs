// Test-only synthetic fixture. This module is never imported by gateway or deployment code.
// Keep the two domains isolated so fixture checks cannot accidentally inherit live config.

export const kimiRuntimeConfig = Object.freeze({
  testOnly: true,
  pooling: Object.freeze({
    capacity_domains: Object.freeze({
      'kimi-coding': Object.freeze({
        members: Object.freeze(['kimi-coding']),
        effectiveMax: 28,
        effectiveMaxQueue: 400,
      }),
      'kimi-k3': Object.freeze({
        members: Object.freeze(['kimi-k3']),
        effectiveMax: 14,
        effectiveMaxQueue: 400,
      }),
    }),
  }),
});

export function assertKimiRuntimeFixture(config = kimiRuntimeConfig) {
  if (config.testOnly !== true) throw new Error('Kimi fixture must be test-only');
  const domains = config.pooling?.capacity_domains;
  const names = Object.keys(domains ?? {});
  if (names.length !== 2 || names.join('\0') !== 'kimi-coding\0kimi-k3') {
    throw new Error('fixture must define exactly kimi-coding and kimi-k3');
  }
  for (const [name, expectedMax] of [['kimi-coding', 28], ['kimi-k3', 14]]) {
    const domain = domains[name];
    if (domain.members.length !== 1 || domain.members[0] !== name) {
      throw new Error(`${name} must have only its corresponding member`);
    }
    if (domain.effectiveMax !== expectedMax || domain.effectiveMaxQueue !== 400) {
      throw new Error(`${name} has unexpected effective limits`);
    }
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertKimiRuntimeFixture();
  process.stdout.write('kimi runtime fixture: PASS\n');
}
