/**
 * Supported language codes in STORM TTS:
 * - yo: Yoruba
 * - ha: Hausa
 * - ig: Igbo
 * - pcm: Nigerian Pidgin
 * - en: Nigerian English
 */
export type StormLanguageCode = 'yo' | 'ha' | 'ig' | 'pcm' | 'en';

/**
 * Built-in named voices available across STORM model generations:
 * - V2 Studio Voices: Adunni, Kayode, Amina, Sani, Ngozi, Chinedu, Blessing, Chuks, David
 * - v5 vLLM Streaming Voices: Morenike, Adewale, Amina, Adaeze, Chidi, Blessing, Emeka, Ngozi, Yemi
 */
export type StormVoiceName =
  | 'John'     // Flagship Nigerian English & Pidgin voice (slr70_ngm_09334)
  | 'Adunni'   // Yoruba (Female)
  | 'Kayode'   // Yoruba (Male)
  | 'Morenike' // Yoruba (Female - v5 vLLM)
  | 'Adewale'  // Yoruba (Male - v5 vLLM)
  | 'Amina'    // Hausa (Female)
  | 'Sani'     // Hausa (Male)
  | 'Ngozi'    // Igbo / Pidgin (Female)
  | 'Chinedu'  // Igbo (Male)
  | 'Adaeze'   // Igbo (Female - v5 vLLM)
  | 'Chidi'    // Igbo (Male - v5 vLLM)
  | 'Blessing' // Nigerian Pidgin (Female)
  | 'Chuks'    // Nigerian Pidgin (Male)
  | 'Emeka'    // Nigerian Pidgin (Male - v5 vLLM)
  | 'David'    // Nigerian English (Male)
  | 'Yemi'     // Nigerian English (Male - v5 vLLM)
  | 'slr70_ngm_09334' // John raw catalogue ID
  | (string & {});

/**
 * Engine types available in PlotWeaver's ecosystem:
 * - 'v2-cloning': STORM-OS-TTS-V2 (Chatterbox LoRA on A10G) - Supports Zero-Shot Voice Cloning & Studio Voices.
 * - 'v5-streaming': STORM TTS v5 (Orpheus-3B on vLLM A10G) - Supports HTTP chunked streaming & persistent WebSockets.
 * - 'auto': Auto-detects based on baseUrl or server capabilities.
 */
export type StormModelEngine = 'v2-cloning' | 'v5-streaming' | 'auto';

export interface StormEngineInfo {
  name: string;
  defaultBaseUrl: string;
  defaultKeyEnv: string;
  supportsVoiceCloning: boolean;
  supportsStreaming: boolean;
  supportsWebSocket: boolean;
  defaultSpeaker: StormVoiceName;
  description: string;
}

export const STORM_ENGINE_CONFIGS: Record<'v2-cloning' | 'v5-streaming', StormEngineInfo> = {
  'v2-cloning': {
    name: 'STORM-OS-TTS-V2',
    defaultBaseUrl: 'http://18.208.227.247:8000',
    defaultKeyEnv: 'STORM_API_KEY',
    supportsVoiceCloning: true,
    supportsStreaming: false,
    supportsWebSocket: false,
    defaultSpeaker: 'Adunni',
    description: 'Zero-shot custom voice cloning (4-8s audio) and 9 native studio voices.',
  },
  'v5-streaming': {
    name: 'STORM TTS v5 (vLLM)',
    defaultBaseUrl: 'http://54.198.152.226:8000',
    defaultKeyEnv: 'STORM_TTS_API_KEY',
    supportsVoiceCloning: false,
    supportsStreaming: true,
    supportsWebSocket: true,
    defaultSpeaker: 'Morenike',
    description: 'Ultra-low latency vLLM inference with HTTP chunked streaming and persistent WebSocket voice sessions.',
  },
};

export interface VoiceInfo {
  name: string;
  gender: 'F' | 'M' | 'female' | 'male' | string;
  hours?: number;
}

export interface LanguageVoiceCatalog {
  label: string;
  default_speaker?: string;
  voices?: VoiceInfo[];
  speakers?: VoiceInfo[];
}

export interface StormVoicesResponse {
  languages: Record<string, LanguageVoiceCatalog>;
  cross_lingual_supported?: boolean;
  cross_lingual_note?: string;
  custom_voice_cloning?: boolean;
  custom_voice_note?: string;
}

export interface StormHealthResponse {
  status: 'ok' | string;
  device?: string;
  gpu?: string;
  gpu_name?: string;
  model?: string;
  model_repo?: string;
  voices_loaded?: number;
  cache_size?: number;
  uptime_seconds?: number;
  backend?: string;
  streaming?: boolean;
}

export interface StormCapabilities {
  engine: 'v2-cloning' | 'v5-streaming';
  baseUrl: string;
  supportsVoiceCloning: boolean;
  supportsStreaming: boolean;
  supportsWebSocket: boolean;
  modelRepo: string;
}

export interface ClientConfig {
  /**
   * STORM API key.
   * If omitted, checks STORM_TTS_API_KEY (for v5) or STORM_API_KEY (for v2).
   */
  apiKey?: string;
  /**
   * Base URL of the inference instance.
   * Defaults to http://18.208.227.247:8000 (v2) or http://54.198.152.226:8000 (v5).
   */
  baseUrl?: string;
  /**
   * Select engine target:
   * - 'v2-cloning': Target STORM-OS-TTS-V2 (with voice cloning)
   * - 'v5-streaming': Target STORM TTS v5 (vLLM with HTTP/WS streaming)
   * - 'auto': Auto-detect based on baseUrl or health endpoint (default)
   */
  engine?: StormModelEngine;
  /**
   * Request timeout in milliseconds (default: 60000ms = 60s)
   */
  timeoutMs?: number;
}

export interface GenerateSpeechOptions {
  /**
   * Text to synthesize (up to 1000 characters).
   */
  text: string;
  /**
   * Inbuilt voice name (e.g. 'Adunni', 'Morenike', 'Blessing', 'David').
   * If omitted, 'lang' must be provided to auto-pick the primary voice.
   */
  name?: StormVoiceName;
  /**
   * Raw internal speaker ID (accepted for backward compatibility).
   */
  speaker_id?: string;
  /**
   * Language code ('yo', 'ha', 'ig', 'pcm', 'en').
   * If 'name' is omitted, auto-picks this language's top voice.
   */
  lang?: StormLanguageCode;
  /**
   * Buffer, Blob, or path to a 4-8 second WAV reference audio for voice cloning (v2 only).
   */
  referenceAudio?: Blob | Uint8Array | Buffer | string;
  /**
   * Skip retry/QC loop for lower latency.
   * Default: true.
   */
  fast?: boolean;
}

export interface StreamSpeechOptions {
  /**
   * Text to synthesize in real time.
   */
  text: string;
  /**
   * Speaker name (e.g. 'John', 'Morenike', 'Blessing', 'Yemi').
   */
  name?: StormVoiceName;
  /**
   * Raw catalogue speaker ID (e.g. 'slr70_ngm_09334' for John).
   */
  speaker_id?: string;
  /**
   * Target language code ('yo', 'ha', 'ig', 'pcm', 'en').
   */
  lang?: StormLanguageCode;
  /**
   * Fast mode (default: true).
   */
  fast?: boolean;
}

export interface CloneVoiceOptions {
  /**
   * Text to synthesize in the cloned voice.
   */
  text: string;
  /**
   * File path or buffer of 4-8s audio clip of the target speaker.
   */
  referenceAudio: string | Buffer | Uint8Array | Blob;
  /**
   * Target language the text is written in ('yo', 'ha', 'ig', 'pcm', 'en').
   */
  lang: StormLanguageCode;
  /**
   * Optional fast flag (default: true).
   */
  fast?: boolean;
}

export interface GenerateSpeechResult {
  /**
   * Raw WAV audio as a Uint8Array buffer.
   */
  audioBuffer: Uint8Array;
  /**
   * Estimated duration in seconds (based on 24kHz 16-bit mono PCM headers).
   */
  approxDurationSeconds: number;
  /**
   * Number of bytes in the WAV audio.
   */
  byteLength: number;
  /**
   * Server metadata headers.
   */
  metadata: {
    requestId?: string;
    cache: 'HIT' | 'MISS' | string;
    attempts?: number;
    generationTimeSeconds?: number;
    rms?: number;
  };
}

export interface WebSocketSessionOptions {
  apiKey?: string;
  baseUrl?: string;
}

export interface WebSocketUtteranceOptions {
  text: string;
  name?: StormVoiceName;
  speaker_id?: string;
  lang?: StormLanguageCode;
  fast?: boolean;
  onChunk: (chunk: Buffer) => void;
}

export interface WebSocketDoneEvent {
  event: 'done';
  generation_id: string;
  chunks_sent: number;
  total_time_s: number;
}
