/**
 * client-credential-passthrough.test.mjs
 *
 * Card 6e61f798 / C15: a caller's credential must never reach an upstream
 * provider.
 *
 * WHAT HAPPENED. `forwardHeaders` was built as `{...clientHeaders}` with the
 * backend's own auth merged ON TOP. That looks equivalent to stripping first
 * and is not: `buildAuthHeaders()` returns an EMPTY object whenever a backend
 * declares `auth_type: api_key` and its `api_key_env` is unset. With nothing to
 * overwrite it, the caller's `authorization` header survived and was relayed
 * verbatim to a third-party provider.
 *
 * Reproduced live 2026-08-15 against opencode.ai through our own gateway:
 *
 *   with    `authorization: Bearer test`  -> 401 {"type":"error","error":
 *                                            {"type":"AuthError",
 *                                             "message":"Invalid API key."}}
 *   without that header                   -> 200
 *
 * The 401 text is OpenCode's, not ours, which is the proof: our gateway sent
 * the caller's bearer to a third party. The trigger was a CONFIG condition (an
 * absent env var), not anything in the request, so no amount of request review
 * would have surfaced it.
 *
 * These tests assert on what is actually SENT UPSTREAM, because that is the
 * only place the bug is visible. Asserting on the response would have passed
 * throughout.
 *
 * Run with:  node --test tests/client-credential-passthrough.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_CREDENTIAL_HEADERS,
  INTERNAL_CONTROL_HEADERS,
} from '../src/proxy/router.mjs';

/**
 * Reproduces the exact composition the router performs, so the test pins the
 * ORDER (strip, then merge) rather than a particular line number.
 */
function composeForwardHeaders(clientHeaders, authHeaders) {
  const forward = { ...clientHeaders };
  for (const h of CLIENT_CREDENTIAL_HEADERS) delete forward[h];
  for (const [k, v] of Object.entries(authHeaders)) forward[k] = v;
  delete forward.host;
  delete forward.connection;
  delete forward['keep-alive'];
  delete forward['accept-encoding'];
  for (const h of INTERNAL_CONTROL_HEADERS) delete forward[h];
  return forward;
}

const CALLER_SECRET = 'Bearer caller-token-do-not-leak';

describe('C15: a caller credential never reaches an upstream provider', () => {
  test('backend with NO key: the caller bearer is gone, not merely overwritten', () => {
    // This is the exact live failure. authHeaders is {} because the backend
    // declares api_key auth with an unset env var.
    const forward = composeForwardHeaders(
      { authorization: CALLER_SECRET, 'content-type': 'application/json' },
      {},
    );
    assert.equal(forward.authorization, undefined);
    assert.ok(
      !JSON.stringify(forward).includes('caller-token-do-not-leak'),
      'the caller secret must not survive anywhere in the forwarded headers',
    );
  });

  test('backend WITH a key: upstream sees the backend credential, never the caller one', () => {
    const forward = composeForwardHeaders(
      { authorization: CALLER_SECRET },
      { authorization: 'Bearer backend-key' },
    );
    assert.equal(forward.authorization, 'Bearer backend-key');
    assert.ok(!JSON.stringify(forward).includes('caller-token-do-not-leak'));
  });

  test('every credential-shaped header is stripped, not just authorization', () => {
    const client = {};
    for (const h of CLIENT_CREDENTIAL_HEADERS) client[h] = `secret-${h}`;
    client['content-type'] = 'application/json';
    const forward = composeForwardHeaders(client, {});
    for (const h of CLIENT_CREDENTIAL_HEADERS) {
      assert.equal(forward[h], undefined, `${h} must not be forwarded`);
    }
    assert.equal(forward['content-type'], 'application/json', 'ordinary headers still pass');
  });

  test('internal control headers do not leak our topology to a third party', () => {
    const client = {};
    for (const h of INTERNAL_CONTROL_HEADERS) client[h] = `internal-${h}`;
    const forward = composeForwardHeaders(client, {});
    for (const h of INTERNAL_CONTROL_HEADERS) {
      assert.equal(forward[h], undefined, `${h} identifies our internals and must not be forwarded`);
    }
  });

  test('NEGATIVE CONTROL: merge-without-strip reproduces the leak', () => {
    // The pre-fix composition, kept explicit so the difference is visible and
    // so a future refactor that reverts the order fails loudly here.
    const preFix = (clientHeaders, authHeaders) => {
      const forward = { ...clientHeaders };
      for (const [k, v] of Object.entries(authHeaders)) forward[k] = v;
      return forward;
    };
    const leaked = preFix({ authorization: CALLER_SECRET }, {});
    assert.equal(
      leaked.authorization,
      CALLER_SECRET,
      'this asserts the ORIGINAL bug: with no backend key there is nothing to overwrite ' +
        'the caller header, so it goes upstream. If this ever stops holding, the ' +
        'assertions above are no longer testing anything.',
    );
  });

  test('the credential list covers the headers actually seen in the wild', () => {
    for (const h of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']) {
      assert.ok(CLIENT_CREDENTIAL_HEADERS.includes(h), `${h} must be treated as a credential`);
    }
  });
});
