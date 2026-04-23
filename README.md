# Ojin Avatar Agent

A real-time conversational AI avatar that understands speech/text and responds with a lip-synced talking head.

## Pipeline

```
User (mic/text) → Web Speech API (STT) → Gemini 2.5 Flash (LLM) → ElevenLabs (TTS PCM) → Ojin Flashhead-lite (lip-sync video) → Browser (canvas + audio)
```

If ElevenLabs is unavailable, browser SpeechSynthesis is used as a TTS fallback.

## Architecture

```
┌──────────────┐         ┌──────────────────────────────┐
│   Browser    │◄──WS───►│       Node.js Backend        │
│              │         │                              │
│  - Canvas    │         │  ┌─────────┐  ┌───────────┐ │
│  - Audio     │         │  │ Gemini  │  │ ElevenLabs│ │
│  - Mic/Text  │         │  │  Chat   │──│   TTS     │ │
│  - STT       │         │  └─────────┘  └─────┬─────┘ │
│              │         │                     │ PCM   │
│              │         │              ┌──────▼──────┐ │
│              │◄─frames─│              │    Ojin     │ │
│              │         │              │ Flashhead   │ │
│              │         │              └─────────────┘ │
└──────────────┘         └──────────────────────────────┘
```

## Setup

### 1. Get API keys

| Service | Where | What you need |
|---------|-------|---------------|
| **Ojin** | https://ojin.ai | API key + create a Persona in the Flashhead Lite tab → copy the Config ID |
| **Gemini** | https://aistudio.google.com/apikey | API key |
| **ElevenLabs** | https://elevenlabs.io | API key (paid plan required for API voice access) |

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your actual keys:

```
OJIN_API_KEY=ak_your_ojin_api_key
OJIN_CONFIG_ID=your_persona_config_id
GEMINI_API_KEY=your_gemini_key
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

### 3. Install & run

```bash
npm install
npm start
```

The server prints a status check on startup:

```
🎭 Ojin Avatar Agent running at http://localhost:3000
   Gemini: ✓
   ElevenLabs: ✓
   Ojin: ✓
```

### 4. Open browser

Go to `http://localhost:3000` — click **Connect Avatar**, then type or speak.

### Customizing the avatar personality

Edit the `systemPrompt` variable in `server.js` to change what the avatar talks about and how it behaves.

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Stuck on "connecting..." | Ojin API key invalid or no Persona created | Regenerate key at ojin.ai, create a Persona, use its Config ID |
| No avatar video | Config ID doesn't match your account | Copy Config ID from your Flashhead Lite dashboard |
| No voice audio | ElevenLabs free plan | Upgrade to paid plan, or use browser TTS fallback (automatic) |
| Gemini error | Model unavailable | Check your Gemini API key at aistudio.google.com |

## Notes

- **STT**: Uses browser's Web Speech API (Chrome recommended)
- **Voice ID**: Default is "Rachel". Find other voices at https://api.elevenlabs.io/v1/voices
- **PCM format**: ElevenLabs outputs `pcm_16000` (S16LE) which Ojin requires
- **Latency**: Expect ~2-4s end-to-end (Gemini + ElevenLabs + Ojin)

## Production Considerations

- Add WebRTC for lower-latency video delivery
- Use Pipecat framework for proper pipeline orchestration
- Add Deepgram for server-side STT (more reliable than Web Speech API)
- Implement interruption handling (cancel Ojin + stop TTS when user speaks)
- Add rate limiting and session management
