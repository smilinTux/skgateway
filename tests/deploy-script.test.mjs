/**
 * deploy-script.test.mjs: tests for deploy/skgateway-deploy (task G2).
 *
 * Drives the real bash script in a temp HOME, with a fake `systemctl` (a
 * recording no-op on PATH) and a fake health endpoint (a tiny real HTTP
 * server bound to the instance's configured port). Nothing here touches the
 * developer's real $HOME, the real skgateway repo's tags, or a network
 * remote: the "release" source is a throwaway local git repo built per
 * suite, cloned over a local filesystem path.
 *
 * Run with: node --test tests/deploy-script.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'deploy', 'skgateway-deploy');

// ─── git/process helpers ────────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Deploy Script Test']);
}

function gitCommitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

const ZERO_DEP_PACKAGE_LOCK = JSON.stringify(
  { name: 'fixture-release', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-release', version: '1.0.0' } } },
  null,
  2,
);

/**
 * Build a throwaway "public repo" fixture that skgateway-deploy treats as
 * SKGATEWAY_DEPLOY_REPO_ROOT: it has a main branch with two tagged commits
 * (both reachable from main) and a third tag on a branch never merged to
 * main (unreachable), plus a zero-dependency package.json/lock so a real
 * `npm ci --omit=dev` is instant and needs no network.
 */
function buildSourceRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-deploy-src-'));
  gitInit(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-release', version: '1.0.0', private: true }));
  writeFileSync(join(dir, 'package-lock.json'), ZERO_DEP_PACKAGE_LOCK);
  writeFileSync(join(dir, 'src-marker.txt'), 'v1\n');
  gitCommitAll(dir, 'c1');
  git(dir, ['tag', 'skgateway-v1.0.0']);

  writeFileSync(join(dir, 'src-marker.txt'), 'v2\n');
  gitCommitAll(dir, 'c2');
  git(dir, ['tag', 'skgateway-v1.1.0']);

  // A commit that only exists on a side branch, never merged to main.
  git(dir, ['checkout', '-q', '-b', 'side-branch']);
  writeFileSync(join(dir, 'unmerged.txt'), 'unmerged\n');
  gitCommitAll(dir, 'unmerged commit');
  git(dir, ['tag', 'skgateway-v9.9.9-unreachable']);
  git(dir, ['checkout', '-q', 'main']);

  // A self-referential origin remote: skgateway-deploy clones from
  // `git remote get-url origin`, which in production is the real GitHub
  // remote of the checkout the script ships in.
  git(dir, ['remote', 'add', 'origin', dir]);

  return {
    dir,
    tagV1: 'skgateway-v1.0.0',
    tagV2: 'skgateway-v1.1.0',
    tagUnreachable: 'skgateway-v9.9.9-unreachable',
  };
}

/**
 * Build a throwaway private config-repo fixture with one or more instances.
 * `instances` maps instance name -> { port, release, secretsMethod,
 * secretsContent, nodeOptions }.
 */
function buildConfigRepo(instances) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-deploy-config-'));
  gitInit(dir);
  writeFileSync(join(dir, 'README.md'), '# fixture config repo\n');
  for (const [name, opts] of Object.entries(instances)) {
    writeInstance(dir, name, opts);
  }
  gitCommitAll(dir, 'initial instances');
  return dir;
}

function writeInstance(configRepoDir, name, opts) {
  const {
    port, release, secretsMethod = 'none', secretsContent = 'API_KEY=fixture-secret\n', nodeOptions, extraEnv = {},
    // Matches MIN_CONFIG_SCHEMA in deploy/skgateway-deploy. Every fixture gets
    // a valid schema by default so existing tests don't have to know about
    // this; the CONFIG_SCHEMA-specific tests below override it explicitly.
    // `null` omits the key entirely (simulates a config repo written before
    // CONFIG_SCHEMA existed).
    configSchema = 1,
  } = opts;
  const instDir = join(configRepoDir, name);
  mkdirSync(instDir, { recursive: true });
  const envLines = [`PORT=${port}`, `RELEASE=${release}`, `SECRETS_METHOD=${secretsMethod}`];
  if (configSchema !== null) envLines.push(`CONFIG_SCHEMA=${configSchema}`);
  if (nodeOptions) envLines.push(`NODE_OPTIONS=${nodeOptions}`);
  for (const [k, v] of Object.entries(extraEnv)) envLines.push(`${k}=${v}`);
  writeFileSync(join(instDir, 'instance.env'), `${envLines.join('\n')}\n`);
  writeFileSync(join(instDir, 'skgateway.yaml'), `server:\n  port: ${port}\n`);
  writeFileSync(join(instDir, 'policies.yaml'), 'policies: []\n');
  writeFileSync(join(instDir, 'secrets.env.enc'), secretsContent);
}

function updateInstanceRelease(configRepoDir, name, release) {
  const envPath = join(configRepoDir, name, 'instance.env');
  const content = readFileSync(envPath, 'utf8').replace(/^RELEASE=.*$/m, `RELEASE=${release}`);
  writeFileSync(envPath, content);
  gitCommitAll(configRepoDir, `bump ${name} release to ${release}`);
}

// ─── fake systemctl ─────────────────────────────────────────────────────────

function makeFakeSystemctl() {
  const bin = mkdtempSync(join(tmpdir(), 'skgw-deploy-bin-'));
  const log = join(bin, 'systemctl.log');
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'systemctl'),
    '#!/usr/bin/env bash\n'
    + 'echo "$*" >> "' + log + '"\n'
    + 'for a in "$@"; do\n'
    + '  if [ "$a" = "is-active" ]; then echo active; exit 0; fi\n'
    + 'done\n'
    + 'exit 0\n',
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  return { bin, log };
}

// ─── fake health endpoint ───────────────────────────────────────────────────

function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── running the script under test ─────────────────────────────────────────

// NOTE: this must be a non-blocking spawn, not spawnSync. Several tests run
// a fake HTTP health server in THIS process while the script under test
// polls it; spawnSync blocks the whole event loop (including that server's
// ability to accept/respond to connections) until the child exits, which
// deadlocks the health-check loop until it times out. async spawn lets the
// event loop keep serving the fake health endpoint while the child runs.
function runDeploy(args, {
  home, repoRoot, extraEnv = {}, parentUmask,
} = {}) {
  const bin = makeFakeSystemctl();
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin.bin}:${process.env.PATH}`,
    SKGATEWAY_DEPLOY_REPO_ROOT: repoRoot,
    ...extraEnv,
  };
  // parentUmask: set a permissive umask on the PARENT shell before exec'ing
  // the script under test, to prove the script sets its own (tighter) umask
  // rather than merely relying on whatever umask it happened to inherit.
  const spawnArgs = parentUmask
    ? ['-c', 'umask ' + parentUmask + '; exec "$0" "$@"', SCRIPT, ...args]
    : [SCRIPT, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', spawnArgs, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr, systemctlLog: readFileSync(bin.log, 'utf8') });
    });
  });
}

function unitPath(home, instance) {
  return join(home, '.config', 'systemd', 'user', `skgateway-${instance}.service`);
}

function secretsPath(home, instance) {
  return join(home, '.config', 'skgateway', instance, 'secrets.env');
}

function releaseDir(home, tag) {
  return join(home, '.local', 'share', 'skgateway', 'releases', tag);
}

function stateDir(home, instance) {
  return join(home, '.local', 'state', 'skgateway', instance);
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'skgw-deploy-home-'));
}

// Fast settings so the health-check-failure path doesn't actually wait 60s.
const FAST_HEALTH = {
  SKGATEWAY_DEPLOY_HEALTH_TIMEOUT_S: '3',
  SKGATEWAY_DEPLOY_HEALTH_INTERVAL_S: '0.3',
};

// ─── suite ──────────────────────────────────────────────────────────────────

describe('skgateway-deploy', () => {
  let source;

  before(() => {
    source = buildSourceRepo();
  });

  after(() => {
    rmSync(source.dir, { recursive: true, force: true });
  });

  test('dry-run changes nothing', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19201, release: source.tagV1 } });

    const r = await runDeploy(
      ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo'],
      { home, repoRoot: source.dir },
    );

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY-RUN/);
    assert.equal(existsSync(releaseDir(home, source.tagV1)), false);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
    assert.equal(existsSync(secretsPath(home, 'demo')), false);
    assert.equal(r.systemctlLog.trim(), '');
  });

  test('execute installs release, unit and secrets with 0600', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19202, release: source.tagV1 } });
    const health = await startHealthServer(19202);
    try {
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );

      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(join(releaseDir(home, source.tagV1), 'package.json')), true);

      const unit = readFileSync(unitPath(home, 'demo'), 'utf8');
      assert.match(unit, /--port 19202/);
      assert.match(unit, new RegExp(releaseDir(home, source.tagV1).replace(/[/]/g, '\\/')));
      assert.match(unit, /SKGATEWAY_CONFIG=.*demo\/skgateway\.yaml/);
      assert.match(unit, new RegExp(`EnvironmentFile=${secretsPath(home, 'demo').replace(/[/]/g, '\\/')}`));

      const secretsStat = statSync(secretsPath(home, 'demo'));
      assert.equal(secretsStat.mode & 0o777, 0o600);
      assert.equal(readFileSync(secretsPath(home, 'demo'), 'utf8'), 'API_KEY=fixture-secret\n');

      assert.match(r.systemctlLog, /daemon-reload/);
      assert.match(r.systemctlLog, /restart skgateway-demo|enable --now skgateway-demo/);
    } finally {
      await stopServer(health);
    }
  });

  test('refuses a tag that is not reachable from main', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19203, release: source.tagUnreachable } });

    const r = await runDeploy(
      ['--release', source.tagUnreachable, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /reachable|not found/i);
    assert.equal(existsSync(releaseDir(home, source.tagUnreachable)), false);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('refuses a dirty config repo', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19204, release: source.tagV1 } });
    // Dirty the checkout: modify a tracked file without committing.
    writeFileSync(join(configRepo, 'demo', 'instance.env'), `PORT=19204\nRELEASE=${source.tagV1}\nSECRETS_METHOD=none\nEXTRA=dirty\n`);

    const r = await runDeploy(
      ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /dirty|uncommitted/i);
    assert.equal(existsSync(releaseDir(home, source.tagV1)), false);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('failed health check rolls back to the previous release', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19205, release: source.tagV1 } });
    const health = await startHealthServer(19205);
    try {
      const first = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(first.status, 0, first.stderr + first.stdout);
      const unitAfterFirst = readFileSync(unitPath(home, 'demo'), 'utf8');

      // Second deploy to a new tag, but the health endpoint is down for it
      // (same server stays up on the port, serving the OLD release's
      // responses, so stop it to simulate "new code never comes up").
      await stopServer(health);
      updateInstanceRelease(configRepo, 'demo', source.tagV2);

      const second = await runDeploy(
        ['--release', source.tagV2, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );

      assert.equal(second.status, 3, second.stderr + second.stdout);
      const unitAfterRollback = readFileSync(unitPath(home, 'demo'), 'utf8');
      assert.equal(unitAfterRollback, unitAfterFirst);
      assert.match(unitAfterRollback, new RegExp(releaseDir(home, source.tagV1).replace(/[/]/g, '\\/')));

      const currentRelease = readFileSync(join(stateDir(home, 'demo'), 'current', 'release'), 'utf8').trim();
      assert.equal(currentRelease, source.tagV1);
      assert.equal(existsSync(join(stateDir(home, 'demo'), 'previous')), false);
    } finally {
      if (health.listening) await stopServer(health);
    }
  });

  test('renders two instances with distinct unit, port and secrets path', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({
      a: { port: 19206, release: source.tagV1 },
      b: { port: 19207, release: source.tagV1 },
    });
    const healthA = await startHealthServer(19206);
    const healthB = await startHealthServer(19207);
    try {
      const rA = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'a', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(rA.status, 0, rA.stderr + rA.stdout);
      const rB = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'b', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(rB.status, 0, rB.stderr + rB.stdout);

      const unitA = readFileSync(unitPath(home, 'a'), 'utf8');
      const unitB = readFileSync(unitPath(home, 'b'), 'utf8');
      assert.notEqual(unitA, unitB);
      assert.match(unitA, /--port 19206/);
      assert.match(unitB, /--port 19207/);
      assert.match(unitA, new RegExp(secretsPath(home, 'a').replace(/[/]/g, '\\/')));
      assert.match(unitB, new RegExp(secretsPath(home, 'b').replace(/[/]/g, '\\/')));

      assert.equal(statSync(secretsPath(home, 'a')).mode & 0o777, 0o600);
      assert.equal(statSync(secretsPath(home, 'b')).mode & 0o777, 0o600);
    } finally {
      await stopServer(healthA);
      await stopServer(healthB);
    }
  });

  test('--rollback swaps current and previous', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19208, release: source.tagV1 } });
    const health = await startHealthServer(19208);
    try {
      const first = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(first.status, 0, first.stderr + first.stdout);

      updateInstanceRelease(configRepo, 'demo', source.tagV2);
      const second = await runDeploy(
        ['--release', source.tagV2, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(second.status, 0, second.stderr + second.stdout);

      const rollback = await runDeploy(
        ['--rollback', '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir },
      );
      assert.equal(rollback.status, 0, rollback.stderr + rollback.stdout);

      const current = readFileSync(join(stateDir(home, 'demo'), 'current', 'release'), 'utf8').trim();
      const previous = readFileSync(join(stateDir(home, 'demo'), 'previous', 'release'), 'utf8').trim();
      assert.equal(current, source.tagV1);
      assert.equal(previous, source.tagV2);

      const unitAfterRollback = readFileSync(unitPath(home, 'demo'), 'utf8');
      assert.match(unitAfterRollback, new RegExp(releaseDir(home, source.tagV1).replace(/[/]/g, '\\/')));
    } finally {
      await stopServer(health);
    }
  });

  test('--status reports the current release without changing anything', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19209, release: source.tagV1 } });
    const health = await startHealthServer(19209);
    try {
      const deploy = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(deploy.status, 0, deploy.stderr + deploy.stdout);
      const unitBefore = readFileSync(unitPath(home, 'demo'), 'utf8');

      const status = await runDeploy(['--status', '--instance', 'demo'], { home, repoRoot: source.dir });

      assert.equal(status.status, 0, status.stderr + status.stdout);
      assert.match(status.stdout, new RegExp(source.tagV1));
      assert.match(status.stdout, /19209/);
      assert.equal(readFileSync(unitPath(home, 'demo'), 'utf8'), unitBefore);
    } finally {
      await stopServer(health);
    }
  });

  test('refuses a release/RELEASE mismatch unless --force-release', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19210, release: source.tagV1 } });

    const mismatch = await runDeploy(
      ['--release', source.tagV2, '--config-repo', configRepo, '--instance', 'demo'],
      { home, repoRoot: source.dir },
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /RELEASE|mismatch|force-release/i);

    const forced = await runDeploy(
      ['--release', source.tagV2, '--config-repo', configRepo, '--instance', 'demo', '--force-release'],
      { home, repoRoot: source.dir },
    );
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.match(forced.stdout, /DRY-RUN/);
  });

  // ─── optional add-on templates (brief amendment): shadow / ingress / canary ──

  function optionalUnitPaths(home, instance) {
    return {
      shadow: join(home, '.config', 'systemd', 'user', `skgateway-shadow-${instance}.service`),
      ingressSocket: join(home, '.config', 'systemd', 'user', `skgateway-ingress-${instance}.socket`),
      ingressService: join(home, '.config', 'systemd', 'user', `skgateway-ingress-${instance}.service`),
      canaryService: join(home, '.config', 'systemd', 'user', `skgateway-canary-${instance}.service`),
      canaryHealth: join(home, '.local', 'libexec', 'skgateway', `canary-${instance}-health`),
    };
  }

  test('optional shadow/ingress/canary units are disabled by default', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19211, release: source.tagV1 } });
    const health = await startHealthServer(19211);
    try {
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);

      const paths = optionalUnitPaths(home, 'demo');
      for (const p of Object.values(paths)) {
        assert.equal(existsSync(p), false, `expected no file at ${p}`);
      }
    } finally {
      await stopServer(health);
    }
  });

  test('renders the shadow, ingress and canary templates when enabled, from instance.env only', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({
      demo: {
        port: 19212,
        release: source.tagV1,
        extraEnv: {
          SHADOW_ENABLED: 1,
          SHADOW_PORT: 28880,
          INGRESS_SOCKET: 1,
          TAILNET_INTERFACE: 'tailscale0',
          CANARY: 1,
          CANARY_LOCAL_PORT: 28882,
          CANARY_REMOTE_HOST: 'chiap01',
          CANARY_REMOTE_PORT: 28880,
        },
      },
    });
    const health = await startHealthServer(19212);
    try {
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);

      const paths = optionalUnitPaths(home, 'demo');

      const shadow = readFileSync(paths.shadow, 'utf8');
      assert.match(shadow, /--port 28880/);
      assert.match(shadow, /skgateway\.shadow\.yaml/);
      assert.match(shadow, new RegExp(secretsPath(home, 'demo').replace(/[/]/g, '\\/')));

      const socket = readFileSync(paths.ingressSocket, 'utf8');
      assert.match(socket, /BindToDevice=tailscale0/);
      assert.match(socket, /ListenStream=19212/); // defaults to the instance PORT

      const ingressService = readFileSync(paths.ingressService, 'utf8');
      assert.match(ingressService, /127\.0\.0\.1:19212/);
      assert.match(ingressService, /BindsTo=skgateway-ingress-demo\.socket/);

      const canaryService = readFileSync(paths.canaryService, 'utf8');
      assert.match(canaryService, /-L 127\.0\.0\.1:28882:127\.0\.0\.1:28880 chiap01/);
      assert.match(canaryService, new RegExp(paths.canaryHealth.replace(/[/]/g, '\\/')));

      const canaryHealth = readFileSync(paths.canaryHealth, 'utf8');
      assert.match(canaryHealth, /port=28882/);
      assert.equal(statSync(paths.canaryHealth).mode & 0o777, 0o755);
    } finally {
      await stopServer(health);
    }
  });

  test('two instances with the same optional feature enabled do not collide', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({
      a: {
        port: 19213,
        release: source.tagV1,
        extraEnv: { INGRESS_SOCKET: 1, TAILNET_INTERFACE: 'tailscale0' },
      },
      b: {
        port: 19214,
        release: source.tagV1,
        extraEnv: { INGRESS_SOCKET: 1, TAILNET_INTERFACE: 'tailscale0' },
      },
    });
    const healthA = await startHealthServer(19213);
    const healthB = await startHealthServer(19214);
    try {
      const rA = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'a', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(rA.status, 0, rA.stderr + rA.stdout);
      const rB = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'b', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(rB.status, 0, rB.stderr + rB.stdout);

      const pathsA = optionalUnitPaths(home, 'a');
      const pathsB = optionalUnitPaths(home, 'b');
      assert.notEqual(pathsA.ingressSocket, pathsB.ingressSocket);

      const socketA = readFileSync(pathsA.ingressSocket, 'utf8');
      const socketB = readFileSync(pathsB.ingressSocket, 'utf8');
      assert.match(socketA, /ListenStream=19213/);
      assert.match(socketB, /ListenStream=19214/);
      assert.notEqual(socketA, socketB);
    } finally {
      await stopServer(healthA);
      await stopServer(healthB);
    }
  });

  // ─── fix round 1: instance validation, umask, forced-but-unreachable ───────

  test('refuses an --instance containing a path separator or ".." before any path is built', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19215, release: source.tagV1 } });

    for (const bad of ['../escape', 'demo/evil', 'a/b/c', '..']) {
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', bad, '--execute'],
        { home, repoRoot: source.dir },
      );
      assert.notEqual(r.status, 0, `expected refusal for --instance '${bad}'`);
      assert.match(r.stderr, /invalid --instance/i);
    }

    // Nothing should have been written anywhere under home for any of them.
    assert.equal(existsSync(join(home, '.config')), false);
    assert.equal(existsSync(join(home, '.local')), false);
  });

  test('--force-release does not override an unreachable-from-main tag', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19216, release: source.tagUnreachable } });

    const r = await runDeploy(
      ['--release', source.tagUnreachable, '--config-repo', configRepo, '--instance', 'demo', '--execute', '--force-release'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /reachable|not found/i);
    assert.equal(existsSync(releaseDir(home, source.tagUnreachable)), false);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('secrets file is 0600 immediately on creation, and the script sets its own umask', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19217, release: source.tagV1 } });
    const health = await startHealthServer(19217);
    try {
      // The parent shell's umask is permissive (022: world/group-readable by
      // default). If the script did not set its own umask, the unit file
      // (written with a plain `>` redirect, never chmod'd afterward) would
      // come out 644. Seeing 600 anyway proves the script's own `umask 077`
      // took effect, not just the explicit chmod on the secrets file.
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        {
          home, repoRoot: source.dir, extraEnv: FAST_HEALTH, parentUmask: '022',
        },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);

      assert.equal(statSync(secretsPath(home, 'demo')).mode & 0o777, 0o600);
      assert.equal(statSync(unitPath(home, 'demo')).mode & 0o777, 0o600);
    } finally {
      await stopServer(health);
    }
  });

  // ─── CONFIG_SCHEMA (task G2b) ───────────────────────────────────────────────
  //
  // instance.env carries CONFIG_SCHEMA=<n>. skgateway-deploy refuses to deploy
  // a config repo pinned to a schema older than this release's minimum
  // supported schema (MIN_CONFIG_SCHEMA in the script), and names what to
  // change rather than just failing. A config repo written before
  // CONFIG_SCHEMA existed (the key is simply absent) is treated the same as
  // schema 0.

  test('refuses a CONFIG_SCHEMA older than the release minimum, naming the fix', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19218, release: source.tagV1, configSchema: 0 } });

    const r = await runDeploy(
      ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CONFIG_SCHEMA/);
    assert.match(r.stderr, /CONFIG_SCHEMA=1/); // names the value to set
    assert.equal(existsSync(releaseDir(home, source.tagV1)), false);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('refuses a config repo with no CONFIG_SCHEMA key at all (treated as schema 0)', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19219, release: source.tagV1, configSchema: null } });

    const r = await runDeploy(
      ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CONFIG_SCHEMA/);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('refuses a non-numeric CONFIG_SCHEMA with a clear message', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19220, release: source.tagV1, configSchema: 'banana' } });

    const r = await runDeploy(
      ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
      { home, repoRoot: source.dir },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CONFIG_SCHEMA/i);
    assert.equal(existsSync(unitPath(home, 'demo')), false);
  });

  test('accepts a CONFIG_SCHEMA at or above the release minimum', async () => {
    const home = freshHome();
    const configRepo = buildConfigRepo({ demo: { port: 19221, release: source.tagV1, configSchema: 2 } });
    const health = await startHealthServer(19221);
    try {
      const r = await runDeploy(
        ['--release', source.tagV1, '--config-repo', configRepo, '--instance', 'demo', '--execute'],
        { home, repoRoot: source.dir, extraEnv: FAST_HEALTH },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(unitPath(home, 'demo')), true);
    } finally {
      await stopServer(health);
    }
  });
});
