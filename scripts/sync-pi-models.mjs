#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_GATEWAY = process.env.SKGATEWAY_URL || 'http://127.0.0.1:18780';
const DEFAULT_PI_MODELS = join(homedir(), '.pi', 'agent', 'models.json');

export function piModel(id) {
  return {
    id,
    name: id.startsWith('sk-') ? `SKGateway ${id}` : `SKGateway · ${id}`,
    reasoning: true,
    input: ['text'],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function updatePiConfig(config, ids, baseUrl) {
  if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
    throw new Error('Pi models file must contain a providers object');
  }
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))].sort();
  if (!unique.length) throw new Error('refusing to replace Pi catalog with an empty model list');
  return {
    ...config,
    providers: {
      ...config.providers,
      skgateway: {
        baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
        api: 'openai-completions',
        apiKey: 'not-needed',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: unique.map(piModel),
      },
    },
  };
}

export async function syncPiModels({ gatewayUrl = DEFAULT_GATEWAY, path = DEFAULT_PI_MODELS, dryRun = false, fetchFn = fetch } = {}) {
  const response = await fetchFn(`${gatewayUrl.replace(/\/$/, '')}/v1/models`);
  if (!response.ok) throw new Error(`SKGateway catalog request failed: HTTP ${response.status}`);
  const catalog = await response.json();
  const ids = Array.isArray(catalog.data) ? catalog.data.map((entry) => entry?.id) : [];
  const current = JSON.parse(await readFile(path, 'utf8'));
  const updated = updatePiConfig(current, ids, gatewayUrl);
  const text = `${JSON.stringify(updated, null, 2)}\n`;
  if (!dryRun) {
    const temporary = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.tmp`);
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  }
  return { modelCount: updated.providers.skgateway.models.length, bucketCount: ids.filter((id) => id?.startsWith('sk-')).length, changed: text !== `${JSON.stringify(current, null, 2)}\n`, dryRun };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--gateway-url') opts.gatewayUrl = argv[++i];
    else if (argv[i] === '--pi-models') opts.path = argv[++i];
    else if (argv[i] === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: sync-pi-models [--dry-run] [--gateway-url URL] [--pi-models PATH]');
      process.exit(0);
    }
    const result = await syncPiModels(opts);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`sync-pi-models: ${error.message}`);
    process.exit(1);
  }
}
