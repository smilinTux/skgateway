/**
 * config-template-tooling.test.mjs: tests for the config-template generation
 * and scrub tooling that backs the public smilinTux/skgateway-config-template
 * repo (task G2b).
 *
 * - scripts/generate-config-template.sh: copies deploy/example-config-repo/
 *   verbatim into an output dir. The CI drift job
 *   (.github/workflows/config-template-drift.yml) runs this and diffs the
 *   result against a clone of the live template repo; that live-repo
 *   comparison needs network and isn't exercised here. What's tested here is
 *   that the generator reproduces the source exactly and clears stale files.
 * - scripts/scrub-check.sh: fails on a real private IP or real fleet domain
 *   under a given path, with a small allow-list for documentation/placeholder
 *   addresses and `example.*` hostnames.
 *
 * Run with: node --test tests/config-template-tooling.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const GENERATE_SCRIPT = join(REPO_ROOT, 'scripts', 'generate-config-template.sh');
const SCRUB_SCRIPT = join(REPO_ROOT, 'scripts', 'scrub-check.sh');
const SOURCE_DIR = join(REPO_ROOT, 'deploy', 'example-config-repo');

function run(script, args) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function listFilesRecursive(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p, root));
    else out.push(relative(root, p));
  }
  return out.sort();
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('scripts/generate-config-template.sh', () => {
  test('reproduces deploy/example-config-repo/ exactly', () => {
    const out = freshDir('skgw-tpl-gen-');
    try {
      const r = run(GENERATE_SCRIPT, [out]);
      assert.equal(r.status, 0, r.stderr);

      const sourceFiles = listFilesRecursive(SOURCE_DIR);
      const outFiles = listFilesRecursive(out);
      assert.deepEqual(outFiles, sourceFiles);

      for (const f of sourceFiles) {
        assert.equal(
          readFileSync(join(out, f), 'utf8'),
          readFileSync(join(SOURCE_DIR, f), 'utf8'),
          `content mismatch for ${f}`,
        );
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('clears a stale file in the output dir that no longer exists in the source', () => {
    const out = freshDir('skgw-tpl-gen-stale-');
    try {
      writeFileSync(join(out, 'stale-leftover.txt'), 'should be removed\n');
      const r = run(GENERATE_SCRIPT, [out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(join(out, 'stale-leftover.txt')), false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('the generated README has no relative links that only work inside this repo', () => {
    const out = freshDir('skgw-tpl-gen-readme-');
    try {
      run(GENERATE_SCRIPT, [out]);
      const readme = readFileSync(join(out, 'README.md'), 'utf8');
      // A link like ../../docs/DEPLOYING.md resolves inside this repo but
      // 404s once this file is the ROOT README of the published template
      // repo, which has no docs/ directory at all.
      assert.doesNotMatch(readme, /\]\(\.\.\//);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('refuses with a usage error when no output dir is given', () => {
    const r = run(GENERATE_SCRIPT, []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage/i);
  });
});

describe('scripts/scrub-check.sh', () => {
  function writeFixture(content) {
    const dir = freshDir('skgw-scrub-');
    writeFileSync(join(dir, 'fixture.yaml'), content);
    return dir;
  }

  test('passes on the real deploy/example-config-repo/ fixture', () => {
    const r = run(SCRUB_SCRIPT, [SOURCE_DIR]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('fails on a real private IP (192.168.x)', () => {
    const dir = writeFixture('backend: http://192.168.50.7:11434\n');
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /192\.168\.50\.7/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails on a real private IP (10.x)', () => {
    const dir = writeFixture('backend: http://10.4.9.22:8080\n');
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /10\.4\.9\.22/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes on 172.15.x and 172.32.x (outside the 172.16-31 private range)', () => {
    const dir = writeFixture('a: 172.15.5.5\nb: 172.32.5.5\n');
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails on 172.16-31.x (the real private range)', () => {
    const dir = writeFixture('backend: 172.20.5.5\n');
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /172\.20\.5\.5/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes on RFC 5737 documentation IPs and common generic placeholders', () => {
    const dir = writeFixture(
      'a: 192.0.2.5\nb: 198.51.100.9\nc: 203.0.113.3\nd: 192.168.1.1\ne: 192.168.0.1\nf: 10.0.0.1\ng: 172.16.0.1\n',
    );
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails on a real fleet domain', () => {
    for (const host of ['chiap01.douno.it', 'nammgr1001.nativeassetmanagement.com', 'wiki.skworld.io', 'skworld.io']) {
      const dir = writeFixture(`host: ${host}\n`);
      try {
        const r = run(SCRUB_SCRIPT, [dir]);
        assert.notEqual(r.status, 0, `expected failure for ${host}`);
        assert.match(r.stderr, new RegExp(host.replace(/\./g, '\\.')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('passes on an example.* hostname under a real fleet domain', () => {
    for (const host of ['example.douno.it', 'example.nativeassetmanagement.com', 'example.skworld.io']) {
      const dir = writeFixture(`host: ${host}\n`);
      try {
        const r = run(SCRUB_SCRIPT, [dir]);
        assert.equal(r.status, 0, `expected pass for ${host}: ${r.stdout}${r.stderr}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('passes on example.com/example.org and generic placeholder hostnames', () => {
    const dir = writeFixture('a: example.com\nb: example-backend-host\nc: example-remote-host\n');
    try {
      const r = run(SCRUB_SCRIPT, [dir]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses with a usage error when no path is given', () => {
    const r = run(SCRUB_SCRIPT, []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage/i);
  });
});
