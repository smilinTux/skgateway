/** Local-only backend model translation contract. No provider calls. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRouter, routeAndSend } from '../src/proxy/router.mjs';
import { getConfig, loadConfig, reloadConfig } from '../src/config.mjs';

const CANONICAL = 'provider/model-canonical';
const WIRE = 'model-wire';
const UNMAPPED = 'provider/model-unmapped';
const HEADERS = { 'content-type': 'application/json' };
const bodyFor = (model, stream = false) => Buffer.from(JSON.stringify({
  model,
  stream,
  messages: [{ role: 'user', content: 'public synthetic' }],
}));

function startUpstream({ fail = false } = {}) {
  const state = { models: [], streams: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.models.push(body.model);
      state.streams.push(body.stream === true);
      if (fail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fixture failure' } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'fixture-stream', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
          usage: null,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'fixture-stream', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'fixture-json', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () => new Promise((done) => server.close(done)),
  })));
}

function backend(url, models = [CANONICAL, UNMAPPED], modelMap = { [CANONICAL]: WIRE }) {
  return { url, auth_type: 'none', models, model_map: modelMap, priority: 1 };
}

describe('backend-scoped model_map dispatch', () => {
  test('direct nonstream maps only the wire body and preserves attribution and audit identity', async () => {
    const upstream = await startUpstream();
    const events = [];
    try {
      const router = createRouter({ backends: { owner: backend(upstream.url) }, siem_log: false });
      const result = await routeAndSend(
        router, { model: CANONICAL, agentId: 'fixture' }, '/chat/completions', 'POST',
        HEADERS, bodyFor(CANONICAL), false, (event) => events.push(event),
      );
      assert.equal(result.status, 200);
      assert.equal(upstream.state.models.at(-1), WIRE);
      assert.equal(result.requestedModel, CANONICAL);
      assert.equal(result.servedModel, WIRE);
      assert.equal(result.backendId, 'owner');
      const requestEvent = events.find((event) => event.event_type === 'request');
      assert.equal(requestEvent.model, CANONICAL);
    } finally {
      await upstream.close();
    }
  });

  test('direct stream uses the same mapping and preserves valid SSE attribution', async () => {
    const upstream = await startUpstream();
    try {
      const router = createRouter({ backends: { owner: backend(upstream.url) }, siem_log: false });
      const result = await routeAndSend(
        router, { model: CANONICAL, agentId: 'fixture' }, '/chat/completions', 'POST',
        HEADERS, bodyFor(CANONICAL, true), false,
      );
      assert.equal(result.status, 200);
      assert.equal(upstream.state.models.at(-1), WIRE);
      assert.equal(upstream.state.streams.at(-1), true);
      assert.equal(result.requestedModel, CANONICAL);
      assert.equal(result.servedModel, WIRE);
      assert.match(result.body.toString('utf8'), /data: \[DONE\]/);
    } finally {
      await upstream.close();
    }
  });

  test('unmapped models are unchanged', async () => {
    const upstream = await startUpstream();
    try {
      const router = createRouter({ backends: { owner: backend(upstream.url) }, siem_log: false });
      const result = await routeAndSend(
        router, { model: UNMAPPED, agentId: 'fixture' }, '/chat/completions', 'POST',
        HEADERS, bodyFor(UNMAPPED), false,
      );
      assert.equal(result.status, 200);
      assert.equal(upstream.state.models.at(-1), UNMAPPED);
      assert.equal(result.requestedModel, UNMAPPED);
      assert.equal(result.servedModel, UNMAPPED);
    } finally {
      await upstream.close();
    }
  });

  test('a failed mapped backend cannot leak its mapping into the next backend attempt', async () => {
    const first = await startUpstream({ fail: true });
    const second = await startUpstream();
    try {
      const router = createRouter({ backends: {
        mapped: backend(first.url, [CANONICAL], { [CANONICAL]: WIRE }),
        plain: { ...backend(second.url, [CANONICAL], {}), priority: 2 },
      }, failover: true, siem_log: false });
      const result = await routeAndSend(
        router, { model: CANONICAL, agentId: 'fixture' }, '/chat/completions', 'POST',
        HEADERS, bodyFor(CANONICAL), false,
      );
      assert.equal(result.status, 200);
      assert.equal(first.state.models.at(-1), WIRE);
      assert.equal(second.state.models.at(-1), CANONICAL);
      assert.equal(result.backendId, 'plain');
      assert.equal(result.requestedModel, CANONICAL);
      assert.equal(result.servedModel, CANONICAL);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

const configDir = mkdtempSync(join(tmpdir(), 'skgw-model-map-'));
let configSequence = 0;

function writeConfig(modelLines, models = [CANONICAL]) {
  const path = join(configDir, `config-${configSequence++}.yaml`);
  const modelYaml = models.map((model) => `      - ${JSON.stringify(model)}`).join('\n');
  writeFileSync(path, [
    'backends:',
    '  owner:',
    '    url: http://127.0.0.1:9/v1',
    '    auth_type: none',
    '    priority: 1',
    '    models:',
    modelYaml,
    ...modelLines,
    '',
  ].join('\n'));
  return path;
}

describe('backend model_map config validation and reload', () => {
  test('boot rejects malformed, wildcard, unclaimed, and ambiguous maps', async () => {
    const invalid = [
      [['    model_map: []'], /model_map must be a mapping/],
      [['    model_map:', '      "": model-wire'], /key must be a non-empty string/],
      [['    model_map:', `      ${CANONICAL}: ""`], /value must be a non-empty string/],
      [['    model_map:', `      ${CANONICAL}: 7`], /value must be a non-empty string/],
      [['    model_map:', '      provider/*: model-wire'], /wildcards are not allowed/],
      [['    model_map:', `      ${CANONICAL}: model-*`], /wildcards are not allowed/],
      [['    model_map:', '      provider/not-claimed: model-wire'], /must name exactly one declared model/],
      [[
        '    model_map:',
        `      ${CANONICAL}: model-wire-a`,
        `      ${CANONICAL.toUpperCase()}: model-wire-b`,
      ], /keys collide case-insensitively/],
    ];
    for (const [lines, pattern] of invalid) {
      await assert.rejects(loadConfig({ configPath: writeConfig(lines), silent: true }), pattern);
    }
    await assert.rejects(
      loadConfig({
        configPath: writeConfig(
          ['    model_map:', `      ${CANONICAL}: model-wire`],
          [CANONICAL, CANONICAL.toUpperCase()],
        ),
        silent: true,
      }),
      /must name exactly one declared model/,
    );
  });

  test('invalid reload retains the last valid map and a later valid reload applies', async () => {
    const path = writeConfig(['    model_map:', `      ${CANONICAL}: model-wire-a`]);
    await loadConfig({ configPath: path, silent: true });
    assert.equal(getConfig().backends.owner.model_map[CANONICAL], 'model-wire-a');

    writeFileSync(path, [
      'backends:',
      '  owner:',
      '    url: http://127.0.0.1:9/v1',
      '    auth_type: none',
      '    priority: 1',
      '    models:',
      `      - ${CANONICAL}`,
      '    model_map:',
      `      ${CANONICAL}: model-*`,
      '',
    ].join('\n'));
    assert.equal(reloadConfig(true).ok, false);
    assert.equal(getConfig().backends.owner.model_map[CANONICAL], 'model-wire-a');

    writeFileSync(path, [
      'backends:',
      '  owner:',
      '    url: http://127.0.0.1:9/v1',
      '    auth_type: none',
      '    priority: 1',
      '    models:',
      `      - ${CANONICAL}`,
      '    model_map:',
      `      ${CANONICAL}: model-wire-c`,
      '',
    ].join('\n'));
    assert.equal(reloadConfig(true).ok, true);
    assert.equal(getConfig().backends.owner.model_map[CANONICAL], 'model-wire-c');
  });
});
