// Live test of the public HTTP gateway. Starts the built server as a real process, creates a user
// key with the CLI, and connects over HTTP the way a remote MCP client does.
// Requires STORM_API_KEY and STORM_TTS_API_KEY (from .env or the environment).
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

dotenv.config();

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(projectDir, 'dist', 'index.js');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-live-gateway-'));
const keysFile = path.join(dir, 'keys.json');
const port = 8700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, STORM_GATEWAY_KEYS: keysFile, STORM_GATEWAY_PORT: String(port), STORM_GATEWAY_HOST: '127.0.0.1' };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd: projectDir });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

let passed = 0;
let failed = 0;
async function step(name, fn) {
  process.stdout.write(`• ${name}... `);
  try {
    await fn();
    console.log('✅ PASS');
    passed++;
  } catch (err) {
    console.log('❌ FAIL');
    console.error('  Error:', err.message || err);
    failed++;
  }
}

const text = (res) => res.content?.[0]?.text ?? '';

console.log('====================================================');
console.log('🧪 STORM TTS live HTTP gateway test');
console.log('====================================================');

const created = await run(['keys', 'create', 'live-test', '--rpm', '60', '--daily', '5000']);
const keyLine = created.trim().split('\n').pop();
if (!keyLine.startsWith('stm_')) throw new Error('keys create did not print a key');

const server = spawn(process.execPath, [entry, 'http'], { env, cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (d) => (serverLog += d));

let client;
try {
  // Wait for the gateway to accept connections.
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  await step('Health check answers without a key', async () => {
    const res = await fetch(`${base}/healthz`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
  });

  await step('MCP refuses a request with no key', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });

  client = new Client({ name: 'live-gateway-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${keyLine}` } },
  });
  await client.connect(transport);

  await step('Connects over HTTP with a valid key and lists the tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    if (names.length !== 4) throw new Error(`tools: ${names.join(', ')}`);
  });

  await step('Lists voices from the live servers', async () => {
    const res = await client.callTool({ name: 'storm_tts_list_voices', arguments: { language: 'yo' } });
    if (res.isError) throw new Error(text(res));
    if (!/Adunni|Morenike/.test(text(res))) throw new Error(text(res));
  });

  await step('Speaks a V2 voice and returns WAV audio inside the response (no file written)', async () => {
    const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Ẹ kú àárọ̀, ẹ kú iṣẹ́.', voice: 'Adunni' } });
    if (res.isError) throw new Error(text(res));
    const audio = res.content.find((c) => c.type === 'audio');
    if (!audio || audio.mimeType !== 'audio/wav') throw new Error('no WAV audio in result');
    const wav = Buffer.from(audio.data, 'base64');
    if (wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('audio is not a RIFF/WAVE file');
  });

  await step('Speaks John (v5) through the gateway', async () => {
    const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Good evening. This is John delivering the news with clarity.', voice: 'John' } });
    if (res.isError) throw new Error(text(res));
    if (!res.content.some((c) => c.type === 'audio')) throw new Error('no audio for John');
  });

  await step('Refuses a voice that does not exist, with the list of real voices', async () => {
    const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Hello', voice: 'NoSuchVoice' } });
    if (!res.isError) throw new Error('expected an error');
    if (!/Unknown voice/.test(text(res))) throw new Error(text(res));
  });

  await step('Lists the voice resource', async () => {
    const res = await client.readResource({ uri: 'storm://voices' });
    const list = JSON.parse(res.contents[0].text);
    if (!Array.isArray(list) || list.length === 0) throw new Error('no voices');
  });

  await step('A disabled key is refused on a new connection', async () => {
    await run(['keys', 'disable', 'live-test']);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${keyLine}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });
} catch (err) {
  console.error('Fatal:', err.message || err);
  failed++;
} finally {
  await client?.close().catch(() => {});
  server.kill('SIGTERM');
  await fs.rm(dir, { recursive: true, force: true });
}

if (failed > 0 && serverLog) console.error('Gateway log:\n' + serverLog.split('\n').slice(-20).join('\n'));
console.log('\n====================================================');
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log('====================================================\n');
process.exit(failed > 0 ? 1 : 0);
