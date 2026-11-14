import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveXlPublic, xlPublicProposal, resolveRequestedModel, UnavailableModelError, qwenRouteUnchanged } from '../src/policy/xl-public.mjs';
const proof = { capabilityRevision: 'codex:2026-09-08', transportProfile: 'codex-responses', gatewayRevision: 'abc123' };
test('Astra succeeds only with availability and public eligibility proof', () => {
  const r = resolveXlPublic({ ...proof, catalog: [{ id: 'gpt-6-astra', supported_in_api: true, public_eligible: true }] });
  assert.equal(r.ok, true); assert.equal(r.served_model, 'gpt-6-astra'); assert.equal(r.requested_bucket, 'sk-xl-public');
});
test('absent Astra and unproven eligibility fail closed', () => {
  assert.equal(resolveXlPublic({ ...proof, catalog: [] }).ok, false);
  assert.equal(resolveXlPublic({ ...proof, catalog: [{ id: 'gpt-6-astra', supported_in_api: true }] }).ok, false);
});
test('Fable is typed unavailable and never falls back', () => assert.throws(() => resolveRequestedModel('fable-5.1'), e => e instanceof UnavailableModelError && e.code === 'MODEL_UNAVAILABLE'));
test('protected Matter is denied and Qwen remains unchanged', () => {
  assert.equal(xlPublicProposal({ ...proof, model: 'matter', sensitivity: 'secret', catalog: [] }).code, 'PROTECTED_CONTENT_DENIED');
  assert.equal(qwenRouteUnchanged({ bucket: 'sk-qwen', model: 'sk-qwen' }), true);
});
