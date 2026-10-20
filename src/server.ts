import * as path from 'node:path';
import * as os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StormTTSClient } from './client.js';
import type { StormLanguageCode, StormVoiceName } from './types.js';

export function createStormMcpServer(client?: StormTTSClient): McpServer {
  const stormClient = client ?? new StormTTSClient();

  const server = new McpServer({
    name: 'storm-tts-mcp',
    version: '1.0.0',
  });

  // 1. Tool: storm_tts_speak
  server.tool(
    'storm_tts_speak',
    'Generate high-fidelity Nigerian speech (WAV audio) from text using STORM TTS. Supports Nigerian English (en), Nigerian Pidgin (pcm), Yoruba (yo), Hausa (ha), and Igbo (ig).',
    {
      text: z.string().min(1).max(1000).describe('The text to speak (maximum 1000 characters). Tone marks are supported for Yoruba and Igbo.'),
      voice: z
        .enum([
          'John',
          'slr70_ngm_09334',
          'Adunni',
          'Kayode',
          'Morenike',
          'Adewale',
          'Amina',
          'Sani',
          'Ngozi',
          'Chinedu',
          'Adaeze',
          'Chidi',
          'Blessing',
          'Chuks',
          'Emeka',
          'David',
          'Yemi',
        ])
        .optional()
        .describe('Specific native voice name (e.g., "John" for Nigerian English & Pidgin, "Adunni"/"Morenike" for Yoruba, "Blessing"/"Emeka" for Pidgin, "David"/"Yemi" for Nigerian English). If omitted, language parameter will auto-select the best voice.'),
      language: z
        .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
        .optional()
        .describe("Language code: 'yo' (Yoruba), 'ha' (Hausa), 'ig' (Igbo), 'pcm' (Nigerian Pidgin), 'en' (Nigerian English). Auto-picks primary voice if voice is not specified."),
      outputPath: z
        .string()
        .optional()
        .describe('Optional path on disk to save the WAV file. If not provided, saves into the current directory with a descriptive timestamped filename.'),
      fast: z
        .boolean()
        .optional()
        .default(true)
        .describe('Set to true (default) for lowest latency speech generation. Set to false to enable multi-attempt QC checks.'),
    },
    async ({ text, voice, language, outputPath, fast }) => {
      try {
        if (!voice && !language) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Error: You must provide either a "voice" (e.g. "Adunni", "Blessing") or a "language" code (e.g. "yo", "pcm").',
              },
            ],
          };
        }

        const effectiveLang = language as StormLanguageCode | undefined;
        const effectiveVoice = voice as StormVoiceName | undefined;

        const defaultFileName = `storm_tts_${(effectiveVoice || effectiveLang || 'audio').toLowerCase()}_${Date.now()}.wav`;
        const targetPath = outputPath ? path.resolve(outputPath) : path.resolve(process.cwd(), defaultFileName);

        const { outputPath: savedPath, result } = await stormClient.generateAndSave(
          {
            text,
            name: effectiveVoice,
            lang: effectiveLang,
            fast: fast ?? true,
          },
          targetPath
        );

        const durationStr = `${result.approxDurationSeconds.toFixed(1)}s`;
        const sizeStr = `${(result.byteLength / 1024).toFixed(1)} KB`;
        const cacheStr = result.metadata.cache === 'HIT' ? 'Cache Hit' : 'Fresh Generation';
        const attemptsStr = result.metadata.attempts ? ` (${result.metadata.attempts} QC attempts)` : '';

        return {
          content: [
            {
              type: 'text',
              text: `✅ Generated STORM-OS speech audio successfully!

- **Saved Audio File**: ${savedPath}
- **Voice Used**: ${effectiveVoice || 'Auto (' + effectiveLang + ')'}
- **Language**: ${effectiveLang || 'Native to voice'}
- **Audio Specs**: 24kHz 16-bit Mono WAV, ~${durationStr} (${sizeStr})
- **Status**: ${cacheStr}${attemptsStr}
- **Text Spoken**: "${text}"`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `STORM-OS TTS Generation Failed: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  // 2. Tool: storm_tts_clone_voice
  server.tool(
    'storm_tts_clone_voice',
    'Clone any custom speaker voice from a 4-8 second WAV reference audio clip and generate new speech in Yoruba, Hausa, Igbo, Pidgin, or Nigerian English.',
    {
      text: z.string().min(1).max(1000).describe('Text to speak in the cloned voice (up to 1000 characters).'),
      referenceAudioPath: z.string().describe('Absolute or relative path to a 4-8 second audio sample of the voice to clone.'),
      language: z
        .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
        .describe("Target language code: 'yo' (Yoruba), 'ha' (Hausa), 'ig' (Igbo), 'pcm' (Nigerian Pidgin), 'en' (Nigerian English)."),
      outputPath: z
        .string()
        .optional()
        .describe('Optional path on disk to save the cloned WAV audio file.'),
      fast: z
        .boolean()
        .optional()
        .default(true)
        .describe('Set to true (default) to skip retry/QC loop for faster turnaround. Set to false for full QC loop.'),
    },
    async ({ text, referenceAudioPath, language, outputPath, fast }) => {
      try {
        const defaultFileName = `storm_cloned_${language}_${Date.now()}.wav`;
        const targetPath = outputPath ? path.resolve(outputPath) : path.resolve(process.cwd(), defaultFileName);

        const { outputPath: savedPath, result } = await stormClient.generateAndSave(
          {
            text,
            lang: language as StormLanguageCode,
            referenceAudio: referenceAudioPath,
            fast: fast ?? true,
          },
          targetPath
        );

        return {
          content: [
            {
              type: 'text',
              text: `✅ Generated voice-cloned speech successfully!

- **Saved Audio File**: ${savedPath}
- **Reference Audio**: ${referenceAudioPath}
- **Language**: ${language}
- **Audio Specs**: 24kHz 16-bit Mono WAV, ~${result.approxDurationSeconds.toFixed(1)}s (${(result.byteLength / 1024).toFixed(1)} KB)
- **Generation Time**: ${result.metadata.generationTimeSeconds ? result.metadata.generationTimeSeconds.toFixed(2) + 's' : 'Cached'}
- **Text Spoken**: "${text}"`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `STORM-OS Voice Cloning Failed: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  // 3. Tool: storm_tts_list_voices
  server.tool(
    'storm_tts_list_voices',
    'List all available built-in voices in STORM-OS-TTS-V2, grouped by language, gender, and training data hours.',
    {
      language: z
        .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
        .optional()
        .describe('Optional language filter (yo, ha, ig, pcm, en) to view voices for a specific language only.'),
    },
    async ({ language }) => {
      try {
        const catalog = await stormClient.listVoices();
        const caps = await stormClient.getCapabilities();

        let markdown = `# STORM TTS Voices Roster (${caps.engine === 'v5-streaming' ? 'STORM v5 vLLM' : 'STORM-OS-TTS-V2'})\n\n`;
        markdown += `| Voice / Speaker | Language | Gender | Training Corpus Hours |\n`;
        markdown += `| :--- | :--- | :--- | :--- |\n`;

        for (const [langCode, group] of Object.entries(catalog.languages)) {
          if (language && langCode !== language) continue;
          const list = group.voices || group.speakers || [];
          for (const voice of list) {
            const genderStr =
              voice.gender === 'F' || voice.gender === 'female'
                ? 'Female'
                : voice.gender === 'M' || voice.gender === 'male'
                ? 'Male'
                : 'Standard';
            const hoursStr = voice.hours !== undefined ? `${Number(voice.hours).toFixed(1)}h` : 'N/A';
            const displayName =
              voice.name === 'slr70_ngm_09334'
                ? '**John** (`slr70_ngm_09334`)'
                : voice.name === 'John'
                ? '**John** (Nigerian English & Pidgin Flagship)'
                : `**${voice.name}**`;
            markdown += `| ${displayName} | ${group.label} (\`${langCode}\`) | ${genderStr} | ${hoursStr} |\n`;
          }
        }

        markdown += `\n**Engine Capabilities:**\n`;
        markdown += `- **Active Engine**: \`${caps.engine}\` (${caps.baseUrl})\n`;
        markdown += `- **Real-time Streaming**: ${caps.supportsStreaming ? '✅ Supported (HTTP & WebSocket)' : '❌ (Requires v5-streaming)'}\n`;
        markdown += `- **Voice Cloning**: ${caps.supportsVoiceCloning ? '✅ Supported (4-8s audio)' : '❌ (Requires v2-cloning)'}\n`;

        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to fetch voices: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  // 4. Tool: storm_tts_health
  server.tool(
    'storm_tts_health',
    'Check server health, active engine (v2-cloning vs v5-streaming), GPU hardware, and streaming capabilities.',
    {},
    async () => {
      try {
        const health = await stormClient.health();
        const caps = await stormClient.getCapabilities();

        const modelStr = health.model || health.model_repo || 'STORM TTS';
        const gpuStr = health.gpu || health.gpu_name || 'NVIDIA GPU';
        const streamingStr = caps.supportsStreaming ? 'Enabled (HTTP Chunked & WebSocket)' : 'Disabled (Batch WAV only)';
        const cloningStr = caps.supportsVoiceCloning ? 'Enabled (Zero-shot reference audio)' : 'Disabled (Preset voices)';

        return {
          content: [
            {
              type: 'text',
              text: `STORM TTS Inference Server Status:
- Status: ${health.status.toUpperCase()}
- Engine: ${caps.engine} (${stormClient.baseUrl})
- Model: ${modelStr}
- Hardware: ${gpuStr} (${health.device || 'cuda'})
- Real-time Streaming: ${streamingStr}
- Voice Cloning: ${cloningStr}
- Loaded Voices: ${health.voices_loaded ?? 'Available'}
- Server Cache: ${health.cache_size ?? 0} items${health.uptime_seconds ? `\n- Server Uptime: ${(health.uptime_seconds / 86400).toFixed(1)} days` : ''}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `STORM Health Check Failed: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  // MCP Resource: storm://voices
  server.resource('storm-voices', 'storm://voices', async (uri) => {
    const catalog = await stormClient.listVoices();
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(catalog, null, 2),
          mimeType: 'application/json',
        },
      ],
    };
  });

  // MCP Resource: storm://health
  server.resource('storm-health', 'storm://health', async (uri) => {
    const health = await stormClient.health();
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(health, null, 2),
          mimeType: 'application/json',
        },
      ],
    };
  });

  // MCP Prompt: storm_tts_prompt_guide
  server.prompt(
    'storm_tts_guide',
    'Best practices and pronunciation guidelines for generating Nigerian speech with STORM TTS.',
    {
      language: z.enum(['yo', 'ha', 'ig', 'pcm', 'en']).optional().describe('Target language code'),
    },
    async ({ language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `You are generating speech using STORM TTS${language ? ' in language ' + language : ''}.
Guidelines:
1. Nigerian English (en) & Pidgin (pcm): Flagship broadcast voice: "John" (catalogue ID 'slr70_ngm_09334'). Best voice for news, banking, and conversational AI. Note: Frontend audio players should set playbackRate = 1.25 for John's trademark crisp broadcast pace. Also available: David (V2), Yemi (v5).
2. Nigerian Pidgin (pcm): Top female voice: Blessing, top male voice: Emeka / Chuks, and John for authoritative news delivery.
3. Yoruba (yo): Include diacritics and tone marks (ẹ, ọ, ṣ, à, á) for natural cadence and accurate pronunciation. Top female voice: Adunni (V2) / Morenike (v5), top male voice: Kayode (V2) / Adewale (v5).
4. Hausa (ha): Top female voice: Amina, top male voice: Sani.
5. Igbo (ig): Include sub-dots and tone marks (ị, ọ, ụ, ṅ). Top female voice: Ngozi (V2) / Adaeze (v5), top male voice: Chinedu (V2) / Chidi (v5).
6. Length: Keep individual synthesized phrases under 1000 characters for optimal audio quality.`,
          },
        },
      ],
    })
  );

  return server;
}
