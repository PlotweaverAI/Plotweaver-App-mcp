import { StormTTSClient } from '../dist/client.js';

// Initialize the client
const storm = new StormTTSClient({
  apiKey: process.env.STORM_API_KEY || 'your_storm_api_key_here',
  baseUrl: process.env.STORM_BASE_URL || 'http://18.208.227.247:8000',
});

async function main() {
  console.log('1. Fetching available voices...');
  const voices = await storm.listVoices();
  console.log('Languages supported:', Object.keys(voices.languages));

  console.log('\n2. Synthesizing Nigerian Pidgin speech...');
  const { outputPath, result } = await storm.generateAndSave(
    {
      text: 'Good morning! Make we code better things today.',
      name: 'Blessing', // Nigerian Pidgin female voice
    },
    './pidgin-greeting.wav'
  );

  console.log(`Audio saved to: ${outputPath}`);
  console.log(`Duration: ~${result.approxDurationSeconds}s`);
  console.log(`Cache: ${result.metadata.cache}`);
}

main().catch(console.error);
