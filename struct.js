// struct.js — Binary message helpers for Ojin Flashhead-lite protocol

/**
 * Build an InteractionInput binary message (client → Ojin server)
 * Format: [1B type=1] [8B timestamp BE] [4B params_size=0 BE] [NB PCM audio LE]
 */
function buildAudioInput(pcmBuffer) {
  const headerSize = 1 + 8 + 4;
  const msg = Buffer.alloc(headerSize + pcmBuffer.length);
  let offset = 0;

  // Payload type: 1 = audio
  msg.writeUInt8(1, offset); offset += 1;

  // Timestamp: uint64 big-endian (split into high/low 32-bit)
  const now = Date.now();
  msg.writeUInt32BE(Math.floor(now / 0x100000000), offset); offset += 4;
  msg.writeUInt32BE(now >>> 0, offset); offset += 4;

  // Params size: 0
  msg.writeUInt32BE(0, offset); offset += 4;

  // Audio payload (PCM int16 LE)
  pcmBuffer.copy(msg, offset);

  return msg;
}

/**
 * Parse an InteractionResponse binary message (Ojin server → client)
 * Returns: { isFinal, index, image, audio, timestamp, usage }
 */
function parseResponse(buf) {
  let offset = 0;

  const isFinal = buf.readUInt8(offset); offset += 1;

  // UUID (16 bytes) - skip
  offset += 16;

  // Timestamp uint64 BE
  const tsHigh = buf.readUInt32BE(offset); offset += 4;
  const tsLow = buf.readUInt32BE(offset); offset += 4;
  const timestamp = tsHigh * 0x100000000 + tsLow;

  // Usage uint32 BE
  const usage = buf.readUInt32BE(offset); offset += 4;

  // Frame index: 0=silence, 1=speech
  const index = buf.readUInt32BE(offset); offset += 4;

  // Num payloads uint32 BE
  const numPayloads = buf.readUInt32BE(offset); offset += 4;

  let image = null;
  let audio = null;

  for (let i = 0; i < numPayloads; i++) {
    const dataSize = buf.readUInt32BE(offset); offset += 4;
    const payloadType = buf.readUInt8(offset); offset += 1;
    const payload = buf.subarray(offset, offset + dataSize);
    offset += dataSize;

    if (payloadType === 2) image = payload;      // JPEG
    else if (payloadType === 1) audio = payload;  // PCM
  }

  return { isFinal: !!isFinal, index, image, audio, timestamp, usage };
}

export default { buildAudioInput, parseResponse };
export { buildAudioInput, parseResponse };
