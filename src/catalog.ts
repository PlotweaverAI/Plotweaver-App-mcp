import type { StormTTSClient } from './client.js';
import { VOICE_OVERRIDES } from './voice-overrides.js';
import type { VoiceInfo, StormVoicesResponse } from './types.js';

export type EndpointName = 'v2' | 'v5';

export interface VoiceRoute {
  /** Which configured endpoint should serve this voice. */
  endpoint: EndpointName;
  /** Canonical speaker name, as the endpoint expects it. */
  speaker: string;
  /** Display label. */
  label: string;
}

export interface CatalogVoice {
  name: string;
  label: string;
  language: string;
  gender?: string;
  endpoints: EndpointName[];
}

export interface StormClients {
  v2?: StormTTSClient;
  v5?: StormTTSClient;
}

type RosterEntry = { language: string; gender?: string };
type Roster = Map<string, RosterEntry>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** After a failed refresh, try again sooner than the normal cache time. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
const MAX_NAMES_IN_ERROR = 40;

/**
 * Voices as the STORM servers currently report them. Refreshed on a timer, so a voice added
 * on a server shows up here without redeploying this package.
 *
 * Each endpoint keeps its own roster. If one endpoint fails during a refresh, its last good roster
 * is kept, so its voices do not disappear while it is briefly unreachable.
 */
export class VoiceCatalog {
  private rosters: Partial<Record<EndpointName, Roster>> = {};
  private loadedAt = 0;
  private nextRetryAt = 0;
  private lastError?: string;

  constructor(
    private readonly clients: StormClients,
    private readonly options: { ttlMs?: number; preferred?: EndpointName } = {}
  ) {}

  /** Fetch voice lists from every configured endpoint. Keeps the last good list for any that fail. */
  async refresh(): Promise<void> {
    const errors: string[] = [];
    let configuredCount = 0;

    for (const endpoint of ['v2', 'v5'] as const) {
      const client = this.clients[endpoint];
      if (!client) continue;
      configuredCount++;
      try {
        this.rosters[endpoint] = parseRoster((await client.listVoices()) as StormVoicesResponse);
      } catch (err: any) {
        errors.push(`${endpoint}: ${err?.message || String(err)}`);
      }
    }

    if (configuredCount === 0) {
      throw new Error('No STORM endpoint is configured.');
    }
    if (Object.keys(this.rosters).length === 0) {
      throw new Error(`Voice list unavailable (${errors.join('; ')})`);
    }

    const now = Date.now();
    this.loadedAt = now;
    this.lastError = errors.length ? errors.join('; ') : undefined;
    this.nextRetryAt = errors.length ? now + RETRY_AFTER_FAILURE_MS : 0;
  }

  private async ensureLoaded(): Promise<void> {
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();
    const empty = Object.keys(this.rosters).length === 0;
    const stale = now - this.loadedAt >= ttl;
    const retryDue = this.nextRetryAt > 0 && now >= this.nextRetryAt;
    if (empty || stale || retryDue) {
      await this.refresh();
    }
  }

  /** Every voice, optionally filtered by language code. */
  async list(language?: string): Promise<CatalogVoice[]> {
    await this.ensureLoaded();
    const out: CatalogVoice[] = [];
    for (const [name, info] of this.combined()) {
      if (language && info.language !== language) continue;
      out.push({
        name,
        label: VOICE_OVERRIDES.labels[name] ?? name,
        language: info.language,
        gender: info.gender,
        endpoints: [...info.endpoints],
      });
    }
    return out;
  }

  /**
   * Work out which endpoint serves a requested voice name. `want` restricts the endpoint
   * (for example, cloning needs 'v2'); 'any' picks the preferred endpoint when both have it.
   */
  async resolve(requested: string, want: EndpointName | 'any' = 'any'): Promise<VoiceRoute> {
    await this.ensureLoaded();

    const trimmed = requested.trim();
    const speaker = VOICE_OVERRIDES.aliases[trimmed.toLowerCase()] ?? trimmed;
    const combined = this.combined();
    const info = combined.get(speaker);
    const label = VOICE_OVERRIDES.labels[speaker] ?? speaker;

    if (!info) {
      if (this.lastError) {
        // An endpoint could not be reached, so the voice may simply be temporarily missing.
        throw new Error(`"${requested}" is not available right now (${this.lastError}). Try again in a moment.`);
      }
      // A v5 voice asked for when no v5 endpoint is configured looks unknown. Say what to do.
      if (!this.clients.v5 && combined.size > 0 && this.clients.v2) {
        throw new Error(
          `"${requested}" is not on STORM-OS-TTS-V2. If it is a STORM TTS v5 voice, such as John, set STORM_TTS_API_KEY and STORM_TTS_BASE_URL.`
        );
      }
      const names = [...combined.keys()].map((n) => VOICE_OVERRIDES.labels[n] ?? n);
      const shown = names.slice(0, MAX_NAMES_IN_ERROR).join(', ');
      const more = names.length > MAX_NAMES_IN_ERROR ? `, … (${names.length - MAX_NAMES_IN_ERROR} more)` : '';
      throw new Error(`Unknown voice "${requested}". Available voices: ${shown}${more}.`);
    }

    const serves = [...info.endpoints].filter((e) => want === 'any' || e === want);
    if (serves.length === 0) {
      // The voice exists, but not on the endpoint this request needs.
      throw new Error(`"${label}" is only available on ${describeEndpoints(info.endpoints)}.`);
    }

    const configured = serves.filter((e) => this.clients[e] !== undefined);
    if (configured.length === 0) {
      throw new Error(`"${label}" needs ${describeEndpoints(new Set(serves))}, which is not configured.`);
    }

    const preferred = this.options.preferred ?? 'v2';
    const endpoint = configured.includes(preferred) ? preferred : configured[0];
    return { endpoint, speaker, label };
  }

  /** Current state, for health reporting. */
  get status(): { voices: number; loadedAt: number; lastError?: string } {
    return { voices: this.combined().size, loadedAt: this.loadedAt, lastError: this.lastError };
  }

  /** All voices across endpoints, with the endpoints that serve each one. */
  private combined(): Map<string, { language: string; gender?: string; endpoints: Set<EndpointName> }> {
    const out = new Map<string, { language: string; gender?: string; endpoints: Set<EndpointName> }>();
    for (const endpoint of ['v2', 'v5'] as const) {
      for (const [name, entry] of this.rosters[endpoint] ?? []) {
        const existing = out.get(name);
        if (existing) {
          existing.endpoints.add(endpoint);
        } else {
          out.set(name, { language: entry.language, gender: entry.gender, endpoints: new Set([endpoint]) });
        }
      }
    }
    return out;
  }
}

function describeEndpoints(endpoints: Set<EndpointName>): string {
  const names = [...endpoints].map((e) => (e === 'v5' ? 'STORM TTS v5' : 'STORM-OS-TTS-V2'));
  return names.join(' or ');
}

function parseRoster(roster: StormVoicesResponse): Roster {
  const out: Roster = new Map();
  for (const [language, group] of Object.entries(roster.languages ?? {})) {
    const list: VoiceInfo[] = group.voices || group.speakers || [];
    for (const voice of list) {
      if (!out.has(voice.name)) {
        out.set(voice.name, { language, gender: voice.gender });
      }
    }
  }
  return out;
}
