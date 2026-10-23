import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Limits that protect the GPUs and keep one user from using up everyone's capacity.
 * Counters live in memory, so they reset when the process restarts and are not shared between
 * instances. Run more than one instance only after moving them to a shared store.
 */

export class LimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'LimitError';
  }
}

/** Caps how many generations run at once on one endpoint. Extra requests wait in line. */
export class Concurrency {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('Concurrency limit must be a positive integer');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

/** Allows `perMinute` calls per key in each rolling minute, fixed windows. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  hit(key: string, limit = this.perMinute): void {
    const t = this.now();
    const window = this.windows.get(key);
    if (!window || t - window.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 });
      return;
    }
    if (window.count >= limit) {
      const retry = Math.ceil((60_000 - (t - window.start)) / 1000);
      throw new LimitError(`Rate limit reached (${limit} requests per minute). Try again in ${retry}s.`, retry);
    }
    window.count++;
  }
}

/**
 * Caps characters of speech per key per UTC day. With `persistPath`, usage is saved to that file,
 * so a restart does not give everyone a fresh day.
 */
export class DailyQuota {
  private usage = new Map<string, { day: string; chars: number }>();

  constructor(
    private readonly dailyChars: number,
    private readonly now: () => number = Date.now,
    private readonly persistPath?: string
  ) {
    if (persistPath && fs.existsSync(persistPath)) {
      const saved = JSON.parse(fs.readFileSync(persistPath, 'utf8')) as Record<string, { day: string; chars: number }>;
      this.usage = new Map(Object.entries(saved));
    }
  }

  consume(key: string, characters: number, limit = this.dailyChars): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const entry = this.usage.get(key);
    const used = entry && entry.day === day ? entry.chars : 0;
    if (used + characters > limit) {
      throw new LimitError(
        `Daily limit reached (${limit} characters per day). It resets at 00:00 UTC.`
      );
    }
    this.usage.set(key, { day, chars: used + characters });
    this.save();
  }

  private save(): void {
    if (!this.persistPath) return;
    const tmp = `${this.persistPath}.tmp`;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.usage)), { mode: 0o600 });
    fs.renameSync(tmp, this.persistPath);
  }

  remaining(key: string): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const entry = this.usage.get(key);
    const used = entry && entry.day === day ? entry.chars : 0;
    return Math.max(0, this.dailyChars - used);
  }
}
