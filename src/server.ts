import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StormTTSClient } from './client.js';
import { VoiceCatalog, type EndpointName, type StormClients } from './catalog.js';
import { Concurrency } from './limits.js';
import type { StormLanguageCode } from './types.js';

export type { StormClients } from './catalog.js';

export interface StormMcpOptions {
  /**
   * "file" (default, for desktop apps on this machine): audio is saved into sandboxRoot and the
   * path is returned. "inline": audio is returned inside the tool result as base64, and no
   * file paths are read or written. Use "inline" for any server that other people connect to.
   */
  outputMode?: 'file' | 'inline';
  /** File mode only: folder that output and reference audio paths must stay inside. */
  sandboxRoot?: string;
  /** Endpoint to prefer when a request does not name a voice, or the voice is on both. */
  defaultEngine?: 'v2-cloning' | 'v5-streaming';
  /**
   * Called before every generation with the number of characters. Throw to refuse the request.
   * The gateway uses this for per-user daily limits.
   */
  guard?: (info: { tool: string; characters: number }) => void;
  /** Limits how many generations run at once on each endpoint. */
  concurrency?: Partial<Record<EndpointName, Concurrency>>;
  /** How long the voice list is cached before the servers are asked again. */
  voiceCacheMs?: number;
  /** Share one catalog between many servers (for example, one per HTTP session). */
  catalog?: VoiceCatalog;
}

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 1000;

async function realpathOfNearestAncestor(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), path.relative(current, p));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

/**
 * Resolves a user-supplied file path and checks it stays inside `root`.
 * Symlinks are followed before the check, so a link pointing outside is rejected.
 * Relative paths resolve against `root`.
 */
export async function resolveSandboxedPath(
  input: string,
  options: { root: string; extensions: string[]; mustExist?: boolean; maxBytes?: number }
): Promise<string> {
  await fs.mkdir(path.resolve(options.root), { recursive: true });
  const root = await fs.realpath(path.resolve(options.root));
  const candidate = path.resolve(root, input);

  const ext = path.extname(candidate).toLowerCase();
  if (!options.extensions.includes(ext)) {
    throw new Error(`Only ${options.extensions.join(', ')} files are allowed (got "${ext || 'no extension'}").`);
  }

  const real = await realpathOfNearestAncestor(candidate);
  const rel = path.relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path must be inside the allowed directory (${root}).`);
  }

  if (options.mustExist || options.maxBytes !== undefined) {
    const stat = await fs.stat(real).catch(() => {
      throw new Error(`File not found: ${input}`);
    });
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${input}`);
    }
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`File is too large (limit ${Math.round(options.maxBytes / 1048576)} MB).`);
    }
  }

  return real;
}

function toClients(input: StormTTSClient | StormClients | undefined): StormClients {
  if (input === undefined) {
    return { v2: new StormTTSClient({ engine: 'auto' }) };
  }
  if (input instanceof StormTTSClient) {
    if (input.engine === 'v2-cloning') return { v2: input };
    if (input.engine === 'v5-streaming') return { v5: input };
    return { v2: input, v5: input };
  }
  return input;
}

/** The configured client for an endpoint, falling back to an auto-detecting client. */
function clientFor(clients: StormClients, endpoint: EndpointName): StormTTSClient {
  const client = clients[endpoint] ?? (clients.v2?.engine === 'auto' ? clients.v2 : clients.v5?.engine === 'auto' ? clients.v5 : undefined);
  if (!client) {
    throw new Error(`No ${endpoint === 'v5' ? 'STORM TTS v5' : 'STORM-OS-TTS-V2'} endpoint is configured.`);
  }
  return client;
}

function pickAnyClient(clients: StormClients, defaultEngine: 'v2-cloning' | 'v5-streaming'): StormTTSClient {
  const ordered = defaultEngine === 'v5-streaming' ? [clients.v5, clients.v2] : [clients.v2, clients.v5];
  const client = ordered.find((c): c is StormTTSClient => c !== undefined);
  if (!client) {
    throw new Error('No STORM endpoint is configured. Set STORM_API_KEY (V2) and/or STORM_TTS_API_KEY (v5).');
  }
  return client;
}

type ToolContent = { type: 'text'; text: string } | { type: 'audio'; data: string; mimeType: string };

function textResult(text: string, isError = false): { content: ToolContent[]; isError?: boolean } {
  return { ...(isError && { isError: true }), content: [{ type: 'text', text }] };
}

export function createStormMcpServer(
  clientsInput?: StormTTSClient | StormClients,
  options: StormMcpOptions = {}
): McpServer {
  const clients = toClients(clientsInput);
  const defaultEngine = options.defaultEngine ?? 'v2-cloning';
  const outputMode = options.outputMode ?? 'file';
  const sandboxRoot = path.resolve(
    options.sandboxRoot ?? process.env.STORM_MCP_ROOT ?? path.join(os.homedir(), 'storm-audio')
  );
  const guard = options.guard ?? (() => {});
  const limit = <T>(endpoint: EndpointName, fn: () => Promise<T>): Promise<T> => {
    const gate = options.concurrency?.[endpoint];
    return gate ? gate.run(fn) : fn();
  };

  const catalog =
    options.catalog ??
    new VoiceCatalog(clients, {
      ttlMs: options.voiceCacheMs,
      preferred: defaultEngine === 'v5-streaming' ? 'v5' : 'v2',
    });

  const server = new McpServer({
    name: 'storm-tts-mcp',
    version: '1.1.0',
  });

  /** Where a file-mode output will be written. Checked before generating, so a bad path costs nothing. */
  async function fileTarget(requested: string | undefined, fileName: string): Promise<string> {
    return requested
      ? resolveSandboxedPath(requested, { root: sandboxRoot, extensions: ['.wav'] })
      : path.join(sandboxRoot, fileName);
  }

  /** Returns the audio in the mode the server runs in, with the summary text for the user. */
  async function deliver(
    wav: Uint8Array,
    target: string | undefined,
    summary: string
  ): Promise<{ content: ToolContent[] }> {
    if (outputMode === 'inline' || !target) {
      return {
        content: [
          { type: 'text', text: summary },
          { type: 'audio', data: Buffer.from(wav).toString('base64'), mimeType: 'audio/wav' },
        ],
      };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, wav);
    return { content: [{ type: 'text', text: `${summary}\n- **Saved Audio File**: ${target}` }] };
  }

  // 1. Tool: storm_tts_speak
  server.tool(
    'storm_tts_speak',
    'Generate high-fidelity Nigerian speech (WAV audio) from text using STORM TTS. Supports Nigerian English (en), Nigerian Pidgin (pcm), Yoruba (yo), Hausa (ha), and Igbo (ig). Call storm_tts_list_voices to see the voices. Use full sentences: very short lines (for example "Good evening. This is John.") currently fail for John on the v5 server, and medium-length lines sometimes do.',
    {
      text: z.string().min(1).max(MAX_TEXT_CHARACTERS).describe(`The text to speak (maximum ${MAX_TEXT_CHARACTERS} characters). Tone marks are supported for Yoruba and Igbo.`),
      voice: z
        .string()
        .optional()
        .describe('Voice name from storm_tts_list_voices, for example "John", "Adunni" or "Blessing". If omitted, language picks the primary voice.'),
      language: z
        .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
        .optional()
        .describe("Language code: 'yo' (Yoruba), 'ha' (Hausa), 'ig' (Igbo), 'pcm' (Nigerian Pidgin), 'en' (Nigerian English). Auto-picks primary voice if voice is not specified."),
      outputPath: z
        .string()
        .optional()
        .describe('File mode only. Path to save the WAV file, inside the allowed output folder. If omitted, a timestamped file is saved there.'),
      fast: z
        .boolean()
        .optional()
        .default(true)
        .describe('Set to true (default) for lowest latency speech generation. Set to false to enable multi-attempt QC checks.'),
    },
    async ({ text, voice, language, outputPath, fast }) => {
      try {
        if (!voice && !language) {
          return textResult('Error: You must provide either a "voice" (e.g. "Adunni", "Blessing") or a "language" code (e.g. "yo", "pcm").', true);
        }
        if (outputMode === 'inline' && outputPath) {
          return textResult('This server returns audio in the response. Remove "outputPath".', true);
        }

        let client: StormTTSClient;
        let endpoint: EndpointName;
        let speaker: string | undefined;
        let label: string | undefined;
        if (voice) {
          const route = await catalog.resolve(voice, 'any');
          endpoint = route.endpoint;
          client = clientFor(clients, endpoint);
          speaker = route.speaker;
          label = route.label;
        } else {
          client = pickAnyClient(clients, defaultEngine);
          endpoint = client === clients.v5 && clients.v5 !== clients.v2 ? 'v5' : 'v2';
        }

        const fileName = `storm_tts_${(speaker || language || 'audio').toLowerCase()}_${Date.now()}.wav`;
        const target = outputMode === 'file' ? await fileTarget(outputPath, fileName) : undefined;

        guard({ tool: 'storm_tts_speak', characters: text.length });

        const effectiveLang = language as StormLanguageCode | undefined;
        const result = await limit(endpoint, () =>
          client.generate({ text, name: speaker, lang: effectiveLang, fast: fast ?? true })
        );

        const voiceLabel = label ?? 'Auto';
        const summary = `✅ Generated STORM-OS speech audio successfully!

- **Voice Used**: ${voiceLabel}
- **Language**: ${effectiveLang || 'Native to voice'}
- **Audio Specs**: 24kHz 16-bit Mono WAV, ~${result.approxDurationSeconds.toFixed(1)}s (${(result.byteLength / 1024).toFixed(1)} KB)
- **Status**: ${result.metadata.cache === 'HIT' ? 'Cache Hit' : 'Fresh Generation'}${result.metadata.attempts ? ` (${result.metadata.attempts} QC attempts)` : ''}
- **Text Spoken**: "${text}"`;

        return await deliver(result.audioBuffer, target, summary);
      } catch (err: any) {
        return textResult(`STORM-OS TTS Generation Failed: ${err?.message || String(err)}`, true);
      }
    }
  );

  // 2. Tool: storm_tts_clone_voice
  const cloneInput: Record<string, z.ZodTypeAny> = {
    text: z.string().min(1).max(MAX_TEXT_CHARACTERS).describe(`Text to speak in the cloned voice (up to ${MAX_TEXT_CHARACTERS} characters).`),
    language: z
      .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
      .describe("Target language code: 'yo' (Yoruba), 'ha' (Hausa), 'ig' (Igbo), 'pcm' (Nigerian Pidgin), 'en' (Nigerian English)."),
    fast: z
      .boolean()
      .optional()
      .default(true)
      .describe('Set to true (default) to skip retry/QC loop for faster turnaround. Set to false for full QC loop.'),
  };
  if (outputMode === 'inline') {
    cloneInput.referenceAudioBase64 = z
      .string()
      .describe('Base64-encoded WAV of a 4-8 second clip of the voice to clone.');
  } else {
    cloneInput.referenceAudioPath = z
      .string()
      .describe('Path to a 4-8 second WAV sample of the voice to clone, inside the allowed folder.');
    cloneInput.outputPath = z.string().optional().describe('Optional path to save the cloned WAV, inside the allowed folder.');
  }

  server.tool(
    'storm_tts_clone_voice',
    'Clone any custom speaker voice from a 4-8 second WAV reference clip and generate new speech in Yoruba, Hausa, Igbo, Pidgin, or Nigerian English.',
    cloneInput as z.ZodRawShape,
    async (args: any): Promise<any> => {
      try {
        const { text, language, fast } = args;
        const client = clientFor(clients, 'v2');

        let reference: string | Buffer;
        if (outputMode === 'inline') {
          reference = Buffer.from(args.referenceAudioBase64 as string, 'base64');
          if (reference.length === 0) return textResult('referenceAudioBase64 is empty or not valid base64.', true);
          if (reference.length > MAX_REFERENCE_BYTES) return textResult('Reference audio is too large (limit 25 MB).', true);
        } else {
          reference = await resolveSandboxedPath(args.referenceAudioPath as string, {
            root: sandboxRoot,
            extensions: ['.wav'],
            mustExist: true,
            maxBytes: MAX_REFERENCE_BYTES,
          });
        }

        const target = outputMode === 'file' ? await fileTarget(args.outputPath, `storm_cloned_${language}_${Date.now()}.wav`) : undefined;

        guard({ tool: 'storm_tts_clone_voice', characters: text.length });

        const result = await limit('v2', () =>
          client.generate({ text, lang: language as StormLanguageCode, referenceAudio: reference, fast: fast ?? true })
        );

        const summary = `✅ Generated voice-cloned speech successfully!

- **Language**: ${language}
- **Audio Specs**: 24kHz 16-bit Mono WAV, ~${result.approxDurationSeconds.toFixed(1)}s (${(result.byteLength / 1024).toFixed(1)} KB)
- **Generation Time**: ${result.metadata.generationTimeSeconds ? result.metadata.generationTimeSeconds.toFixed(2) + 's' : 'Cached'}
- **Text Spoken**: "${text}"`;

        return await deliver(result.audioBuffer, target, summary);
      } catch (err: any) {
        return textResult(`STORM-OS Voice Cloning Failed: ${err?.message || String(err)}`, true);
      }
    }
  );

  // 3. Tool: storm_tts_list_voices
  server.tool(
    'storm_tts_list_voices',
    'List the voices available on the STORM TTS servers, grouped by language, with gender and which engine serves them.',
    {
      language: z
        .enum(['yo', 'ha', 'ig', 'pcm', 'en'])
        .optional()
        .describe('Optional language filter (yo, ha, ig, pcm, en) to view voices for a specific language only.'),
    },
    async ({ language }) => {
      try {
        const voices = await catalog.list(language);
        if (voices.length === 0) return textResult('No voices are currently available.');

        const rows = voices
          .sort((a, b) => a.language.localeCompare(b.language) || a.label.localeCompare(b.label))
          .map((v) => {
            const gender = v.gender === 'F' || v.gender === 'female' ? 'Female' : v.gender === 'M' || v.gender === 'male' ? 'Male' : 'Standard';
            const engines = v.endpoints.map((e) => (e === 'v5' ? 'v5' : 'V2')).join(', ');
            return `| **${v.label}** | ${v.language} | ${gender} | ${engines} |`;
        });
        const text = `# STORM TTS Voices\n\n| Voice | Language | Gender | Engine |\n| :--- | :--- | :--- | :--- |\n${rows.join('\n')}\n\nVoices on V2 support voice cloning. Voices on v5 support streaming.`;
        return textResult(text);
      } catch (err: any) {
        return textResult(`Failed to fetch voices: ${err?.message || String(err)}`, true);
      }
    }
  );

  // 4. Tool: storm_tts_health
  server.tool(
    'storm_tts_health',
    'Check whether the STORM TTS servers are up, which engines they run, and what capabilities they have.',
    {},
    async () => {
      try {
        const lines: string[] = [];
        for (const endpoint of ['v2', 'v5'] as const) {
          const client = clients[endpoint];
          if (!client) continue;
          try {
            const health = await client.health();
            const caps = await client.getCapabilities();
            lines.push(
              `- ${endpoint === 'v5' ? 'STORM TTS v5' : 'STORM-OS-TTS-V2'}: Status: ${health.status.toUpperCase()} (${client.baseUrl}), engine ${caps.engine}, streaming ${caps.supportsStreaming ? 'yes' : 'no'}, cloning ${caps.supportsVoiceCloning ? 'yes' : 'no'}`
            );
          } catch (err: any) {
            lines.push(`- ${endpoint === 'v5' ? 'STORM TTS v5' : 'STORM-OS-TTS-V2'}: Status: DOWN (${err?.message || String(err)})`);
          }
        }
        if (lines.length === 0) lines.push('- No endpoint is configured.');
        return textResult(`STORM TTS servers:\n${lines.join('\n')}`);
      } catch (err: any) {
        return textResult(`STORM Health Check Failed: ${err?.message || String(err)}`, true);
      }
    }
  );

  // MCP Resource: storm://voices
  server.resource('storm-voices', 'storm://voices', async (uri) => {
    const voices = await catalog.list();
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(voices, null, 2), mimeType: 'application/json' }],
    };
  });

  // MCP Resource: storm://health
  server.resource('storm-health', 'storm://health', async (uri) => {
    const client = pickAnyClient(clients, defaultEngine);
    const health = await client.health();
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(health, null, 2), mimeType: 'application/json' }],
    };
  });

  // MCP Prompt: storm_tts_guide
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
1. Call storm_tts_list_voices to see which voices exist for the language before choosing one.
2. Yoruba (yo), Igbo (ig): include diacritics and tone marks for natural cadence and accurate pronunciation.
3. Nigerian English (en) and Pidgin (pcm): "John" is the flagship voice for news and conversational delivery.
4. Keep each request under ${MAX_TEXT_CHARACTERS} characters; split longer text into sentences.`,
          },
        },
      ],
    })
  );

  return server;
}
