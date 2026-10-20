#!/usr/bin/env node

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as dotenv from 'dotenv';
import { createStormMcpServer } from './server.js';
import { StormTTSClient } from './client.js';

// Load .env if present
dotenv.config();

// Export the SDK and components for programmatic usage by other developers
export { StormTTSClient, StormWebSocketSession, normalizeSpeechText, resolveSpeaker } from './client.js';
export { createStormMcpServer } from './server.js';
export * from './types.js';

/**
 * Main execution when invoked as a binary / MCP server via npx or node
 */
async function run() {
  const apiKey = process.env.STORM_API_KEY || process.env.STORM_TTS_API_KEY;
  const baseUrl = process.env.STORM_BASE_URL || process.env.STORM_TTS_BASE_URL;
  const engine = (process.env.STORM_ENGINE as any) || 'auto';

  if (!apiKey) {
    console.error('[STORM MCP] Warning: STORM_API_KEY / STORM_TTS_API_KEY is not set. Please supply credentials in environment or .env.');
  }

  const client = new StormTTSClient({
    apiKey,
    baseUrl,
    engine,
  });

  const server = createStormMcpServer(client);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`STORM TTS MCP Server running on stdio (${client.baseUrl})`);
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
  run().catch((error) => {
    console.error('Fatal error running STORM MCP Server:', error);
    process.exit(1);
  });
}
