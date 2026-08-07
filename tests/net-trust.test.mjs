/**
 * net-trust.test.mjs — isInternalRemote(): the network trust boundary for the
 * "allow internal, gate external" authz posture. Internal = loopback / Tailscale
 * CGNAT (100.64/10) / RFC1918 / IPv6 loopback+ULA+link-local. Everything else,
 * and anything unparseable, is EXTERNAL (fail-closed: unknown gets gated).
 *
 * Run with:  node --test tests/net-trust.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isInternalRemote } from "../src/policy/net_trust.mjs";

test("loopback is internal", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isInternalRemote(ip), true, ip);
  }
});

test("Tailscale CGNAT 100.64/10 is internal (and its edges)", () => {
  for (const ip of ["100.108.59.57", "100.64.0.0", "100.127.255.255"]) {
    assert.equal(isInternalRemote(ip), true, ip);
  }
  for (const ip of ["100.63.255.255", "100.128.0.0"]) {
    assert.equal(isInternalRemote(ip), false, ip);
  }
});

test("RFC1918 ranges are internal (and their edges are not)", () => {
  for (const ip of ["10.1.2.3", "192.168.1.5", "172.16.0.1", "172.31.255.255", "::ffff:192.168.1.1"]) {
    assert.equal(isInternalRemote(ip), true, ip);
  }
  for (const ip of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.0.1"]) {
    assert.equal(isInternalRemote(ip), false, ip);
  }
});

test("IPv6 ULA (Tailscale fd7a.., fc00::/7) + link-local are internal", () => {
  for (const ip of ["fd7a:115c:a1e0::1", "fc00::1", "fd00::abcd", "fe80::1", "FE80::1"]) {
    assert.equal(isInternalRemote(ip), true, ip);
  }
});

test("public addresses are external", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.7", "::ffff:8.8.8.8", "2606:4700:4700::1111"]) {
    assert.equal(isInternalRemote(ip), false, ip);
  }
});

test("unparseable / missing remote is external (fail-closed)", () => {
  for (const ip of [null, undefined, "", "  ", "garbage", "999.1.1.1", 12345]) {
    assert.equal(isInternalRemote(ip), false, String(ip));
  }
});
