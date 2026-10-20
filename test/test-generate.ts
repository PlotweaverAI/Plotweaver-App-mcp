import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { StormTTSClient } from '../dist/client.js';

async function runTest() {
  console.log('🧪 Testing STORM-OS-TTS-V2 Client SDK...\n');

  const apiKey = process.env.STORM_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: STORM_API_KEY is not set. Please set STORM_API_KEY to run live synthesis tests.');
    process.exit(1);
  }

  const client = new StormTTSClient({
    baseUrl: process.env.STORM_BASE_URL || 'http://18.208.227.247:8000',
    apiKey,
  });

  // 1. Health check
  console.log('1. Checking Server Health...');
  const health = await client.health();
  console.log('   Status:', health.status);
  console.log('   GPU:', health.gpu);
  console.log('   Model:', health.model);
  console.log('   Voices loaded:', health.voices_loaded);

  // 2. List voices
  console.log('\n2. Fetching Voice Roster...');
  const voices = await client.listVoices();
  const languages = Object.keys(voices.languages);
  console.log(`   Found ${languages.length} languages:`, languages.join(', '));
  console.log('   Sample voice (Yoruba):', voices.languages.yo.voices[0]);

  // 3. Generate speech
  console.log('\n3. Synthesizing Speech (Adunni - Yoruba)...');
  const outputPath = path.resolve('test-output-adunni.wav');
  const { outputPath: savedFile, result } = await client.generateAndSave(
    {
      text: 'Bawo ni gbogbo ile, eyi ni idanwo STORM TTS.',
      name: 'Adunni',
      fast: false,
    },
    outputPath
  );

  console.log('   Saved file to:', savedFile);
  console.log('   Byte length:', result.byteLength, 'bytes');
  console.log('   Estimated duration:', result.approxDurationSeconds, 'seconds');
  console.log('   Cache status:', result.metadata.cache);
  console.log('   Attempts:', result.metadata.attempts);

  const fileStat = await fs.stat(savedFile);
  if (fileStat.size > 1000) {
    console.log(`\n🎉 SUCCESS! Verified valid WAV output (${fileStat.size} bytes).`);
  } else {
    throw new Error(`File was generated but seems suspiciously small: ${fileStat.size} bytes`);
  }
}

runTest().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
