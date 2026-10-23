// Offline unit tests. No network or API keys needed: fetch is mocked wherever a request would be made.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StormTTSClient, normalizeSpeechText, resolveSpeaker } from '../dist/client.js';
import { createStormMcpServer, resolveSandboxedPath } from '../dist/server.js';
import { VoiceCatalog } from '../dist/catalog.js';
import { Concurrency, DailyQuota, LimitError, RateLimiter } from '../dist/limits.js';
import { KeyStore } from '../dist/keys.js';
import { startGateway } from '../dist/gateway.js';

const V2 = 'http://v2.test';
const V5 = 'http://v5.test';

/** Voice rosters as the servers report them. */
const V2_ROSTER = {
  languages: {
    yo: { label: 'Yoruba', voices: [{ name: 'Adunni', gender: 'female', hours: 61.7 }] },
    pcm: { label: 'Pidgin', voices: [{ name: 'Blessing', gender: 'female', hours: 8.6 }] },
  },
};
const V5_ROSTER = {
  languages: {
    en: { label: 'English', speakers: [{ name: 'slr70_ngm_09334', gender: 'male', hours: 0.33 }, { name: 'Yemi', gender: 'male' }] },
    yo: { label: 'Yoruba', speakers: [{ name: 'Morenike', gender: 'female', hours: 61.7 }] },
    pcm: { label: 'Pidgin', speakers: [{ name: 'Blessing', gender: 'female' }] },
  },
};

/** Answers voice-list requests from the rosters above; other requests go to `other`. */
function rosterHandler(other = () => new Response(new Uint8Array(200), { status: 200 })) {
  return (url) => {
    if (url.startsWith(V5)) {
      if (url.endsWith('/voices')) return new Response('not found', { status: 404 });
      if (url.endsWith('/speakers')) return jsonResponse(V5_ROSTER);
    }
    if (url.startsWith(V2) && url.endsWith('/voices')) return jsonResponse(V2_ROSTER);
    return other(url);
  };
}

/** Runs fn with globalThis.fetch replaced by handler; fn receives the recorded calls. */
async function withFetch(handler, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return handler(String(url), init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Runs fn with the given environment variables set, restoring the originals afterwards. */
async function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const wavResponse = () => new Response(new Uint8Array(200), { status: 200 });
const generateCalls = (calls) => calls.filter((c) => c.url.includes('/generate') && !c.url.includes('/generate/stream'));

async function connectMcp(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'unit-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('normalization', () => {
  test('strips markdown and bullets but keeps negative numbers', () => {
    const out = normalizeSpeechText('**Bold** text\n- item one\n-5 degrees', 'en');
    assert.ok(!out.includes('*'), `markdown left in: ${out}`);
    assert.ok(out.includes('item one'), `bullet not stripped: ${out}`);
    assert.ok(out.includes('-5 degrees'), `negative sign lost: ${out}`);
  });

  test('Yoruba expands litres only after a number', () => {
    const out = normalizeSpeechText('Mo ra 5 L omi. Plan L', 'yo');
    assert.ok(out.includes('5 lítà'), out);
    assert.ok(out.includes('Plan L'), out);
  });

  test('Igbo expands litres only after a number', () => {
    const out = normalizeSpeechText('Ọ bụ 5 L mmiri. Plan L', 'ig');
    assert.ok(out.includes('5 lita'), out);
    assert.ok(out.includes('Plan L'), out);
  });

  test('Yoruba currency and percent rules still apply', () => {
    const out = normalizeSpeechText('₦5,000 & 15%', 'yo');
    assert.ok(out.includes('5,000 naira'), out);
    assert.ok(out.includes('àti'), out);
    assert.ok(out.includes('pásẹ́ntì'), out);
  });
});

describe('speaker aliases', () => {
  test('John resolves to the catalogue ID', () => {
    assert.deepEqual(resolveSpeaker('John'), { speaker_id: 'slr70_ngm_09334' });
    assert.deepEqual(resolveSpeaker('john'), { speaker_id: 'slr70_ngm_09334' });
  });
});

describe('voice catalog (voices come from the servers)', () => {
  test('a voice is routed to the endpoint that reports it', async () => {
    await withFetch(rosterHandler(), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) });
      assert.deepEqual(await catalog.resolve('Adunni'), { endpoint: 'v2', speaker: 'Adunni', label: 'Adunni' });
      assert.deepEqual(await catalog.resolve('Morenike'), { endpoint: 'v5', speaker: 'Morenike', label: 'Morenike' });
    });
  });

  test('the John alias maps to the v5 speaker, with a friendly label', async () => {
    await withFetch(rosterHandler(), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) });
      assert.deepEqual(await catalog.resolve('John'), { endpoint: 'v5', speaker: 'slr70_ngm_09334', label: 'John' });
    });
  });

  test('a voice on both endpoints goes to the preferred one', async () => {
    await withFetch(rosterHandler(), async () => {
      const both = { v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) };
      assert.equal((await new VoiceCatalog(both, { preferred: 'v2' }).resolve('Blessing')).endpoint, 'v2');
      assert.equal((await new VoiceCatalog(both, { preferred: 'v5' }).resolve('Blessing')).endpoint, 'v5');
    });
  });

  test('a v5-only voice cannot be used for cloning (want v2)', async () => {
    await withFetch(rosterHandler(), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) });
      await assert.rejects(catalog.resolve('John', 'v2'), /only available on STORM TTS v5/);
    });
  });

  test('a v5 voice with no v5 key explains what to set', async () => {
    await withFetch(rosterHandler(), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }) });
      await assert.rejects(catalog.resolve('John'), /STORM_TTS_API_KEY/);
    });
  });

  test('an unknown voice lists the voices that exist', async () => {
    await withFetch(rosterHandler(), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) });
      await assert.rejects(catalog.resolve('Nobody'), /Unknown voice "Nobody". Available voices: .*Adunni/);
    });
  });

  test('a new voice added on a server appears without any code change', async () => {
    const rosters = [V2_ROSTER, { languages: { ha: { label: 'Hausa', voices: [{ name: 'Zainab', gender: 'female' }] } } }];
    let i = 0;
    await withFetch((url) => (url.endsWith('/voices') ? jsonResponse(rosters[Math.min(i++, 1)]) : wavResponse()), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }) }, { ttlMs: 0 });
      await assert.rejects(catalog.resolve('Zainab'), /not on STORM-OS-TTS-V2|Unknown voice/);
      assert.equal((await catalog.resolve('Zainab')).endpoint, 'v2');
    });
  });

  test('a v5 outage does not drop John or other v5 voices from the list', async () => {
    let v5Down = false;
    await withFetch((url) => {
      if (url.startsWith(V5) && v5Down) return new Response('down', { status: 503 });
      return rosterHandler()(url);
    }, async () => {
      const catalog = new VoiceCatalog(
        { v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }), v5: new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' }) },
        { ttlMs: 0 }
      );
      assert.equal((await catalog.resolve('John')).endpoint, 'v5');
      v5Down = true;
      assert.equal((await catalog.resolve('John')).endpoint, 'v5', 'John vanished during a v5 outage');
      assert.equal((await catalog.resolve('Adunni')).endpoint, 'v2');
    });
  });

  test('if an endpoint fails on refresh, the last good list is kept', async () => {
    let fail = false;
    await withFetch((url) => (fail ? new Response('down', { status: 503 }) : jsonResponse(V2_ROSTER)), async () => {
      const catalog = new VoiceCatalog({ v2: new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' }) }, { ttlMs: 0 });
      await catalog.refresh();
      fail = true;
      assert.equal((await catalog.resolve('Adunni')).endpoint, 'v2');
    });
  });
});

describe('engine routing and key placement', () => {
  test('a 503 from the server is retried once, then succeeds', async () => {
    let n = 0;
    await withFetch(() => (++n === 1 ? new Response('generation failed', { status: 503 }) : wavResponse()), async (calls) => {
      const client = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      const result = await client.generate({ text: 'Bawo ni', name: 'Adunni' });
      assert.equal(result.byteLength, 200);
      assert.equal(generateCalls(calls).length, 2);
    });
  });

  test('a 503 that repeats is reported, not retried forever', async () => {
    await withFetch(() => new Response('down', { status: 503 }), async (calls) => {
      const client = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      await assert.rejects(client.generate({ text: 'Bawo ni', name: 'Adunni' }), /503/);
      assert.equal(generateCalls(calls).length, 2);
    });
  });

  test('a v5 client refuses voice cloning without making any request', async () => {
    await withFetch(() => wavResponse(), async (calls) => {
      const client = new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' });
      await assert.rejects(
        client.generate({ text: 'Hello', lang: 'en', referenceAudio: 'ref.wav' }),
        /only available on STORM-OS-TTS-V2/
      );
      assert.equal(calls.length, 0);
    });
  });

  test("a v5 request goes to the configured v5 host, with that client's key", async () => {
    await withFetch(() => wavResponse(), async (calls) => {
      const client = new StormTTSClient({ engine: 'v5-streaming', baseUrl: `${V5}/`, apiKey: 'k5' });
      await client.generate({ text: 'Good evening', name: 'John', fast: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${V5}/generate`);
      assert.equal(calls[0].headers['X-API-Key'], 'k5');
    });
  });

  test('environment variables never redirect a request to another host or key', async () => {
    await withEnv(
      {
        STORM_BASE_URL: 'http://env-v2.test',
        STORM_TTS_BASE_URL: 'http://leak.test',
        STORM_TTS_API_KEY: 'leaked-v5-key',
        STORM_API_KEY: 'env-v2-key',
      },
      async () => {
        await withFetch(() => wavResponse(), async (calls) => {
          const client = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
          await client.generate({ text: 'Bawo ni', name: 'Adunni' });
          assert.equal(calls.length, 1);
          assert.equal(calls[0].url, `${V2}/generate`);
          assert.equal(calls[0].headers['X-API-Key'], 'k2');
        });
      }
    );
  });

  test('a custom domain is used as given', async () => {
    await withFetch(() => wavResponse(), async (calls) => {
      const client = new StormTTSClient({ engine: 'v2-cloning', baseUrl: 'https://tts.example.com', apiKey: 'k' });
      await client.generate({ text: 'Hello there', name: 'Adunni' });
      assert.equal(calls[0].url, 'https://tts.example.com/generate');
    });
  });

  test('streaming goes to the configured v5 host', async () => {
    await withFetch(() => new Response(new Uint8Array([1, 2, 3, 4])), async (calls) => {
      const client = new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' });
      let total = 0;
      for await (const chunk of client.streamSpeech({ text: 'Hello', name: 'Blessing', lang: 'pcm' })) {
        total += chunk.byteLength;
      }
      assert.equal(calls[0].url, `${V5}/generate/stream`);
      assert.equal(calls[0].headers['X-API-Key'], 'k5');
      assert.equal(total, 4);
    });
  });

  test('streaming on a V2 client fails without making any request', async () => {
    await withFetch(() => wavResponse(), async (calls) => {
      const client = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      await assert.rejects(async () => {
        for await (const _ of client.streamSpeech({ text: 'Hello', name: 'Adunni' })) {
          // drain
        }
      }, /require STORM TTS v5/);
      assert.equal(calls.length, 0);
    });
  });

  test('WebSocket URL carries no credentials and uses the configured host', () => {
    const client = new StormTTSClient({ engine: 'v5-streaming', baseUrl: 'http://127.0.0.1:9', apiKey: 'secret-key' });
    const session = client.createWebSocketSession();
    try {
      assert.equal(session.url, 'ws://127.0.0.1:9/generate/stream/ws');
      assert.ok(!session.url.includes('secret-key'));
      assert.ok(!session.url.includes('api_key'));
    } finally {
      session.close();
    }
  });
});

describe('sandboxed file paths', () => {
  let root;
  let outside;

  test('setup', async () => {
    root = await fs.realpath(await tempDir('storm-root-'));
    outside = await fs.realpath(await tempDir('storm-outside-'));
    await fs.writeFile(path.join(outside, 'secret.wav'), Buffer.alloc(64));
    await fs.writeFile(path.join(root, 'ref.wav'), Buffer.alloc(64));
    await fs.symlink(path.join(outside, 'secret.wav'), path.join(root, 'link.wav'));
  });

  test('accepts a new file inside the root, resolving relative paths against it', async () => {
    const p = await resolveSandboxedPath('out/speech.wav', { root, extensions: ['.wav'] });
    assert.equal(p, path.join(root, 'out', 'speech.wav'));
  });

  test('accepts an existing reference file inside the root', async () => {
    const p = await resolveSandboxedPath('ref.wav', { root, extensions: ['.wav'], mustExist: true });
    assert.equal(p, path.join(root, 'ref.wav'));
  });

  test('rejects parent-directory escapes', async () => {
    await assert.rejects(resolveSandboxedPath('../escape.wav', { root, extensions: ['.wav'] }), /inside the allowed directory/);
  });

  test('rejects absolute paths outside the root', async () => {
    await assert.rejects(resolveSandboxedPath(path.join(outside, 'x.wav'), { root, extensions: ['.wav'] }), /inside the allowed directory/);
  });

  test('rejects sibling directories that share the root as a string prefix', async () => {
    await assert.rejects(resolveSandboxedPath(path.join(`${root}-evil`, 'x.wav'), { root, extensions: ['.wav'] }), /inside the allowed directory/);
  });

  test('rejects symlinks that point outside the root', async () => {
    await assert.rejects(resolveSandboxedPath('link.wav', { root, extensions: ['.wav'], mustExist: true }), /inside the allowed directory/);
  });

  test('rejects other file types', async () => {
    await assert.rejects(resolveSandboxedPath('notes.txt', { root, extensions: ['.wav'] }), /Only \.wav files are allowed/);
  });

  test('reports a missing reference file', async () => {
    await assert.rejects(resolveSandboxedPath('missing.wav', { root, extensions: ['.wav'], mustExist: true }), /File not found/);
  });

  test('cleanup', async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('limits', () => {
  test('concurrency runs at most N at once and keeps the rest waiting', async () => {
    const gate = new Concurrency(2);
    let peak = 0;
    let running = 0;
    const task = () => gate.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    assert.equal(peak, 2);
  });

  test('rate limiter refuses calls over the limit within a minute', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.hit('k');
    limiter.hit('k');
    assert.throws(() => limiter.hit('k'), LimitError);
    now += 60_001;
    limiter.hit('k');
  });

  test('daily quota refuses characters over the limit and counts per key', () => {
    let now = Date.UTC(2026, 9, 21, 12);
    const quota = new DailyQuota(10, () => now);
    quota.consume('a', 6);
    assert.throws(() => quota.consume('a', 5), LimitError);
    quota.consume('b', 10);
    now = Date.UTC(2026, 9, 22, 1);
    quota.consume('a', 10);
  });
});

describe('persisted daily usage', () => {
  test('usage survives a restart', async () => {
    const dir = await tempDir('storm-usage-');
    try {
      const file = path.join(dir, 'usage.json');
      const now = () => Date.UTC(2026, 9, 22, 9);
      new DailyQuota(10, now, file).consume('a', 8);
      const after = new DailyQuota(10, now, file);
      assert.throws(() => after.consume('a', 5), LimitError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('user keys', () => {
  test('keys verify, can be disabled, and are never stored in plain text', async () => {
    const dir = await tempDir('storm-keys-');
    try {
      const file = path.join(dir, 'keys.json');
      const store = new KeyStore(file);
      const { key, record } = await store.create('ada');
      assert.ok(key.startsWith('stm_'));
      assert.equal((await store.verify(key)).name, 'ada');
      assert.equal(await store.verify(key + 'x'), undefined);
      assert.equal(await store.verify(undefined), undefined);

      const onDisk = await fs.readFile(file, 'utf8');
      assert.ok(!onDisk.includes(key), 'plain key found on disk');

      await store.disable(record.id);
      assert.equal(await store.verify(key), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('two active keys cannot share a name', async () => {
    const dir = await tempDir('storm-keys-dup-');
    try {
      const store = new KeyStore(path.join(dir, 'keys.json'));
      await store.create('team');
      await assert.rejects(store.create('team'), /already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP tools', () => {
  test('storm_tts_speak refuses an output path outside the sandbox before generating', async () => {
    const root = await fs.realpath(await tempDir('storm-mcp-root-'));
    const outside = await fs.realpath(await tempDir('storm-mcp-out-'));
    try {
      await withFetch(rosterHandler(), async (calls) => {
        const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
        const { client, close } = await connectMcp(createStormMcpServer({ v2 }, { sandboxRoot: root }));
        try {
          const res = await client.callTool({
            name: 'storm_tts_speak',
            arguments: { text: 'Hello', voice: 'Adunni', outputPath: path.join(outside, 'x.wav') },
          });
          assert.equal(res.isError, true);
          assert.match(res.content[0].text, /inside the allowed directory/);
          assert.equal(generateCalls(calls).length, 0, 'generation ran before the path was checked');
        } finally {
          await close();
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('storm_tts_speak writes inside the sandbox', async () => {
    const root = await fs.realpath(await tempDir('storm-mcp-ok-'));
    try {
      await withFetch(rosterHandler(), async () => {
        const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
        const { client, close } = await connectMcp(createStormMcpServer({ v2 }, { sandboxRoot: root }));
        try {
          const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Hello', voice: 'Adunni', outputPath: 'speech.wav' } });
          assert.notEqual(res.isError, true, res.content[0]?.text);
          assert.equal((await fs.stat(path.join(root, 'speech.wav'))).size, 200);
        } finally {
          await close();
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('storm_tts_speak with John and no v5 key fails with a clear message and makes no generation request', async () => {
    await withFetch(rosterHandler(), async (calls) => {
      const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      const { client, close } = await connectMcp(createStormMcpServer({ v2 }));
      try {
        const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Hello', voice: 'John' } });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /STORM_TTS_API_KEY/);
        assert.equal(generateCalls(calls).length, 0);
      } finally {
        await close();
      }
    });
  });

  test('storm_tts_speak with John routes to the v5 client, not the V2 client', async () => {
    const root = await fs.realpath(await tempDir('storm-mcp-route-'));
    try {
      await withFetch(rosterHandler(), async (calls) => {
        const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
        const v5 = new StormTTSClient({ engine: 'v5-streaming', baseUrl: V5, apiKey: 'k5' });
        const { client, close } = await connectMcp(createStormMcpServer({ v2, v5 }, { sandboxRoot: root }));
        try {
          const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Good evening', voice: 'John', outputPath: 'john.wav' } });
          assert.notEqual(res.isError, true, res.content[0]?.text);
          const gens = generateCalls(calls);
          assert.equal(gens.length, 1);
          assert.equal(gens[0].url, `${V5}/generate`);
          assert.equal(gens[0].headers['X-API-Key'], 'k5');
        } finally {
          await close();
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('inline mode returns audio in the response and touches no files', async () => {
    await withFetch(rosterHandler(), async () => {
      const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      const { client, close } = await connectMcp(createStormMcpServer({ v2 }, { outputMode: 'inline' }));
      try {
        const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Hello', voice: 'Adunni' } });
        assert.notEqual(res.isError, true, res.content[0]?.text);
        const audio = res.content.find((c) => c.type === 'audio');
        assert.ok(audio, 'no audio content in result');
        assert.equal(audio.mimeType, 'audio/wav');
        assert.ok(Buffer.from(audio.data, 'base64').length > 0);
      } finally {
        await close();
      }
    });
  });

  test('the guard can refuse a generation, and nothing is generated', async () => {
    await withFetch(rosterHandler(), async (calls) => {
      const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: V2, apiKey: 'k2' });
      const guard = () => {
        throw new LimitError('Daily limit reached.');
      };
      const { client, close } = await connectMcp(createStormMcpServer({ v2 }, { outputMode: 'inline', guard }));
      try {
        const res = await client.callTool({ name: 'storm_tts_speak', arguments: { text: 'Hello', voice: 'Adunni' } });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /Daily limit reached/);
        assert.equal(generateCalls(calls).length, 0);
      } finally {
        await close();
      }
    });
  });
});

describe('HTTP gateway', () => {
  async function setup(extra = {}) {
    const dir = await tempDir('storm-gateway-');
    const store = new KeyStore(path.join(dir, 'keys.json'));
    const v2 = new StormTTSClient({ engine: 'v2-cloning', baseUrl: 'http://127.0.0.1:9', apiKey: 'k2' });
    const gateway = await startGateway({
      port: 0,
      host: '127.0.0.1',
      keyStore: store,
      clients: { v2 },
      defaultEngine: 'v2-cloning',
      requestsPerMinute: 30,
      dailyCharacters: 20000,
      concurrency: { v2: 1, v5: 2 },
      ...extra,
    });
    return {
      store,
      gateway,
      dir,
      async cleanup() {
        await gateway.close();
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  }

  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gw-test', version: '1.0.0' } },
  };

  const post = (base, key, body, extraHeaders = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(key && { Authorization: `Bearer ${key}` }),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

  test('health check needs no key', async () => {
    const env = await setup();
    try {
      const res = await fetch(`${env.gateway.url}/healthz`);
      assert.equal(res.status, 200);
    } finally {
      await env.cleanup();
    }
  });

  test('MCP refuses requests without a valid key', async () => {
    const env = await setup();
    try {
      assert.equal((await post(env.gateway.url, undefined, initBody)).status, 401);
      assert.equal((await post(env.gateway.url, 'stm_not-a-real-key', initBody)).status, 401);
    } finally {
      await env.cleanup();
    }
  });

  test('a valid key opens a session, and another key cannot use it', async () => {
    const env = await setup();
    try {
      const { key } = await env.store.create('ada');
      const { key: other } = await env.store.create('bob');

      const init = await post(env.gateway.url, key, initBody);
      assert.equal(init.status, 200);
      const sessionId = init.headers.get('mcp-session-id');
      assert.ok(sessionId, 'no session id returned');

      const stolen = await post(
        env.gateway.url,
        other,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { 'mcp-session-id': sessionId }
      );
      assert.equal(stolen.status, 403);
    } finally {
      await env.cleanup();
    }
  });

  test('a disabled key stops working', async () => {
    const env = await setup();
    try {
      const { key, record } = await env.store.create('temp');
      assert.equal((await post(env.gateway.url, key, initBody)).status, 200);
      await env.store.disable(record.id);
      assert.equal((await post(env.gateway.url, key, initBody)).status, 401);
    } finally {
      await env.cleanup();
    }
  });

  test('a key over its per-minute limit gets 429', async () => {
    const env = await setup();
    try {
      const { key } = await env.store.create('limited', { requestsPerMinute: 2 });
      assert.equal((await post(env.gateway.url, key, initBody)).status, 200);
      assert.equal((await post(env.gateway.url, key, initBody)).status, 200);
      assert.equal((await post(env.gateway.url, key, initBody)).status, 429);
    } finally {
      await env.cleanup();
    }
  });

  test('an unknown session id is refused', async () => {
    const env = await setup();
    try {
      const { key } = await env.store.create('ada');
      const res = await post(env.gateway.url, key, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'mcp-session-id': 'nope' });
      assert.equal(res.status, 404);
    } finally {
      await env.cleanup();
    }
  });
});
