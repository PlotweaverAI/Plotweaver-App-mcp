#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as dotenv from 'dotenv';
import { createStormMcpServer, type StormClients } from './server.js';
import { StormTTSClient } from './client.js';
import { startGateway } from './gateway.js';
import { KeyStore } from './keys.js';

// Load .env if present
dotenv.config();

// Export the SDK and components for programmatic usage by other developers
export { StormTTSClient, StormWebSocketSession, normalizeSpeechText, resolveSpeaker } from './client.js';
export { createStormMcpServer, resolveSandboxedPath, type StormClients, type StormMcpOptions } from './server.js';
export { VoiceCatalog, type CatalogVoice, type VoiceRoute, type EndpointName } from './catalog.js';
export { startGateway, type GatewayConfig } from './gateway.js';
export { KeyStore, type PublicKey } from './keys.js';
export { Concurrency, RateLimiter, DailyQuota, LimitError } from './limits.js';
export { VOICE_OVERRIDES } from './voice-overrides.js';
export * from './types.js';

/**
 * Builds one client per configured endpoint. Each key is paired only with its own host:
 * - STORM_API_KEY + STORM_BASE_URL   -> V2 (auto-detects, so a v5 URL here also works)
 * - STORM_TTS_API_KEY + STORM_TTS_BASE_URL -> v5 streaming
 */
export function clientsFromEnv(env: NodeJS.ProcessEnv = process.env): StormClients {
  const clients: StormClients = {};

  if (env.STORM_API_KEY) {
    clients.v2 = new StormTTSClient({
      engine: 'auto',
      apiKey: env.STORM_API_KEY,
      baseUrl: env.STORM_BASE_URL,
    });
  }

  if (env.STORM_TTS_API_KEY) {
    clients.v5 = new StormTTSClient({
      engine: 'v5-streaming',
      apiKey: env.STORM_TTS_API_KEY,
      baseUrl: env.STORM_TTS_BASE_URL,
    });
  }

  return clients;
}

function defaultEngineFromEnv(): 'v2-cloning' | 'v5-streaming' {
  return process.env.STORM_ENGINE === 'v5-streaming' ? 'v5-streaming' : 'v2-cloning';
}

function keyStoreFromEnv(): KeyStore {
  return new KeyStore(process.env.STORM_GATEWAY_KEYS || path.join(process.cwd(), 'gateway-keys.json'));
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`);
  return value;
}

/** Default mode: MCP over stdio, started by a desktop app on this machine. */
async function runStdio(): Promise<void> {
  const clients = clientsFromEnv();

  if (!clients.v2 && !clients.v5) {
    console.error('[STORM MCP] Warning: no API key set. Set STORM_API_KEY (V2) and/or STORM_TTS_API_KEY (v5) in the environment or .env.');
  }

  const server = createStormMcpServer(clients, { defaultEngine: defaultEngineFromEnv() });
  await server.connect(new StdioServerTransport());

  const endpoints = [clients.v2 && `v2: ${clients.v2.baseUrl}`, clients.v5 && `v5: ${clients.v5.baseUrl}`]
    .filter(Boolean)
    .join(', ');
  console.error(`STORM TTS MCP Server running on stdio (${endpoints || 'no endpoints configured'})`);
}

/** Public mode: MCP over HTTP for people who connect with a gateway key. */
async function runHttp(): Promise<void> {
  const clients = clientsFromEnv();
  if (!clients.v2 && !clients.v5) {
    throw new Error('No STORM endpoint is configured. Set STORM_API_KEY and/or STORM_TTS_API_KEY.');
  }

  const gateway = await startGateway({
    port: intFromEnv('STORM_GATEWAY_PORT', 8787),
    host: process.env.STORM_GATEWAY_HOST || '127.0.0.1',
    keyStore: keyStoreFromEnv(),
    usageFile: process.env.STORM_GATEWAY_USAGE || path.join(path.dirname(process.env.STORM_GATEWAY_KEYS || path.join(process.cwd(), 'gateway-keys.json')), 'usage.json'),
    clients,
    defaultEngine: defaultEngineFromEnv(),
    requestsPerMinute: intFromEnv('STORM_GATEWAY_RPM', 30),
    dailyCharacters: intFromEnv('STORM_GATEWAY_DAILY_CHARS', 20000),
    concurrency: {
      v2: intFromEnv('STORM_V2_CONCURRENCY', 1),
      v5: intFromEnv('STORM_V5_CONCURRENCY', 8),
    },
  });

  const shutdown = () => {
    gateway.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.error(`STORM TTS MCP gateway listening at ${gateway.url}/mcp`);
}

/** Key management: create, list, disable. Keys are shown once, at creation. */
async function runKeys(args: string[]): Promise<void> {
  const store = keyStoreFromEnv();
  const [command, ...rest] = args;

  if (command === 'create') {
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) throw new Error('Usage: storm-tts-mcp keys create <name> [--rpm N] [--daily N]');
    const rpm = optionValue(rest, '--rpm');
    const daily = optionValue(rest, '--daily');
    const { key, record } = await store.create(name, {
      ...(rpm !== undefined && { requestsPerMinute: rpm }),
      ...(daily !== undefined && { dailyCharacters: daily }),
    });
    console.log(`Created key for "${record.name}" (id ${record.id}).`);
    console.log('Copy it now. It cannot be shown again:');
    console.log(key);
    return;
  }

  if (command === 'list') {
    const keys = await store.list();
    if (keys.length === 0) {
      console.log('No keys yet.');
      return;
    }
    for (const k of keys) {
      const status = k.disabled ? 'disabled' : 'active';
      console.log(`${k.name}\t${status}\tid=${k.id}\tcreated=${k.createdAt}`);
    }
    return;
  }

  if (command === 'disable') {
    const target = rest[0];
    if (!target) throw new Error('Usage: storm-tts-mcp keys disable <name-or-id>');
    const record = await store.disable(target);
    console.log(`Disabled key "${record.name}" (id ${record.id}).`);
    return;
  }

  throw new Error('Usage: storm-tts-mcp keys <create|list|disable> ...');
}

function optionValue(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a positive whole number.`);
  return value;
}

/**
 * Check if current file is the direct CLI entrypoint, supporting symlinks, npx, and global binaries.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = fs.realpathSync(process.argv[1]);
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return entryPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [mode, ...args] = process.argv.slice(2);
  const main =
    mode === 'http'
      ? runHttp()
      : mode === 'keys'
        ? runKeys(args)
        : runStdio();
  main.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
