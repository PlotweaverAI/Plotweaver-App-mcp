// Live end-to-end test: launches the built MCP server as a subprocess over stdio,
// exactly as Claude Desktop / Cursor do, and calls its tools against the real STORM endpoints.
// Requires STORM_API_KEY and STORM_TTS_API_KEY (read from .env or the environment).
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

dotenv.config();

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-live-mcp-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDir, 'dist', 'index.js')],
  cwd: projectDir,
  env: { ...process.env, STORM_MCP_ROOT: sandbox },
  stderr: 'pipe',
});
const client = new Client({ name: 'live-mcp-test', version: '1.0.0' }, { capabilities: {} });

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

function text(res) {
  return res.content?.[0]?.text ?? '';
}

async function isRiffWav(file) {
  const buf = await fs.readFile(file);
  return buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

async function callOk(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} returned error: ${text(res)}`);
  return res;
}

console.log('====================================================');
console.log('🧪 STORM TTS live MCP end-to-end test (stdio)');
console.log(`   sandbox: ${sandbox}`);
console.log('====================================================');

try {
  await client.connect(transport);

  await step('Server starts and lists the four tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ['storm_tts_clone_voice', 'storm_tts_health', 'storm_tts_list_voices', 'storm_tts_speak'];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`tools: ${names.join(', ')}`);
  });

  await step('storm_tts_health reports a live endpoint', async () => {
    const res = await callOk('storm_tts_health', {});
    if (!/Status: OK/i.test(text(res))) throw new Error(text(res));
  });

  await step('storm_tts_list_voices returns the Yorùbá roster', async () => {
    const res = await callOk('storm_tts_list_voices', { language: 'yo' });
    if (!text(res).includes('Adunni') && !text(res).includes('Morenike')) throw new Error(text(res));
  });

  await step('storm_tts_speak (V2 voice Adunni) writes a real WAV into the sandbox', async () => {
    await callOk('storm_tts_speak', { text: 'Ẹ kú àárọ̀, ẹ kú iṣẹ́.', voice: 'Adunni', outputPath: 'adunni.wav' });
    const file = path.join(sandbox, 'adunni.wav');
    if (!(await isRiffWav(file))) throw new Error('adunni.wav is not a RIFF/WAVE file');
  });

  await step('storm_tts_speak (v5 voice John) routes to v5 and writes a real WAV', async () => {
    await callOk('storm_tts_speak', {
      text: 'Good evening. This is John delivering the news with clarity.',
      voice: 'John',
      outputPath: 'john.wav',
    });
    if (!(await isRiffWav(path.join(sandbox, 'john.wav')))) throw new Error('john.wav is not a RIFF/WAVE file');
  });

  await step('storm_tts_speak by language (Pidgin) uses the default file name in the sandbox', async () => {
    const res = await callOk('storm_tts_speak', { text: 'Wetin dey happen? Everything dey alright.', language: 'pcm' });
    const match = text(res).match(/Saved Audio File\*\*: (.+)/);
    if (!match) throw new Error(`no saved path in: ${text(res)}`);
    const saved = match[1].trim();
    // Resolve both sides: on macOS /var is a symlink to /private/var.
    const savedDir = await fs.realpath(path.dirname(saved));
    if (savedDir !== (await fs.realpath(sandbox))) throw new Error(`saved outside sandbox: ${saved}`);
    if (!(await isRiffWav(saved))) throw new Error('default-named output is not a WAV');
  });

  await step('storm_tts_speak refuses a path that escapes the sandbox, and writes nothing', async () => {
    const escape = path.join(os.tmpdir(), `storm-escape-${Date.now()}.wav`);
    const res = await client.callTool({
      name: 'storm_tts_speak',
      arguments: { text: 'Hello there.', voice: 'Adunni', outputPath: escape },
    });
    if (!res.isError) throw new Error('expected an error for an escaping path');
    if (!/inside the allowed directory/.test(text(res))) throw new Error(text(res));
    await fs.access(escape).then(
      () => {
        throw new Error('file was written outside the sandbox');
      },
      () => {}
    );
  });

  await step('storm_tts_clone_voice clones from a sandboxed reference clip', async () => {
    // Use a longer clip as the reference so it's within the 4–8 s range the cloning model expects.
    await callOk('storm_tts_speak', {
      text:
        'Good morning everybody, welcome to the programme. Today we are going to talk about the weather, the market, and the football results from last weekend. Stay with us.',
      voice: 'Amina',
      outputPath: 'reference.wav',
    });
    await callOk('storm_tts_clone_voice', {
      text: 'This is my cloned voice speaking Yorùbá now.',
      referenceAudioPath: 'reference.wav',
      language: 'yo',
      outputPath: 'cloned.wav',
    });
    if (!(await isRiffWav(path.join(sandbox, 'cloned.wav')))) throw new Error('cloned.wav is not a WAV');
  });

  await step('Clone refuses a reference file outside the sandbox', async () => {
    const res = await client.callTool({
      name: 'storm_tts_clone_voice',
      arguments: { text: 'Hello.', referenceAudioPath: '/etc/hosts', language: 'en' },
    });
    if (!res.isError) throw new Error('expected an error');
    if (!/inside the allowed directory|Only \.wav/.test(text(res))) throw new Error(text(res));
  });

  await step('Resources storm://health and storm://voices are readable', async () => {
    const health = await client.readResource({ uri: 'storm://health' });
    if (JSON.parse(health.contents[0].text).status !== 'ok') throw new Error('health status not ok');
    const voices = await client.readResource({ uri: 'storm://voices' });
    if (!Array.isArray(JSON.parse(voices.contents[0].text)) || JSON.parse(voices.contents[0].text).length === 0) throw new Error('no voices listed');
  });
} catch (err) {
  console.error('Fatal:', err);
  failed++;
} finally {
  await client.close().catch(() => {});
  await fs.rm(sandbox, { recursive: true, force: true });
}

console.log('\n====================================================');
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log('====================================================\n');
process.exit(failed > 0 ? 1 : 0);
