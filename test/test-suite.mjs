import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StormTTSClient, normalizeSpeechText } from '../dist/client.js';
import { createStormMcpServer } from '../dist/server.js';
import { STORM_ENGINE_CONFIGS } from '../dist/types.js';

// Load local .env
dotenv.config();

const V2_KEY = process.env.STORM_API_KEY;
const V5_KEY = process.env.STORM_TTS_API_KEY || process.env.STORM_API_KEY;

if (!V2_KEY) {
  console.warn('⚠️ Warning: STORM_API_KEY is not set in environment or .env file.');
}
if (!V5_KEY) {
  console.warn('⚠️ Warning: STORM_TTS_API_KEY is not set in environment or .env file.');
}

const generatedTestFiles = [];

async function cleanupFiles() {
  for (const f of generatedTestFiles) {
    try {
      await fs.unlink(f);
    } catch {}
  }
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('🧪 STORM TTS Multilingual MCP & SDK Full Test Suite');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function assertStep(name, fn) {
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

  // --- 1. Multilingual Normalization Unit Tests ---
  console.log('--- 1. Emmanuel Ariyo Normalization Rules ---');

  await assertStep('Yorùbá Normalization (Currency, Symbols, Time)', () => {
    const raw = '**Ẹ kú àárọ̀**, owó náà jẹ́ ₦5,000 & 15% pásẹ́ntì ní 7:45 a.m.';
    const normalized = normalizeSpeechText(raw, 'yo');
    if (!normalized.includes('5,000 naira') || !normalized.includes('àti') || !normalized.includes('àárọ̀')) {
      throw new Error(`Yoruba normalization failed: "${normalized}"`);
    }
    if (normalized.includes('*')) {
      throw new Error(`Failed to strip markdown: "${normalized}"`);
    }
  });

  await assertStep('Igbo Normalization (Currency, Symbols, Time)', () => {
    const raw = 'Ego ya bụ ₦2,500 million na 10% n’ụtụtụ.';
    const normalized = normalizeSpeechText(raw, 'ig');
    if (!normalized.includes('2,500 nde naịra') || !normalized.includes('pasentị')) {
      throw new Error(`Igbo normalization failed: "${normalized}"`);
    }
  });

  await assertStep('Hausa Normalization (Currency, Symbols, Math)', () => {
    const raw = 'Kudin shi ne ₦10,000 & 50% + 5km.';
    const normalized = normalizeSpeechText(raw, 'ha');
    if (!normalized.includes('10,000 naira') || !normalized.includes('da') || !normalized.includes('5 kilomita') || !normalized.includes('50 kashi')) {
      throw new Error(`Hausa normalization failed: "${normalized}"`);
    }
  });

  await assertStep('Nigerian Pidgin Normalization (Currency & Slang Units)', () => {
    const raw = 'Bro, the money na ₦50k and 10% discount for morning.';
    const normalized = normalizeSpeechText(raw, 'pcm');
    if (!normalized.includes('50 thousand naira') || !normalized.includes('percent')) {
      throw new Error(`Pidgin normalization failed: "${normalized}"`);
    }
  });

  // --- 2. Dual Engine Capabilities & Client SDK Tests ---
  console.log('\n--- 2. Dual Engine SDK Tests (Model A & Model B) ---');

  const clientV2 = new StormTTSClient({
    engine: 'v2-cloning',
    apiKey: V2_KEY,
  });

  const clientV5 = new StormTTSClient({
    engine: 'v5-streaming',
    apiKey: V5_KEY,
  });

  await assertStep('Model A (V2-Cloning) Capabilities Detection', async () => {
    const caps = await clientV2.getCapabilities();
    if (caps.engine !== 'v2-cloning' || !caps.supportsVoiceCloning || caps.supportsStreaming) {
      throw new Error(`Unexpected V2 capabilities: ${JSON.stringify(caps)}`);
    }
  });

  await assertStep('Model B (v5-Streaming) Capabilities Detection', async () => {
    const caps = await clientV5.getCapabilities();
    if (caps.engine !== 'v5-streaming' || !caps.supportsStreaming || caps.supportsVoiceCloning) {
      throw new Error(`Unexpected v5 capabilities: ${JSON.stringify(caps)}`);
    }
  });

  await assertStep('Missing API Key Validation', async () => {
    const unauthedClient = new StormTTSClient({ engine: 'v2-cloning', apiKey: '' });
    let threw = false;
    try {
      await unauthedClient.listVoices();
    } catch (err) {
      threw = true;
      if (!err.message.includes('Missing API key')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) {
      throw new Error('Expected listVoices() without API key to throw validation error');
    }
  });

  await assertStep('Fetch Inbuilt Voices Roster (Model A - V2)', async () => {
    const roster = await clientV2.listVoices();
    const langs = Object.keys(roster.languages);
    if (!langs.includes('yo') || !langs.includes('pcm') || !langs.includes('en')) {
      throw new Error(`Missing expected languages: ${langs.join(', ')}`);
    }
  });

  await assertStep('Fetch Inbuilt Speakers Roster (Model B - v5)', async () => {
    const roster = await clientV5.listVoices();
    const langs = Object.keys(roster.languages);
    if (!langs.includes('yo') || !langs.includes('ha') || !langs.includes('pcm')) {
      throw new Error(`Missing expected languages on v5: ${langs.join(', ')}`);
    }
    const yorubaSpeakers = (roster.languages.yo.speakers || []).map((s) => s.name);
    if (!yorubaSpeakers.includes('Morenike')) {
      throw new Error(`Expected 'Morenike' in v5 Yoruba speakers, got: ${yorubaSpeakers.join(', ')}`);
    }
  });

  await assertStep('Model A (V2): Batch Speech Synthesis & WAV Save', async () => {
    const outPath = path.resolve('./temp-sdk-v2-test.wav');
    generatedTestFiles.push(outPath);
    const { outputPath, result } = await clientV2.generateAndSave(
      {
        text: 'Idanwo V2 PlotWeaver',
        name: 'Adunni',
        fast: true,
      },
      outPath
    );
    if (result.byteLength < 1000) {
      throw new Error(`Suspiciously small audio buffer: ${result.byteLength} bytes`);
    }
    const stat = await fs.stat(outputPath);
    if (stat.size !== result.byteLength) {
      throw new Error(`Saved file size (${stat.size}) does not match buffer (${result.byteLength})`);
    }
  });

  await assertStep('Model B (v5): HTTP Chunked Streaming (/generate/stream)', async () => {
    let chunkCount = 0;
    let totalBytes = 0;
    for await (const chunk of clientV5.streamSpeech({
      text: 'Good morning from the fast streaming vLLM engine.',
      name: 'Blessing',
      lang: 'pcm',
      fast: true,
    })) {
      chunkCount++;
      totalBytes += chunk.byteLength;
    }
    if (chunkCount === 0 || totalBytes < 5000) {
      throw new Error(`Streaming failed: received ${chunkCount} chunks, ${totalBytes} bytes`);
    }
  });

  await assertStep('Model B (v5): Persistent WebSocket Streaming (WS /generate/stream/ws)', async () => {
    const session = clientV5.createWebSocketSession();
    let receivedChunks = 0;
    let totalBytes = 0;

    try {
      const doneEvent = await session.synthesize({
        text: 'Ẹ kú àárọ̀ o, èyí jẹ́ ìdánwò wẹ́bù-sọ́kẹ́ẹ̀tì.',
        lang: 'yo',
        name: 'Morenike',
        fast: true,
        onChunk: (chunk) => {
          receivedChunks++;
          totalBytes += chunk.length;
        },
      });

      if (doneEvent.event !== 'done' || receivedChunks === 0 || totalBytes < 5000) {
        throw new Error(`WebSocket streaming failed: ${JSON.stringify(doneEvent)}, received ${receivedChunks} chunks`);
      }
    } finally {
      session.close();
    }
  });

  await assertStep('Model B (v5): John Voice Generation & Alias Resolution (English & Pidgin)', async () => {
    // Test Nigerian English with voice: 'John' (maps to speaker_id: 'slr70_ngm_09334')
    const resEn = await clientV5.generate({
      text: 'Good evening. This is John delivering the national news headlines with clarity and authority.',
      name: 'John',
      fast: true,
    });
    if (resEn.byteLength < 5000) {
      throw new Error(`John English audio too small: ${resEn.byteLength} bytes`);
    }

    // Test Nigerian Pidgin with voice: 'John'
    const resPidgin = await clientV5.generate({
      text: 'Wetin dey happen? John dey yarn correct Nigerian Pidgin for all of una.',
      name: 'John',
      lang: 'pcm',
      fast: true,
    });
    if (resPidgin.byteLength < 5000) {
      throw new Error(`John Pidgin audio too small: ${resPidgin.byteLength} bytes`);
    }
  });

  // --- 3. MCP Server Protocol End-to-End Tests ---
  console.log('\n--- 3. Model Context Protocol (MCP) Server Tests ---');

  const mcpServer = createStormMcpServer({ v2: clientV2, v5: clientV5 }, { sandboxRoot: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await mcpServer.connect(serverTransport);
  const mcpClient = new Client({ name: 'test-runner', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(clientTransport);

  await assertStep('List MCP Tools Registration', async () => {
    const toolList = await mcpClient.listTools();
    const names = toolList.tools.map((t) => t.name);
    const requiredTools = ['storm_tts_speak', 'storm_tts_clone_voice', 'storm_tts_list_voices', 'storm_tts_health'];
    for (const req of requiredTools) {
      if (!names.includes(req)) {
        throw new Error(`Missing registered tool: ${req}`);
      }
    }
  });

  await assertStep('Call Tool: storm_tts_health', async () => {
    const res = await mcpClient.callTool({ name: 'storm_tts_health', arguments: {} });
    if (res.isError) {
      throw new Error(`Tool returned error: ${JSON.stringify(res)}`);
    }
    const text = res.content[0]?.text || '';
    if (!text.includes('STATUS: OK') && !text.includes('Status: OK')) {
      throw new Error(`Unexpected health output: ${text}`);
    }
  });

  await assertStep('Call Tool: storm_tts_list_voices', async () => {
    const res = await mcpClient.callTool({ name: 'storm_tts_list_voices', arguments: { language: 'yo' } });
    if (res.isError) {
      throw new Error(`Tool returned error: ${JSON.stringify(res)}`);
    }
    const text = res.content[0]?.text || '';
    if (!text.includes('Adunni') && !text.includes('Morenike')) {
      throw new Error(`Missing expected voices in table: ${text}`);
    }
  });

  await assertStep('Call Tool: storm_tts_speak (Synthesis via MCP)', async () => {
    const testFile = path.resolve('./temp-mcp-test.wav');
    generatedTestFiles.push(testFile);
    const res = await mcpClient.callTool({
      name: 'storm_tts_speak',
      arguments: {
        text: 'Good morning from PlotWeaver MCP Server.',
        voice: 'Blessing',
        fast: true,
        outputPath: testFile,
      },
    });
    if (res.isError) {
      throw new Error(`Tool returned error: ${res.content[0]?.text}`);
    }
    const text = res.content[0]?.text || '';
    if (!text.includes('Generated STORM-OS speech audio successfully')) {
      throw new Error(`Unexpected tool output: ${text}`);
    }
    const stat = await fs.stat(testFile);
    if (stat.size < 1000) {
      throw new Error(`Generated file too small: ${stat.size} bytes`);
    }
  });

  await assertStep('Call Tool: storm_tts_speak with John Voice', async () => {
    const testFileJohn = path.resolve('./temp-mcp-john-test.wav');
    generatedTestFiles.push(testFileJohn);
    const res = await mcpClient.callTool({
      name: 'storm_tts_speak',
      arguments: {
        text: 'Good evening. This is John speaking through the Model Context Protocol server, with clear news for everyone.',
        voice: 'John',
        fast: true,
        outputPath: testFileJohn,
      },
    });
    if (res.isError) {
      throw new Error(`Tool returned error: ${res.content[0]?.text}`);
    }
    const stat = await fs.stat(testFileJohn);
    if (stat.size < 1000) {
      throw new Error(`Generated John audio too small: ${stat.size} bytes`);
    }
  });

  await assertStep('List & Read MCP Resources', async () => {
    const resList = await mcpClient.listResources();
    const uris = resList.resources.map((r) => r.uri);
    if (!uris.includes('storm://health') || !uris.includes('storm://voices')) {
      throw new Error(`Missing resources: ${uris.join(', ')}`);
    }
    const healthRes = await mcpClient.readResource({ uri: 'storm://health' });
    const parsed = JSON.parse(healthRes.contents[0].text);
    if (parsed.status !== 'ok') {
      throw new Error(`Resource health status is ${parsed.status}`);
    }
  });

  await assertStep('List MCP Prompts', async () => {
    const promptList = await mcpClient.listPrompts();
    const names = promptList.prompts.map((p) => p.name);
    if (!names.includes('storm_tts_guide')) {
      throw new Error(`Missing prompt storm_tts_guide`);
    }
  });

  await mcpClient.close();
  await mcpServer.close();

  // Cleanup
  await cleanupFiles();

  console.log('\n====================================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(async (err) => {
  await cleanupFiles();
  console.error('\nFatal test suite error:', err);
  process.exit(1);
});
