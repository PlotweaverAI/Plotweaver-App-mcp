import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createStormMcpServer, type StormClients } from './server.js';
import { VoiceCatalog } from './catalog.js';
import { KeyStore, type PublicKey } from './keys.js';
import { Concurrency, DailyQuota, LimitError, RateLimiter } from './limits.js';

export interface GatewayConfig {
  port: number;
  host: string;
  keyStore: KeyStore;
  clients: StormClients;
  defaultEngine: 'v2-cloning' | 'v5-streaming';
  /** Defaults for keys that don't set their own limits. */
  requestsPerMinute: number;
  dailyCharacters: number;
  /** How many generations may run at once on each endpoint. Shared by all users. */
  concurrency: { v2: number; v5: number };
  voiceCacheMs?: number;
  /** Where daily character usage is saved, so restarts do not reset it. */
  usageFile?: string;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  keyId: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Public MCP endpoint over HTTP. Users connect with a key issued by `storm-tts-mcp keys create`.
 * The STORM keys stay on the server. Audio is returned inside the MCP response, not as a file.
 *
 * Serves plain HTTP. Put TLS in front of it (an AWS load balancer with an ACM certificate).
 */
export async function startGateway(config: GatewayConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, Session>();
  const rateLimiter = new RateLimiter(config.requestsPerMinute);
  const quota = new DailyQuota(config.dailyCharacters, Date.now, config.usageFile);
  const gates = {
    v2: new Concurrency(config.concurrency.v2),
    v5: new Concurrency(config.concurrency.v5),
  };
  const catalog = new VoiceCatalog(config.clients, {
    ttlMs: config.voiceCacheMs,
    preferred: config.defaultEngine === 'v5-streaming' ? 'v5' : 'v2',
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('error', { message: err?.message ?? String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (url.pathname !== '/mcp') {
      return sendJson(res, 404, { error: 'not_found' });
    }

    const key = await authenticate(req);
    if (!key) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'unauthorized', message: 'Send your key as "Authorization: Bearer <key>".' });
    }

    if (req.method === 'POST') {
      return handlePost(req, res, key);
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = findSession(req, res, key);
      if (!session) return;
      return session.transport.handleRequest(req, res);
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, key: PublicKey): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return sendJson(res, 400, { error: 'bad_request', message: err?.message ?? 'Invalid JSON' });
    }

    try {
      rateLimiter.hit(key.id, key.requestsPerMinute ?? config.requestsPerMinute);
    } catch (err) {
      if (err instanceof LimitError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds ?? 60));
        return sendJson(res, 429, { error: 'rate_limited', message: err.message });
      }
      throw err;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = findSession(req, res, key);
      if (!session) return;
      return session.transport.handleRequest(req, res, body);
    }

    if (!isInitializeRequest(body)) {
      return sendJson(res, 400, {
        error: 'bad_request',
        message: 'Start a session with an initialize request first.',
      });
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, keyId: key.id });
        log('session_open', { key: key.name });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const mcp = createStormMcpServer(config.clients, {
      outputMode: 'inline',
      defaultEngine: config.defaultEngine,
      catalog,
      concurrency: gates,
      guard: ({ tool, characters }) => {
        quota.consume(key.id, characters, key.dailyCharacters ?? config.dailyCharacters);
        log('generate', { key: key.name, tool, characters });
      },
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function findSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    key: PublicKey
  ): Session | undefined {
    const id = req.headers['mcp-session-id'];
    if (typeof id !== 'string') {
      sendJson(res, 400, { error: 'bad_request', message: 'Missing mcp-session-id header.' });
      return undefined;
    }
    const session = sessions.get(id);
    if (!session) {
      sendJson(res, 404, { error: 'session_not_found' });
      return undefined;
    }
    // A session belongs to the key that opened it. Other keys cannot use it.
    if (session.keyId !== key.id) {
      sendJson(res, 403, { error: 'forbidden' });
      return undefined;
    }
    return session;
  }

  async function authenticate(req: http.IncomingMessage): Promise<PublicKey | undefined> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    return config.keyStore.verify(token);
  }

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log('listening', { host: config.host, port });

  return {
    url: `http://${config.host}:${port}`,
    close: async () => {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large (limit 1 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** One JSON line per event. Never includes keys or request bodies. */
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
