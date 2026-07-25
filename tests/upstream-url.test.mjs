/**
 * upstream-url.test.mjs - unit tests for buildUpstreamUrl in src/proxy/upstream.mjs
 *
 * Root cause: sendUpstream built the upstream URL with
 * new URL(reqUrl, targetUrl), and reqUrl is an ABSOLUTE path
 * (e.g. /v1/chat/completions). new URL(absolutePath, base) discards any
 * base-URL path beyond the origin, so a backend base URL with a path
 * prefix beyond /vN (e.g. OpenRouter's https://openrouter.ai/api/v1) loses
 * that prefix (/api) and 404s.
 *
 * buildUpstreamUrl(reqUrl, targetUrl) must instead preserve the full
 * base-URL path, and de-duplicate a leading /vN segment on reqUrl when
 * the base path already ends with that same /vN segment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamUrl } from "../src/proxy/upstream.mjs";

test("openrouter base with /api/v1 keeps the /api prefix (the bug)", () => {
  const result = buildUpstreamUrl("/v1/chat/completions", new URL("https://openrouter.ai/api/v1"));
  assert.equal(result.toString(), "https://openrouter.ai/api/v1/chat/completions");
});

test("nvidia base with /v1 is unchanged (no regression)", () => {
  const result = buildUpstreamUrl("/v1/chat/completions", new URL("https://integrate.api.nvidia.com/v1"));
  assert.equal(result.toString(), "https://integrate.api.nvidia.com/v1/chat/completions");
});

test("local ollama-style base with /v1 and port", () => {
  const result = buildUpstreamUrl("/v1/models", new URL("http://192.168.0.100:11434/v1"));
  assert.equal(result.toString(), "http://192.168.0.100:11434/v1/models");
});

test("anthropic base with /v1", () => {
  const result = buildUpstreamUrl("/v1/messages", new URL("https://api.anthropic.com/v1"));
  assert.equal(result.toString(), "https://api.anthropic.com/v1/messages");
});

test("query string is preserved", () => {
  const result = buildUpstreamUrl("/v1/models?foo=bar", new URL("https://openrouter.ai/api/v1"));
  assert.equal(result.toString(), "https://openrouter.ai/api/v1/models?foo=bar");
});

test("base with no version segment appends reqPath as-is", () => {
  const result = buildUpstreamUrl("/v1/chat/completions", new URL("https://example.com/api"));
  assert.equal(result.toString(), "https://example.com/api/v1/chat/completions");
});
