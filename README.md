# STORM TTS: Nigerian Speech for AI Assistants and Apps

[![MCP Standard](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blue.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

Turn text into natural speech in **Yorùbá, Hausa, Igbo, Nigerian Pidgin, and Nigerian English**, using PlotWeaver STORM TTS.

This package works in two ways:

- **With an AI assistant** (Claude, Cursor, VS Code, and others). Ask the assistant to read something aloud, and it saves a WAV audio file. No coding needed.
- **In your own app**, using the TypeScript SDK. See [For developers](#for-developers).

---

## Use it with an AI assistant

### What you need

1. **A STORM key.** Get it from your STORM provider. There are two kinds:
   - `STORM_API_KEY` covers most voices and voice cloning.
   - `STORM_TTS_API_KEY` covers **John** (the flagship English and Pidgin voice) and live streaming. You only need it if you want those.
2. **An AI assistant that supports MCP** (see [Which apps work](#which-apps-work)).

### Set it up

Add this to your assistant's MCP settings. It's a JSON file in Claude Desktop, and a similar settings screen in other apps:

```json
{
  "mcpServers": {
    "storm-tts": {
      "command": "npx",
      "args": ["-y", "@plotweaver/mcp-storm-tts"],
      "env": {
        "STORM_API_KEY": "your-storm-key",
        "STORM_TTS_API_KEY": "your-storm-tts-key"
      }
    }
  }
}
```

Leave out `STORM_TTS_API_KEY` if you don't have it. Everything still works except John and the other v5-only voices.

Restart the app, then ask in plain words:

> *"Read this in Yorùbá with the voice Adunni: Ẹ kú àárọ̀, ẹ kú iṣẹ́."*

The assistant saves a WAV file and tells you where it is.

### Where the audio goes

Audio files are saved to **`storm-audio`** in your home folder (for example, `/Users/you/storm-audio`). The folder is created the first time it's needed.

To use a different folder, add this to the settings above:

```json
"STORM_MCP_ROOT": "/Users/you/Documents/StormAudio"
```

For cloning a voice, put the reference clip (4–8 seconds, WAV) in that folder first.

### Voices

| Language | Voices that work with `STORM_API_KEY` | Voices that need `STORM_TTS_API_KEY` |
| :--- | :--- | :--- |
| Yorùbá | Adunni (F), Kayode (M) | Morenike (F), Adewale (M) |
| Hausa | Amina (F), Sani (M) | Amina (F) |
| Igbo | Ngozi (F), Chinedu (M) | Adaeze (F), Chidi (M) |
| Pidgin | Blessing (F), Chuks (M) | **John**, Blessing (F), Emeka (M) |
| English | David (M) | **John**, Yemi (M) |

> **Note:** use full sentences with John. Very short lines, such as "Good evening. This is John.", fail on the v5 server, and medium-length lines sometimes do. Longer sentences work best.

If you don't know which voice to use, ask the assistant: *"List the STORM voices for Pidgin."*

### What you can ask for

- **Speak text** in any of the five languages, with a chosen voice.
- **Clone a voice** from a short clip. Put the clip in your audio folder first.
- **List voices**, by language.
- **Check the service**, to see whether it's up.

Each request handles up to 1,000 characters. Yorùbá and Igbo tone marks are supported.

### Which apps work

Any app that supports **MCP** (Model Context Protocol) can use this. The setup above works in most of them. Examples:

- **Claude Desktop**: edit `claude_desktop_config.json`.
- **Claude Code** (terminal): run this, replacing the key values:

  ```bash
  claude mcp add storm-tts -e STORM_API_KEY=your-storm-key -e STORM_TTS_API_KEY=your-storm-tts-key -- npx -y @plotweaver/mcp-storm-tts
  ```
- **Cursor**: add it under MCP settings.
- **VS Code** (GitHub Copilot agent mode): add it to `.vscode/mcp.json`, using the same `command`, `args`, and `env` fields.
- **Windsurf, Zed, Cline, Goose, Continue**: each has an MCP settings file or panel that takes the same three fields.

ChatGPT's web app only connects to MCP servers over the internet, not on your computer. This package runs on your computer, so it won't connect there directly.

Each app stores settings in a different place, so check its MCP documentation for the exact file.

---

## For developers

### Install

```bash
npm install @plotweaver/mcp-storm-tts
```

### Create speech

```typescript
import { StormTTSClient } from '@plotweaver/mcp-storm-tts';

const storm = new StormTTSClient({ engine: 'v5-streaming' });

await storm.generateAndSave(
  { text: 'Good morning Nigeria! Make we examine the market updates today.', name: 'John' },
  './john.wav'
);
```

### Stream audio as it's generated (v5)

```typescript
for await (const chunk of storm.streamSpeech({
  text: 'Good morning! Make we code better things today.',
  name: 'Blessing',
  lang: 'pcm',
})) {
  // chunk is 16-bit, 24 kHz, mono PCM. Send it to an audio output.
}
```

### Keep a live voice connection open (v5)

Useful for phone systems and voice agents, where many turns happen on one connection:

```typescript
const session = storm.createWebSocketSession();

const done = await session.synthesize({
  text: 'Ẹ kú àárọ̀ o, báwo ni nǹkan?',
  name: 'Morenike',
  lang: 'yo',
  onChunk: (chunk) => {
    // Handle each PCM chunk as it arrives
  },
});

console.log(`Finished in ${done.total_time_s}s`);
session.close();
```

The v5 WebSocket server only accepts the key as a URL parameter, so the key appears in the connection address. Keep that in mind for proxy and server logs.

### Clone a voice (V2)

```typescript
const studio = new StormTTSClient({ engine: 'v2-cloning' });

await studio.generateAndSave(
  {
    text: 'How far! You dey listen to my cloned voice now.',
    referenceAudio: './samples/my_speaker_sample.wav', // 4–8 seconds, WAV
    lang: 'pcm',
  },
  './cloned-output.wav'
);
```

### Text cleanup

Before speaking, text is adjusted for correct pronunciation: currency symbols are spelled out, percentages and times are converted, and markdown is removed. You can run it on its own:

```typescript
import { normalizeSpeechText } from '@plotweaver/mcp-storm-tts';

normalizeSpeechText('Kudin shi ne ₦10,000 tare da 50%', 'ha');
// -> "Kudin shi ne 10,000 naira tare da 50 kashi"
```

### Settings in code

```typescript
new StormTTSClient({ engine: 'v5-streaming' });  // reads STORM_TTS_* settings
new StormTTSClient({ engine: 'v2-cloning' });    // reads STORM_* settings
new StormTTSClient({ baseUrl: 'https://tts.example.com', apiKey: process.env.MY_KEY });
```

Each client sends its key only to its own address.

### MCP server settings

| Setting | Purpose | Default |
| :--- | :--- | :--- |
| `STORM_API_KEY` | Key for the V2 server | none |
| `STORM_BASE_URL` | V2 server address | `http://18.208.227.247:8000` |
| `STORM_TTS_API_KEY` | Key for the v5 server | none |
| `STORM_TTS_BASE_URL` | v5 server address | `http://54.198.152.226:8000` |
| `STORM_ENGINE` | Prefer v5 for requests that don't name a voice (`v5-streaming`) | `v2-cloning` |
| `STORM_MCP_ROOT` | Folder for reading and writing audio | `~/storm-audio` |

### Upgrading from 1.0.0

- `STORM_TTS_API_KEY` is the only key for v5. It no longer falls back to `STORM_API_KEY`.
- Requests go only to the server you configured.
- `StormWebSocketSession` takes `(url, apiKey)`. Create sessions with `client.createWebSocketSession()`.
- `createStormMcpServer` takes `{ v2, v5 }` clients, or one client as before, plus optional `{ sandboxRoot, defaultEngine }`.

### Tests

```bash
npm test           # offline unit tests. No keys or network needed.
npm run test:live  # runs against the real servers. Needs both keys in .env.
```

---

## Running a public gateway

For people who connect over the internet (not just on your computer), run the HTTP gateway. Users connect with their own keys, and the STORM keys stay on the server.

```bash
node dist/index.js keys create ada            # prints a key once; give it to the person
node dist/index.js keys list
node dist/index.js keys disable ada
node dist/index.js http                       # serves MCP at http://127.0.0.1:8787/mcp
```

Users add it to their app as a remote MCP server with `Authorization: Bearer <key>`. The gateway returns audio inside the response.

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `STORM_GATEWAY_PORT` | `8787` | Port |
| `STORM_GATEWAY_HOST` | `127.0.0.1` | Address to listen on (`0.0.0.0` in the container) |
| `STORM_GATEWAY_KEYS` | `./gateway-keys.json` | Where user keys are stored |
| `STORM_GATEWAY_RPM` | `30` | Requests per minute, per key |
| `STORM_GATEWAY_DAILY_CHARS` | `20000` | Characters of speech per day, per key |
| `STORM_V2_CONCURRENCY` | `1` | Generations at once on the V2 server |
| `STORM_V5_CONCURRENCY` | `8` | Generations at once on the v5 server |

The gateway serves plain HTTP. Put TLS in front of it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and how to add voices.

## Troubleshooting

| You see | What it means | What to do |
| :--- | :--- | :--- |
| "needs a STORM TTS v5 endpoint" | You asked for John or a v5-only voice without the v5 key | Add `STORM_TTS_API_KEY` |
| "Voice cloning needs a STORM-OS-TTS-V2 endpoint" | Cloning needs the V2 key | Add `STORM_API_KEY` |
| "Path must be inside the allowed directory" | The file is outside your audio folder | Move it into the folder, or change `STORM_MCP_ROOT` |
| "Only .wav files are allowed" | Wrong file type | Convert the file to WAV |
| "Missing API key" | The key for that server isn't set | Add the key |
| "fetch failed" | The server can't be reached | Check your internet connection and try again later |
| "403" on a live connection | The key was rejected | Check the key |

---

## License

Apache 2.0. Copyright 2026 PlotWeaver AI.
