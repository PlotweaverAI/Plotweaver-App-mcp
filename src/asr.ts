import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StormHttpError } from './client.js';
import type { StormLanguageCode } from './types.js';

export const DEFAULT_ASR_BASE_URL = 'http://34.228.222.150:8000';

/** Audio formats the ASR server decodes (anything librosa reads); used for file checks and upload types. */
export const ASR_AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

export interface ASRClientConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface TranscribeOptions {
  /** A file path, or the raw bytes of an audio file. */
  audio: string | Uint8Array | Blob;
  /** Language spoken in the audio. The server needs it; it does not detect language. */
  language: StormLanguageCode;
  /** File name sent with raw bytes; its extension tells the server the format. Defaults to audio.wav. */
  fileName?: string;
}

export interface TranscribeResult {
  text: string;
  language: StormLanguageCode;
  audioDurationSeconds: number;
  /** Server-side processing time. */
  elapsedSeconds: number;
  /** Audio over 20 s is split into overlapping chunks on the server. */
  chunksProcessed: number;
  requestId?: string;
}

/**
 * Speech-to-text with STORM-OS ASR (Whisper-large-v3 fine-tune) for English, Yoruba, Hausa,
 * Igbo and Nigerian Pidgin. Like the TTS client, it talks to exactly one host with one key.
 */
export class StormASRClient {
  public readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: ASRClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.STORM_ASR_BASE_URL ?? DEFAULT_ASR_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? process.env.STORM_ASR_API_KEY;
    this.timeoutMs = config.timeoutMs ?? 120000;
  }

  /** `{ status, asr }` from the server; `asr` reads "loading" briefly after a restart. */
  async health(): Promise<{ status: string; asr?: string; [key: string]: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, { method: 'GET', signal: controller.signal });
      if (!response.ok) {
        throw new StormHttpError(`Storm ASR health check failed (${response.status}): ${await response.text()}`, response.status);
      }
      return (await response.json()) as { status: string; asr?: string };
    } finally {
      clearTimeout(timeout);
    }
  }

  async transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
    if (!this.apiKey) {
      throw new Error('StormASR: Missing API key. Provide "apiKey" in client config or set STORM_ASR_API_KEY.');
    }
    if (!options.language) {
      throw new Error('StormASR: "language" is required (en, yo, ha, ig or pcm).');
    }

    let file: Blob;
    let fileName: string;
    if (typeof options.audio === 'string') {
      const resolvedPath = path.resolve(options.audio);
      fileName = path.basename(resolvedPath);
      const type = ASR_AUDIO_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
      file = new Blob([await fs.readFile(resolvedPath)], { type });
    } else {
      fileName = options.fileName ?? 'audio.wav';
      file = options.audio instanceof Blob ? options.audio : new Blob([options.audio]);
    }
    if (file.size === 0) {
      throw new Error('StormASR: the audio is empty.');
    }

    const formData = new FormData();
    formData.append('file', file, fileName);
    formData.append('language', options.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey },
        body: formData,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new StormHttpError(`Storm transcribe failed (${response.status}): ${errorText}`, response.status);
      }
      const data = (await response.json()) as {
        request_id?: string;
        language: StormLanguageCode;
        text: string;
        audio_duration_s: number;
        chunks_processed: number;
        elapsed_s: number;
      };
      return {
        text: (data.text ?? '').trim(),
        language: data.language ?? options.language,
        audioDurationSeconds: data.audio_duration_s,
        elapsedSeconds: data.elapsed_s,
        chunksProcessed: data.chunks_processed,
        requestId: data.request_id,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
