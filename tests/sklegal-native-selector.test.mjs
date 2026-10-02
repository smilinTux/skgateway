import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkLegalQualificationResolver, authorizeRequest } from '../src/policy/authz_gate.mjs';

const route = {
  method: 'POST', path: '/v1/chat/completions', request_capability: true,
  subject: 'synthetic-agent', model_route: 'local_qwen',
  resource: { tenant_id: 'tenant', matter_id: 'matter', route_id: 'governed-corpus-qwen' },
  context: { purpose: 'legal_research', classification: 'public', privilege: 'none', ethical_wall: 'clear' },
};
function bearer(id = 'material-1', overrides = {}, envelope = true) {
  const token = { skcapstone_token: '1.0', signature: '-----BEGIN PGP SIGNATURE-----\nsynthetic\n-----END PGP SIGNATURE-----', payload: {
    metadata: { sklegal_capability: {
      principal: { subject: route.subject }, grant: {
        audience: 'model', tenant_id: 'tenant', matter_id: 'matter',
        resource_id: id, resource_version: 1, model_route: 'local_qwen',
        purpose: 'legal_research', ...overrides,
      },
    } },
  } };
  return 'Bearer ' + JSON.stringify(envelope ? {
    sklegal_presented_capability: '1.0', chain: { leaf: JSON.stringify(token), ancestors: [] },
  } : token);
}
test('changing materials use exact separate PDP decisions and unchanged credentials', async () => {
  const resolver = createSkLegalQualificationResolver({ enabled: true, routes: [route] });
  const calls = [];
  for (const id of ['material-1', 'material-2']) {
    const token = bearer(id);
    const scope = resolver.resolve('POST', route.path, token);
    assert.equal(scope.resource.material_id, id);
    assert.equal(scope.resource.route_id, 'governed-corpus-qwen');
    const result = await authorizeRequest({ method: 'POST', url: route.path,
      internal: true, sklegalQualification: scope, requestCapAuth: token,
      sklegalClient: { decideSkLegal: async args => { calls.push(args); return { allow: false, reason: 'capability_denied' }; } },
    });
    assert.equal(result.allowed, false);
    assert.equal(calls.at(-1).requestCapAuth, token);
  }
  assert.equal(calls.length, 2);
});
test('invalid and unmatched selectors cannot fall through to internal or generic trust', async () => {
  const resolver = createSkLegalQualificationResolver({ enabled: true, routes: [route] });
  for (const token of [null, 'Bearer bad', bearer('x', { matter_id: 'other' }),
    bearer('x', { purpose: 'work_product_preparation' }), bearer('x', { resource_version: 0 }),
    bearer('x', { audience: 'api' }), 'Bearer ' + 'x'.repeat(8192)]) {
    const scope = resolver.resolve('POST', route.path, token);
    assert.ok(scope);
    let calls = 0;
    const result = await authorizeRequest({ method: 'POST', url: route.path, internal: true,
      sklegalQualification: scope, requestCapAuth: token,
      client: { decide: () => { throw Error('generic bypass'); } },
      sklegalClient: { decideSkLegal: () => { calls++; throw Error('invalid selectors'); } },
    });
    assert.equal(result.allowed, false);
    assert.equal(calls, 0);
  }
});
test('same-path explicit scopes are allowed but ambiguous configuration is rejected', () => {
  const draft = { ...route, context: { ...route.context, purpose: 'work_product_preparation' } };
  const resolver = createSkLegalQualificationResolver({ enabled: true, routes: [route, draft] });
  assert.equal(resolver.resolve('POST', route.path, bearer('draft', { purpose: draft.context.purpose }, false)).resource.material_id, 'draft');
  assert.throws(() => createSkLegalQualificationResolver({ enabled: true, routes: [route, route] }), /duplicated/);
});

test('governed request policy is explicit, bounded and validated before serving', () => {
  for (const request_policy of [null, {}, { model_only: false, max_requests: 8, window_ms: 60000 },
    { model_only: true, max_requests: 0, window_ms: 60000 },
    { model_only: true, max_requests: 1001, window_ms: 60000 },
    { model_only: true, max_requests: 8, window_ms: 0 },
    { model_only: true, max_requests: 8, window_ms: 3600001 },
    { model_only: true, max_requests: 8.5, window_ms: 60000 },
    { model_only: true, max_requests: 8, window_ms: 60000, extra: true }]) {
    assert.throws(() => createSkLegalQualificationResolver({ enabled: true,
      routes: [{ ...route, request_policy }] }), /request policy/);
  }
});

test('admission state follows the trusted tuple, not material or selector aliases', () => {
  const request_policy = { model_only: true, max_requests: 1, window_ms: 60000 };
  const entry = { ...route, request_policy };
  const alias = { ...entry, model_route: 'alias-qwen' };
  const resolver = createSkLegalQualificationResolver({ enabled: true, routes: [entry, alias] });
  const first = resolver.resolve('POST', route.path, bearer('first'));
  const second = resolver.resolve('POST', route.path, bearer('second', { model_route: 'alias-qwen' }));
  assert.equal(first.admit, second.admit);
  const body = Buffer.from(JSON.stringify({ messages: [] }));
  assert.equal(first.admit(body), null);
  assert.equal(second.admit(body).status, 429);
  assert.throws(() => createSkLegalQualificationResolver({ enabled: true,
    routes: [entry, { ...alias, request_policy: { ...request_policy, max_requests: 2 } }] }), /policy conflicts/);
  assert.throws(() => createSkLegalQualificationResolver({ enabled: true,
    routes: [entry, { ...alias, request_policy: undefined }] }), /policy conflicts/);
  assert.throws(() => createSkLegalQualificationResolver({ enabled: true,
    routes: [{ ...entry, path: '/v1/messages' }] }), /native chat completion/);
  const fixed = createSkLegalQualificationResolver({ enabled: true, routes: [{ ...entry,
    request_capability: false, resource: { ...entry.resource, material_id: 'fixed', material_version: '1' } }] });
  const fixedScope = fixed.resolve('POST', route.path);
  assert.equal(fixedScope.resource.material_id, 'fixed');
  assert.equal(fixedScope.admit(body), null);
  assert.equal(fixedScope.admit(body).status, 429);
});
