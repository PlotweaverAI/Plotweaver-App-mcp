import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Keys that let people use the public MCP gateway. The gateway holds the STORM keys, so
 * users never see those. Only a SHA-256 hash of each user key is stored; the key itself is
 * shown once, when it is created, and cannot be recovered.
 */
export interface StoredKey {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  disabled: boolean;
  /** Requests per minute. Falls back to the gateway default when absent. */
  requestsPerMinute?: number;
  /** Characters of speech per UTC day. Falls back to the gateway default when absent. */
  dailyCharacters?: number;
}

export interface PublicKey extends Omit<StoredKey, 'hash'> {}

const KEY_PREFIX = 'stm_';

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export class KeyStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<StoredKey[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.keys) ? parsed.keys : [];
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  private async write(keys: StoredKey[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ keys }, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** Creates a key for a person or app. Returns the plain key once; it is not stored. */
  async create(name: string, options: { requestsPerMinute?: number; dailyCharacters?: number } = {}): Promise<{ key: string; record: PublicKey }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A name is required for a key.');

    const keys = await this.read();
    if (keys.some((k) => k.name === trimmed && !k.disabled)) {
      throw new Error(`An active key named "${trimmed}" already exists. Disable it first or choose another name.`);
    }

    const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const record: StoredKey = {
      id: crypto.randomUUID(),
      name: trimmed,
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
      disabled: false,
      ...(options.requestsPerMinute !== undefined && { requestsPerMinute: options.requestsPerMinute }),
      ...(options.dailyCharacters !== undefined && { dailyCharacters: options.dailyCharacters }),
    };
    keys.push(record);
    await this.write(keys);
    return { key, record: toPublic(record) };
  }

  async list(): Promise<PublicKey[]> {
    return (await this.read()).map(toPublic);
  }

  async disable(id: string): Promise<PublicKey> {
    const keys = await this.read();
    const record = keys.find((k) => k.id === id || k.name === id);
    if (!record) throw new Error(`No key with id or name "${id}".`);
    record.disabled = true;
    await this.write(keys);
    return toPublic(record);
  }

  /** Returns the matching active key record, or undefined. Compares hashes in constant time. */
  async verify(presented: string | undefined): Promise<PublicKey | undefined> {
    if (!presented || !presented.startsWith(KEY_PREFIX)) return undefined;
    const presentedHash = Buffer.from(hashKey(presented), 'hex');
    const keys = await this.read();
    for (const record of keys) {
      const storedHash = Buffer.from(record.hash, 'hex');
      if (storedHash.length === presentedHash.length && crypto.timingSafeEqual(storedHash, presentedHash) && !record.disabled) {
        return toPublic(record);
      }
    }
    return undefined;
  }
}

function toPublic(record: StoredKey): PublicKey {
  const { hash: _hash, ...rest } = record;
  return rest;
}
