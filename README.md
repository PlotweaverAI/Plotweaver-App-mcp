# @plotweaver/mcp-storm-tts

[![MCP Standard](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blue.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

Official **Model Context Protocol (MCP) Server** and **Developer SDK** for **PlotWeaver STORM TTS** — the high-fidelity Nigerian multilingual text-to-speech platform supporting **Yorùbá, Hausa, Igbo, Nigerian Pidgin, and Nigerian English**.

Enables AI agents (Claude Desktop, Cursor, Antigravity, VS Code, Goose) and applications to synthesize authentic speech, stream real-time audio via WebSockets, and perform **zero-shot custom voice cloning**.

---

## ⚡ The Dual-Engine Architecture: Model A vs Model B

PlotWeaver supports two specialized model engines. The SDK seamlessly connects to either or auto-detects based on your endpoint:

| Feature / Capability | Model A: `v2-cloning` (Studio) | Model B: `v5-streaming` (Real-Time) |
| :--- | :--- | :--- |
| **Backend Engine** | PyTorch / Chatterbox LoRA (`STORM-OS-TTS-V2`) | **vLLM Accelerated Engine (`storm-tts v5`)** |
| **Default Endpoint** | `http://18.208.227.247:8000` | `http://54.198.152.226:8000` |
| **Primary Specialty** | **Zero-Shot Voice Cloning & Studio Quality** | **Ultra-Low Latency & Conversational Agents** |
| **Real-time Streaming** | ❌ None (Whole WAV response) | ✅ **HTTP Chunked (`/generate/stream`) & WebSocket** |
| **WebSocket Support** | ❌ | ✅ **Persistent `WS /generate/stream/ws`** |
| **Zero-Shot Voice Cloning** | ✅ **Upload 4–8s reference audio** | ❌ Pre-set named speakers only |
| **Top English Voice** | `David` (Male, 0.45h) | **`John` (`slr70_ngm_09334`)** (Flagship Broadcast Voice) / `Yemi` |
| **Top Pidgin Voice** | `Blessing` (Female, 8.6h) / `Chuks` (Male) | **`John`** (Broadcast / News) / `Blessing` / `Emeka` |
| **Top Yoruba Voice** | `Adunni` (Female, 61.7h) / `Kayode` (Male) | `Morenike` (Female, 61.7h) / `Adewale` (Male) |
| **Top Hausa Voice** | `Amina` (Female, 27.6h) / `Sani` (Male) | `Amina` (Female, 27.6h) |
| **Top Igbo Voice** | `Ngozi` (Female, 4.5h) / `Chinedu` (Male) | `Adaeze` (Female, 4.5h) / `Chidi` (Male) |

---

## 🎙️ John: Flagship Nigerian English & Pidgin Voice

**John** (catalogue speaker `slr70_ngm_09334` on Model B / v5) is PlotWeaver's flagship voice for:
- **Nigerian English Broadcasts**: Authoritative, energetic delivery used in news briefings and banking agents.
- **Nigerian Pidgin**: Authentic, natural street and conversational pacing.

### Using John:
In MCP tools or SDK, simply pass `"voice": "John"` or `"name": "John"`. The SDK automatically maps it to `speaker_id: "slr70_ngm_09334"`.

```typescript
// Synthesize John in Nigerian English or Pidgin
const res = await storm.generate({
  text: 'Good morning Nigeria! Make we examine the market updates today.',
  name: 'John',
  fast: true,
});
```

> **Pro-Tip (Newslink & Kivo Delivery)**: John is synthesized cleanly at 24kHz 1.0× speed. In frontends and client audio players, set `audioElement.playbackRate = 1.25` for his trademark crisp, energetic broadcast pace.

---

## 🛠️ How Developers Choose Between Engines

You can explicitly configure the engine in code or via environment variables:

### 1. In the Developer SDK (TypeScript / Node.js)

```typescript
import { StormTTSClient } from '@plotweaver/mcp-storm-tts';

// Option 1: Fast Conversational Streaming (Model B)
const storm = new StormTTSClient({
  engine: 'v5-streaming', // Auto-points to http://54.198.152.226:8000
  apiKey: process.env.STORM_TTS_API_KEY,
});

// Option 2: Custom Voice Cloning & Studio Generation (Model A)
const studio = new StormTTSClient({
  engine: 'v2-cloning', // Auto-points to http://18.208.227.247:8000
  apiKey: process.env.STORM_API_KEY,
});

// Option 3: Auto-detect capabilities from custom domain/URL
const client = new StormTTSClient({
  baseUrl: 'https://tts.plotweaver.app',
});
```

### 2. In Environment Variables (MCP & CLI)

```env
# Point to Model B (v5 streaming)
STORM_ENGINE=v5-streaming
STORM_TTS_BASE_URL=http://54.198.152.226:8000
STORM_TTS_API_KEY=your_key_here

# Or point to Model A (V2 voice cloning)
STORM_ENGINE=v2-cloning
STORM_BASE_URL=http://18.208.227.247:8000
STORM_API_KEY=your_key_here
```

---

## 💻 Developer SDK Usage Examples

### 1. Ultra-Low Latency HTTP Streaming (Model B)

Streams signed 16-bit 24kHz mono PCM chunks in real time as they are synthesized on the GPU:

```typescript
import { StormTTSClient } from '@plotweaver/mcp-storm-tts';

const storm = new StormTTSClient({ engine: 'v5-streaming' });

for await (const chunk of storm.streamSpeech({
  text: 'Good morning! Make we code better things today.',
  name: 'Blessing',
  lang: 'pcm', // Nigerian Pidgin
  fast: true,
})) {
  // Feed chunk directly to speaker / audio output
  console.log(`Received audio chunk: ${chunk.byteLength} bytes`);
}
```

### 2. Persistent WebSocket Voice Session (Model B)

Recommended for real-time conversational voice agents (telephony, WebRTC, LiveKit). Keeps the connection open across multiple dialogue turns to avoid TCP/TLS handshake latency:

```typescript
const session = storm.createWebSocketSession();

const done = await session.synthesize({
  text: 'Ẹ kú àárọ̀ o, báwo ni nǹkan?',
  name: 'Morenike',
  lang: 'yo', // Yorùbá
  onChunk: (chunk) => {
    // Process live PCM chunk
  },
});

console.log(`Utterance completed in ${done.total_time_s}s`);
session.close();
```

### 3. Zero-Shot Voice Cloning (Model A)

Clone any voice in any of the 5 languages from a 4–8 second audio sample:

```typescript
import { StormTTSClient } from '@plotweaver/mcp-storm-tts';

const studio = new StormTTSClient({ engine: 'v2-cloning' });

const { outputPath } = await studio.generateAndSave(
  {
    text: 'How far! You dey listen to my cloned voice now.',
    referenceAudio: './samples/my_speaker_sample.wav',
    lang: 'pcm', // Nigerian Pidgin
  },
  './cloned-output.wav'
);
```

### 4. Multilingual Speech Normalization

Pre-processes text according to **Emmanuel Ariyo's Multilingual TTS Normalization Rules** (expands currencies like `₦` to words, converts percentages, formats time, and strips LLM markdown):

```typescript
import { normalizeSpeechText } from '@plotweaver/mcp-storm-tts';

// Yorùbá:
normalizeSpeechText('Owó náà jẹ́ ₦5,000 ní 7:45 a.m.', 'yo');
// -> "Owó náà jẹ́ 5,000 naira ní 7:45 àárọ̀"

// Igbo:
normalizeSpeechText('Ego bụ ₦2,000 million na 10% pasentị', 'ig');
// -> "Ego bụ 2,000 nde naịra na 10 pasentị"

// Hausa:
normalizeSpeechText('Kudin shi ne ₦10,000 tare da 50%', 'ha');
// -> "Kudin shi ne 10,000 naira tare da 50 kashi"
```

---

## 🚀 AI Assistants & IDEs (MCP Quickstart)

Add to your **Claude Desktop** config (`claude_desktop_config.json`) or **Cursor** settings:

```json
{
  "mcpServers": {
    "storm-tts": {
      "command": "npx",
      "args": ["-y", "@plotweaver/mcp-storm-tts"],
      "env": {
        "STORM_API_KEY": "your_api_key_here",
        "STORM_BASE_URL": "http://18.208.227.247:8000"
      }
    }
  }
}
```

### Available MCP Tools:

1. **`storm_tts_speak`**: Synthesizes speech to disk with tone mark support in Yorùbá, Hausa, Igbo, Pidgin, and English. Defaults to `fast: true`.
2. **`storm_tts_clone_voice`**: Zero-shot voice cloning from a 4–8s reference audio clip.
3. **`storm_tts_list_voices`**: Lists all available voices/speakers with gender and training corpus hours.
4. **`storm_tts_health`**: Inspects server health, active engine (`v2-cloning` vs `v5-streaming`), GPU hardware, and streaming status.

---

## 🧪 Testing

Run the full automated test suite (verifying normalization, both engines, streaming, WebSockets, and MCP tools):

```bash
npm test
```

---

## 🛡️ License

Apache 2.0. Copyright 2026 PlotWeaver AI.
