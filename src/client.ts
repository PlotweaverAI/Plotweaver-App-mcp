import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import WebSocket from 'ws';
import { normalizeSpeechText } from './normalization.js';
import {
  type ClientConfig,
  type CloneVoiceOptions,
  type GenerateSpeechOptions,
  type GenerateSpeechResult,
  type StormCapabilities,
  type StormHealthResponse,
  type StormLanguageCode,
  type StormVoicesResponse,
  type StreamSpeechOptions,
  type WebSocketDoneEvent,
  type WebSocketSessionOptions,
  type WebSocketUtteranceOptions,
  STORM_ENGINE_CONFIGS,
} from './types.js';

export { normalizeSpeechText };

const CLONING_ON_V5_ERROR =
  'StormTTS: voice cloning is only available on STORM-OS-TTS-V2. Create the client with engine: "v2-cloning" and a V2 baseUrl.';
const STREAMING_ON_V2_ERROR =
  'StormTTS: HTTP and WebSocket streaming require STORM TTS v5. Create the client with engine: "v5-streaming" and a v5 baseUrl.';
const MISSING_KEY_ERROR =
  'StormTTS: Missing API key. Please provide "apiKey" in client config or set STORM_API_KEY / STORM_TTS_API_KEY.';

/**
 * Resolves a human-friendly voice name (e.g. "John") or raw catalogue ID
 * to the appropriate parameters expected by STORM v5 / V2.
 * John in particular is catalogue speaker 'slr70_ngm_09334'.
 */
export function resolveSpeaker(
  name?: string,
  speaker_id?: string
): { name?: string; speaker_id?: string } {
  const normName = name?.trim();
  const normId = speaker_id?.trim();

  if (
    normName?.toLowerCase() === 'john' ||
    normId?.toLowerCase() === 'john' ||
    normName === 'slr70_ngm_09334' ||
    normId === 'slr70_ngm_09334'
  ) {
    return { speaker_id: 'slr70_ngm_09334' };
  }

  // If a raw catalogue ID is passed (e.g. slr70_ngm_...) as name, map to speaker_id
  if (normName && /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(normName)) {
    return { speaker_id: normName };
  }

  return { name: normName, speaker_id: normId };
}

/** An HTTP error from a STORM server, with the status code kept for retry decisions. */
export class StormHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'StormHttpError';
  }
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export class StormTTSClient {
  /** The only host this client ever sends requests to. */
  public readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  public readonly engine: 'v2-cloning' | 'v5-streaming' | 'auto';
  private detectedCapabilities?: StormCapabilities;

  /**
   * Each client talks to exactly one host with exactly one key. Environment
   * variables only supply defaults for the chosen engine; they never redirect
   * a request to a different host than the one this client was built for.
   */
  constructor(config: ClientConfig = {}) {
    this.engine = config.engine ?? 'auto';
    const isV5 = this.engine === 'v5-streaming';

    const envBaseUrl = isV5 ? process.env.STORM_TTS_BASE_URL : process.env.STORM_BASE_URL;
    const defaultBaseUrl = STORM_ENGINE_CONFIGS[isV5 ? 'v5-streaming' : 'v2-cloning'].defaultBaseUrl;
    this.baseUrl = trimTrailingSlashes(config.baseUrl ?? envBaseUrl ?? defaultBaseUrl);

    this.apiKey = config.apiKey ?? (isV5 ? process.env.STORM_TTS_API_KEY : process.env.STORM_API_KEY);

    this.timeoutMs = config.timeoutMs ?? 60000;
  }

  /**
   * Check inference server health, GPU status, and loaded voices.
   */
  async health(retries = 2): Promise<StormHealthResponse> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Storm health check failed (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as StormHealthResponse;

        // Detect the engine from the server's own health payload
        if (data.streaming === true || data.model_repo === 'wolethereader/storm-tts' || data.backend === 'vllm-async') {
          this.detectedCapabilities = {
            engine: 'v5-streaming',
            baseUrl: this.baseUrl,
            supportsVoiceCloning: false,
            supportsStreaming: true,
            supportsWebSocket: true,
            modelRepo: data.model_repo || 'wolethereader/storm-tts',
          };
        } else {
          this.detectedCapabilities = {
            engine: 'v2-cloning',
            baseUrl: this.baseUrl,
            supportsVoiceCloning: true,
            supportsStreaming: false,
            supportsWebSocket: false,
            modelRepo: data.model || 'wolethereader/STORM-OS-TTS-V2',
          };
        }

        return data;
      } catch (err) {
        if (attempt === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('Storm health check failed after retries');
  }

  /**
   * Inspect current engine capabilities (streaming, voice cloning, model).
   */
  async getCapabilities(): Promise<StormCapabilities> {
    if (this.detectedCapabilities) {
      return this.detectedCapabilities;
    }
    await this.health();
    return this.detectedCapabilities!;
  }

  /**
   * The engine this client talks to. An explicit `engine` wins; for 'auto'
   * the server's health payload decides (cached after the first call).
   */
  private async resolveEngine(): Promise<'v2-cloning' | 'v5-streaming'> {
    if (this.engine !== 'auto') return this.engine;
    return (await this.getCapabilities()).engine;
  }

  /**
   * Get the list of all inbuilt native voices grouped by language.
   * Compatible across both V2 (/voices) and v5 (/speakers).
   */
  async listVoices(): Promise<StormVoicesResponse> {
    if (!this.apiKey) {
      throw new Error(MISSING_KEY_ERROR);
    }

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Try /voices first (V2)
      let endpoint = `${this.baseUrl}/voices`;
      let response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      // If 404, fallback to /speakers (v5)
      if (response.status === 404) {
        endpoint = `${this.baseUrl}/speakers`;
        response = await fetch(endpoint, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Storm list voices failed (${response.status}): ${errorText}`);
      }

      // Returned exactly as the server reports it. Aliases such as "John" live in voice-overrides.ts.
      return (await response.json()) as StormVoicesResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Synthesize text to speech using an inbuilt voice, auto-selected language voice,
   * or a custom cloned voice. Returns raw WAV bytes and server metadata.
   */
  async generate(options: GenerateSpeechOptions): Promise<GenerateSpeechResult> {
    const cleanText = normalizeSpeechText(options.text, options.lang);
    if (!cleanText || cleanText.trim().length === 0) {
      throw new Error('StormTTS: "text" parameter is required.');
    }
    if (cleanText.length > 1000) {
      throw new Error('StormTTS: "text" parameter exceeds 1000 character limit.');
    }
    if (!options.name && !options.lang && !options.referenceAudio && !options.speaker_id) {
      throw new Error('StormTTS: At least one of "name", "lang", or "referenceAudio" must be provided.');
    }
    if (options.referenceAudio && !options.lang) {
      throw new Error('StormTTS: "lang" is required when supplying "referenceAudio" for voice cloning.');
    }

    if (!this.apiKey) {
      throw new Error(MISSING_KEY_ERROR);
    }

    const isFast = options.fast !== false;

    // Resolve speaker alias (e.g. John -> slr70_ngm_09334)
    const resolved = resolveSpeaker(options.name, options.speaker_id);
    const effectiveOptions: GenerateSpeechOptions = {
      ...options,
      name: resolved.name as any,
      speaker_id: resolved.speaker_id,
    };

    if (effectiveOptions.referenceAudio) {
      if ((await this.resolveEngine()) === 'v5-streaming') {
        throw new Error(CLONING_ON_V5_ERROR);
      }
      return this.retryOnceOn503(() => this.generateMultipart(effectiveOptions, cleanText, isFast));
    }

    if ((await this.resolveEngine()) === 'v5-streaming') {
      return this.retryOnceOn503(() => this.generateJsonV5(effectiveOptions, cleanText, isFast));
    }

    return this.retryOnceOn503(() => this.generateMultipart(effectiveOptions, cleanText, isFast));
  }

  /**
   * The STORM docs say a 503 means generation failed after the server's own retries, and that
   * the caller should try again. One more attempt is made; a second failure is returned as is.
   */
  private async retryOnceOn503<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof StormHttpError && err.status === 503) {
        return attempt();
      }
      throw err;
    }
  }

  private async generateJsonV5(
    options: GenerateSpeechOptions,
    cleanText: string,
    isFast: boolean
  ): Promise<GenerateSpeechResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: Record<string, any> = {
      text: cleanText,
      fast: isFast,
    };
    if (options.name) body.name = options.name;
    if (options.speaker_id) body.speaker_id = options.speaker_id;
    if (options.lang) body.lang = options.lang;

    try {
      const response = await fetch(`${this.baseUrl}/generate`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new StormHttpError(`Storm generate failed (${response.status}): ${errorText}`, response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = new Uint8Array(arrayBuffer);
      const approxDurationSeconds = Math.max(0, (audioBuffer.byteLength - 44) / 48000);

      return {
        audioBuffer,
        approxDurationSeconds: Number(approxDurationSeconds.toFixed(2)),
        byteLength: audioBuffer.byteLength,
        metadata: {
          requestId: response.headers.get('x-generation-id') ?? undefined,
          cache: 'MISS',
          generationTimeSeconds: Number(response.headers.get('x-generation-time')) || undefined,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async generateMultipart(
    options: GenerateSpeechOptions,
    cleanText: string,
    isFast: boolean
  ): Promise<GenerateSpeechResult> {
    const formData = new FormData();
    formData.append('text', cleanText);
    formData.append('fast', isFast ? 'true' : 'false');

    if (options.name) formData.append('name', options.name);
    if (options.lang) formData.append('lang', options.lang);

    if (options.referenceAudio) {
      let fileBlob: Blob;
      if (typeof options.referenceAudio === 'string') {
        const resolvedPath = path.resolve(options.referenceAudio);
        const fileBytes = await fs.readFile(resolvedPath);
        fileBlob = new Blob([fileBytes], { type: 'audio/wav' });
      } else if (options.referenceAudio instanceof Blob) {
        fileBlob = options.referenceAudio;
      } else {
        fileBlob = new Blob([options.referenceAudio], { type: 'audio/wav' });
      }
      formData.append('reference_audio', fileBlob, 'reference.wav');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/generate`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey!,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new StormHttpError(`Storm generate failed (${response.status}): ${errorText}`, response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = new Uint8Array(arrayBuffer);
      const approxDurationSeconds = Math.max(0, (audioBuffer.byteLength - 44) / 48000);

      const metadata = {
        requestId: response.headers.get('x-request-id') ?? undefined,
        cache: (response.headers.get('x-cache') ?? 'MISS') as 'HIT' | 'MISS',
        attempts: response.headers.get('x-attempts') ? Number(response.headers.get('x-attempts')) : undefined,
        generationTimeSeconds: response.headers.get('x-generation-time') ? Number(response.headers.get('x-generation-time')) : undefined,
        rms: response.headers.get('x-rms') ? Number(response.headers.get('x-rms')) : undefined,
      };

      return {
        audioBuffer,
        approxDurationSeconds: Number(approxDurationSeconds.toFixed(2)),
        byteLength: audioBuffer.byteLength,
        metadata,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Clone a custom speaker's voice from reference audio (STORM-OS-TTS-V2).
   */
  async cloneVoice(options: CloneVoiceOptions): Promise<GenerateSpeechResult> {
    return this.generate({
      text: options.text,
      lang: options.lang,
      referenceAudio: options.referenceAudio,
      fast: options.fast ?? true,
    });
  }

  /**
   * Real-time HTTP chunked streaming (STORM TTS v5).
   * Yields 24kHz 16-bit mono PCM chunks as they are synthesized.
   */
  async *streamSpeech(options: StreamSpeechOptions): AsyncIterable<Uint8Array> {
    if (!this.apiKey) {
      throw new Error(MISSING_KEY_ERROR);
    }
    if (this.engine === 'v2-cloning') {
      throw new Error(STREAMING_ON_V2_ERROR);
    }

    const cleanText = normalizeSpeechText(options.text, options.lang);
    if (!cleanText) {
      throw new Error('StormTTS: "text" parameter is required.');
    }

    const resolved = resolveSpeaker(options.name, options.speaker_id);
    const body: Record<string, any> = {
      text: cleanText,
      fast: options.fast !== false,
    };
    if (resolved.name) body.name = resolved.name;
    if (resolved.speaker_id) body.speaker_id = resolved.speaker_id;
    if (options.lang) body.lang = options.lang;

    const response = await fetch(`${this.baseUrl}/generate/stream`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 404) {
      throw new Error(`HTTP streaming (/generate/stream) is not available on ${this.baseUrl}. ${STREAMING_ON_V2_ERROR}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Storm stream failed (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body stream is null');
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Connect to a persistent WebSocket session for zero-latency multi-turn conversational agents.
   * Requires STORM TTS v5. The API key is sent in the handshake header, not the URL.
   */
  createWebSocketSession(options: WebSocketSessionOptions = {}): StormWebSocketSession {
    if (this.engine === 'v2-cloning') {
      throw new Error(STREAMING_ON_V2_ERROR);
    }

    const httpBase = trimTrailingSlashes(options.baseUrl ?? this.baseUrl);
    const apiKey = options.apiKey ?? this.apiKey;
    if (!apiKey) {
      throw new Error('StormTTS: API key required for WebSocket session.');
    }

    return new StormWebSocketSession(`${httpBase.replace(/^http/, 'ws')}/generate/stream/ws`, apiKey);
  }

  /**
   * Convenience helper to synthesize speech and write the resulting WAV directly to disk.
   */
  async generateAndSave(options: GenerateSpeechOptions, outputPath: string): Promise<{
    outputPath: string;
    result: GenerateSpeechResult;
  }> {
    const result = await this.generate(options);
    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, result.audioBuffer);
    return {
      outputPath: resolvedPath,
      result,
    };
  }
}

/**
 * Persistent WebSocket voice session for conversational agents.
 */
export class StormWebSocketSession {
  private ws: WebSocket;
  private isConnected = false;
  private pendingTurn?: {
    onChunk: (chunk: Buffer) => void;
    resolve: (done: WebSocketDoneEvent) => void;
    reject: (err: Error) => void;
  };

  /** Endpoint URL. Credentials are never included here. */
  public readonly url: string;

  constructor(url: string, apiKey: string) {
    this.url = url;
    // The STORM v5 WebSocket endpoint authenticates via the api_key query parameter.
    // A X-API-Key header is rejected with HTTP 403 (checked against the live server).
    this.ws = new WebSocket(`${url}?api_key=${encodeURIComponent(apiKey)}`);
    this.init();
  }

  private init() {
    this.ws.on('open', () => {
      this.isConnected = true;
    });

    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!this.pendingTurn) return;

      if (isBinary) {
        this.pendingTurn.onChunk(data);
      } else {
        try {
          const event = JSON.parse(data.toString());
          if (event.event === 'done') {
            this.pendingTurn.resolve(event as WebSocketDoneEvent);
            this.pendingTurn = undefined;
          } else if (event.event === 'error') {
            this.pendingTurn.reject(new Error(event.detail || 'WebSocket TTS Error'));
            this.pendingTurn = undefined;
          }
        } catch (e: any) {
          if (this.pendingTurn) {
            this.pendingTurn.reject(e);
            this.pendingTurn = undefined;
          }
        }
      }
    });

    this.ws.on('error', (err) => {
      if (this.pendingTurn) {
        this.pendingTurn.reject(err);
        this.pendingTurn = undefined;
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
    });
  }

  /**
   * Wait until WebSocket connection is open.
   */
  async waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.isConnected) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), timeoutMs);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Send an utterance to be synthesized and stream back binary audio chunks in real-time.
   */
  async synthesize(options: WebSocketUtteranceOptions): Promise<WebSocketDoneEvent> {
    await this.waitUntilReady();

    if (this.pendingTurn) {
      throw new Error('A synthesis turn is already active on this WebSocket session.');
    }

    const cleanText = normalizeSpeechText(options.text, options.lang);
    const resolved = resolveSpeaker(options.name, options.speaker_id);
    const payload: Record<string, any> = {
      text: cleanText,
      fast: options.fast !== false,
    };
    if (resolved.name) payload.name = resolved.name;
    if (resolved.speaker_id) payload.speaker_id = resolved.speaker_id;
    if (options.lang) payload.lang = options.lang;

    return new Promise((resolve, reject) => {
      this.pendingTurn = {
        onChunk: options.onChunk,
        resolve,
        reject,
      };
      this.ws.send(JSON.stringify(payload));
    });
  }

  close(): void {
    this.ws.close();
  }
}
