import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI } from '@google/genai';
import { fal } from '@fal-ai/client';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import struct from './struct.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──
const PORT = process.env.PORT || 3000;
const OJIN_API_KEY = process.env.OJIN_API_KEY;
const OJIN_CONFIG_ID = process.env.OJIN_CONFIG_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FAL_KEY = process.env.FAL_KEY;
const OJIN_WS_URL = `wss://models.ojin.ai/realtime?config_id=${OJIN_CONFIG_ID}`;

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

// ── Gemini client ──
const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ── Express + HTTP server ──
const app = express();
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());
const server = createServer(app);

// ── Client WebSocket server (browser <-> backend) ──
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('[client] Browser connected');

  let ojinWs = null;
  let ojinReady = false;
  let chatHistory = [];

  // System prompt for the avatar personality
  const systemPrompt = `You are an AI specialist employee. You are embodied as a talking avatar.
Your head (manager) will ask what you have done while he was not here. Here is what you did:
- There were security vulnerabilities — you redirected all environment variables and handled SDK updates on InnoSprint.
- You worked on a photo generator and published it.
- The mindmap at IRU is ready to install.

Answer naturally as if you are reporting to your manager. Be confident, concise (1-3 sentences), and professional.
Don't use markdown, bullet points, or special formatting since your responses will be spoken aloud.
Respond in the same language the user speaks.`;

  // ── Connect to Ojin ──
  function connectOjin() {
    console.log('[ojin] Connecting...');
    ojinWs = new WebSocket(OJIN_WS_URL, {
      headers: { 'Authorization': OJIN_API_KEY },
      perMessageDeflate: false,
    });

    ojinWs.binaryType = 'arraybuffer';

    ojinWs.on('open', () => {
      console.log('[ojin] WebSocket opened');
    });

    ojinWs.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary && buf[0] === 0x7B) {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg.type === 'sessionReady') {
            ojinReady = true;
            console.log('[ojin] Session ready, load:', msg.payload?.load);
            clientWs.send(JSON.stringify({ type: 'ojin_ready' }));

            // Send initial silence frame
            const silence = Buffer.alloc(640 * 2); // one frame of silence
            const header = struct.buildAudioInput(silence);
            ojinWs.send(header);
          } else if (msg.type === 'errorResponse') {
            console.error('[ojin] Error:', msg.payload);
            clientWs.send(JSON.stringify({ type: 'error', message: `Ojin: ${msg.payload?.message}` }));
          }
        } catch (e) {
          console.error('[ojin] Text message:', data.toString?.() || data);
        }
      } else {
        // Binary frame — forward to browser
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(buf);
        }
      }
    });

    let ojinErrorSent = false;

    ojinWs.on('error', (err) => {
      console.error('[ojin] Error:', err.message);
      if (!ojinErrorSent && clientWs.readyState === WebSocket.OPEN) {
        ojinErrorSent = true;
        clientWs.send(JSON.stringify({ type: 'ojin_failed', message: `Ojin: ${err.message}` }));
      }
    });

    ojinWs.on('close', (code, reason) => {
      console.log(`[ojin] Closed (${code})`);
      const wasReady = ojinReady;
      ojinReady = false;
      if (!wasReady && !ojinErrorSent && clientWs.readyState === WebSocket.OPEN) {
        ojinErrorSent = true;
        clientWs.send(JSON.stringify({ type: 'ojin_failed', message: `Ojin closed (${code}). Check your API key.` }));
      }
    });
  }

  // ── Orpheus TTS (fal.ai) fallback → Ojin ──
  async function orpheusTtsAndForward(text) {
    console.log(`[orpheus-tts] Synthesizing: "${text.substring(0, 60)}..."`);
    try {
      const result = await fal.subscribe('fal-ai/orpheus-tts', {
        input: { text, voice: 'leo' },
      });

      const wavUrl = result.data?.audio?.url;
      if (!wavUrl) throw new Error('No audio URL in response');

      const wavResponse = await fetch(wavUrl);
      if (!wavResponse.ok) throw new Error(`WAV download failed: ${wavResponse.status}`);

      const wavBuf = Buffer.from(await wavResponse.arrayBuffer());
      // Skip 44-byte WAV header → raw PCM 24kHz 16-bit mono
      const pcm24 = wavBuf.subarray(44);
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);

      // Resample 24kHz → 16kHz
      const outLen = Math.floor(samples24.length * 2 / 3);
      const samples16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * 1.5;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        samples16[i] = Math.round((samples24[idx] || 0) + frac * ((samples24[idx + 1] || 0) - (samples24[idx] || 0)));
      }
      const pcm16 = Buffer.from(samples16.buffer);
      console.log(`[orpheus-tts] Resampled ${pcm24.length}B @24k → ${pcm16.length}B @16k`);

      const CHUNK_SIZE = 12800;
      const chunks = [];
      for (let off = 0; off < pcm16.length; off += CHUNK_SIZE) {
        chunks.push(pcm16.subarray(off, Math.min(off + CHUNK_SIZE, pcm16.length)));
      }

      for (const chunk of chunks) {
        if (ojinWs && ojinReady && ojinWs.readyState === WebSocket.OPEN) {
          ojinWs.send(struct.buildAudioInput(chunk));
        }
      }
      console.log(`[orpheus-tts] Sent ${pcm16.length} bytes (${chunks.length} chunks) to Ojin`);

      await new Promise(r => setTimeout(r, 600));
      clientWs.send(JSON.stringify({ type: 'speech_start' }));
      let ci = 0;
      await new Promise((resolve) => {
        const sendNext = () => {
          if (ci >= chunks.length) { resolve(); return; }
          if (clientWs.readyState === WebSocket.OPEN) {
            const audioMsg = Buffer.alloc(1 + chunks[ci].length);
            audioMsg.writeUInt8(0xAA, 0);
            chunks[ci].copy(audioMsg, 1);
            clientWs.send(audioMsg);
          }
          ci++;
          if (ci < chunks.length) setTimeout(sendNext, 400);
          else resolve();
        };
        sendNext();
      });
      clientWs.send(JSON.stringify({ type: 'speech_end' }));
    } catch (err) {
      console.error('[orpheus-tts] Error:', err.message);
      await geminiTtsAndForward(text);
    }
  }

  // ── Gemini TTS fallback → Ojin ──
  async function geminiTtsAndForward(text) {
    console.log(`[gemini-tts] Synthesizing: "${text.substring(0, 60)}..."`);
    try {
      const ttsResponse = await genai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ role: 'user', parts: [{ text: `Read this text aloud exactly as written:\n\n${text}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });

      const audioData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!audioData) {
        console.error('[gemini-tts] No audio in response');
        clientWs.send(JSON.stringify({ type: 'tts_fallback', text }));
        return;
      }

      const pcm24 = Buffer.from(audioData.data, 'base64');
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);

      // Resample 24kHz → 16kHz (2/3 ratio)
      const outLen = Math.floor(samples24.length * 2 / 3);
      const samples16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * 1.5;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        const s0 = samples24[idx] || 0;
        const s1 = samples24[idx + 1] || 0;
        samples16[i] = Math.round(s0 + frac * (s1 - s0));
      }
      const pcm16 = Buffer.from(samples16.buffer);
      console.log(`[gemini-tts] Resampled ${pcm24.length}B @24k → ${pcm16.length}B @16k`);

      const CHUNK_SIZE = 12800;
      const chunks = [];
      for (let off = 0; off < pcm16.length; off += CHUNK_SIZE) {
        chunks.push(pcm16.subarray(off, Math.min(off + CHUNK_SIZE, pcm16.length)));
      }

      // Send all audio to Ojin immediately so it can start rendering
      for (const chunk of chunks) {
        if (ojinWs && ojinReady && ojinWs.readyState === WebSocket.OPEN) {
          ojinWs.send(struct.buildAudioInput(chunk));
        }
      }
      console.log(`[gemini-tts] Sent ${pcm16.length} bytes (${chunks.length} chunks) to Ojin`);

      // Wait for Ojin to start processing, then stream audio to browser in sync
      // Pace audio to browser at real-time rate (400ms per chunk)
      await new Promise(r => setTimeout(r, 200));
      clientWs.send(JSON.stringify({ type: 'speech_start' }));
      for (let j = 0; j < chunks.length; j++) {
        if (clientWs.readyState === WebSocket.OPEN) {
          const audioMsg = Buffer.alloc(1 + chunks[j].length);
          audioMsg.writeUInt8(0xAA, 0);
          chunks[j].copy(audioMsg, 1);
          clientWs.send(audioMsg);
        }
        if (j < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
      }
      clientWs.send(JSON.stringify({ type: 'speech_end' }));
    } catch (err) {
      console.error('[gemini-tts] Error:', err.message);
      if (FAL_KEY) await orpheusTtsAndForward(text);
      else clientWs.send(JSON.stringify({ type: 'tts_fallback', text }));
    }
  }

  // ── ElevenLabs TTS streaming → Ojin ──
  async function textToSpeechAndForward(text) {
    console.log(`[tts] Synthesizing: "${text.substring(0, 60)}..."`);

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_flash_v2_5',
            output_format: 'pcm_16000',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        console.error('[tts] ElevenLabs error:', response.status, err);
        await geminiTtsAndForward(text);
        return;
      }

      // Stream PCM chunks to Ojin as they arrive
      const reader = response.body.getReader();
      let totalBytes = 0;
      let chunkBuffer = Buffer.alloc(0);
      const CHUNK_SIZE = 12800; // 400ms at 16kHz = 6400 samples = 12800 bytes

      // Tell browser that speech is starting
      clientWs.send(JSON.stringify({ type: 'speech_start' }));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const pcmChunk = Buffer.from(value);
        chunkBuffer = Buffer.concat([chunkBuffer, pcmChunk]);
        totalBytes += pcmChunk.length;

        // Send in recommended chunk sizes
        while (chunkBuffer.length >= CHUNK_SIZE) {
          const sendChunk = chunkBuffer.subarray(0, CHUNK_SIZE);
          chunkBuffer = chunkBuffer.subarray(CHUNK_SIZE);

          if (ojinWs && ojinReady && ojinWs.readyState === WebSocket.OPEN) {
            ojinWs.send(struct.buildAudioInput(sendChunk));
          }

          // Also send PCM to browser for audio playback
          if (clientWs.readyState === WebSocket.OPEN) {
            const audioMsg = Buffer.alloc(1 + sendChunk.length);
            audioMsg.writeUInt8(0xAA, 0); // marker byte for "TTS audio"
            sendChunk.copy(audioMsg, 1);
            clientWs.send(audioMsg);
          }
        }
      }

      // Send remaining bytes
      if (chunkBuffer.length > 0) {
        if (ojinWs && ojinReady && ojinWs.readyState === WebSocket.OPEN) {
          ojinWs.send(struct.buildAudioInput(chunkBuffer));
        }
        if (clientWs.readyState === WebSocket.OPEN) {
          const audioMsg = Buffer.alloc(1 + chunkBuffer.length);
          audioMsg.writeUInt8(0xAA, 0);
          chunkBuffer.copy(audioMsg, 1);
          clientWs.send(audioMsg);
        }
      }

      console.log(`[tts] Sent ${totalBytes} bytes of PCM to Ojin`);
      clientWs.send(JSON.stringify({ type: 'speech_end' }));

    } catch (err) {
      console.error('[tts] Error:', err);
      clientWs.send(JSON.stringify({ type: 'error', message: `TTS error: ${err.message}` }));
    }
  }

  // ── Gemini chat ──
  async function chat(userMessage) {
    console.log(`[gemini] User: "${userMessage}"`);
    clientWs.send(JSON.stringify({ type: 'thinking' }));

    try {
      chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });

      const response = await genai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: chatHistory,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 200,
          temperature: 0.7,
        },
      });

      const assistantText = response.text || '';
      console.log(`[gemini] Assistant: "${assistantText.substring(0, 80)}..."`);

      chatHistory.push({ role: 'model', parts: [{ text: assistantText }] });

      // Send text to browser for display
      clientWs.send(JSON.stringify({ type: 'assistant_text', text: assistantText }));

      // Convert to speech and send to Ojin for lip-sync
      if (assistantText.trim()) {
        await geminiTtsAndForward(assistantText);
      }

    } catch (err) {
      console.error('[gemini] Error:', err);
      clientWs.send(JSON.stringify({ type: 'error', message: `Gemini error: ${err.message}` }));
    }
  }

  // ── Handle messages from browser ──
  clientWs.on('message', (data) => {
    const str = typeof data === 'string' ? data : data.toString();
    if (str[0] === '{') {
      try {
        const msg = JSON.parse(str);

        switch (msg.type) {
          case 'connect_ojin':
            connectOjin();
            break;

          case 'chat':
            if (msg.text?.trim()) {
              chat(msg.text.trim());
            }
            break;

          case 'cancel':
            // Interrupt current speech
            if (ojinWs && ojinReady && ojinWs.readyState === WebSocket.OPEN) {
              ojinWs.send(JSON.stringify({
                type: 'cancelInteraction',
                payload: { timestamp: Date.now() }
              }));
            }
            break;

          default:
            console.log('[client] Unknown message:', msg.type);
        }
      } catch (e) {
        console.error('[client] Parse error:', e);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('[client] Browser disconnected');
    if (ojinWs && ojinWs.readyState === WebSocket.OPEN) {
      ojinWs.send(JSON.stringify({
        type: 'endInteraction',
        payload: { timestamp: Date.now() }
      }));
      ojinWs.close();
    }
  });
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`\n🎭 Ojin Avatar Agent running at http://localhost:${PORT}`);
  console.log(`   Gemini: ${GEMINI_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   ElevenLabs: ${ELEVENLABS_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   Fal.ai: ${FAL_KEY ? '✓' : '✗ missing'}`);
  console.log(`   Ojin: ${OJIN_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   Config ID: ${OJIN_CONFIG_ID}\n`);
});
