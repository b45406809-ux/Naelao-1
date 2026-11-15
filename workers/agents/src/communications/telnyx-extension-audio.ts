const MAX_PCMU_FRAME_BYTES = 8_000;

function decodeMuLawByte(value: number): number {
  const sample = (~value) & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  let decoded = ((mantissa << 3) + 0x84) << exponent;
  decoded -= 0x84;
  return sign ? -decoded : decoded;
}

function encodeMuLawSample(input: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sample = Math.max(-CLIP, Math.min(CLIP, input));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) { /* find segment */ }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/** Decode a bounded Telnyx PCMU frame and linearly upsample 8 kHz mono to 16 kHz PCM16. */
export function decodeTelnyxPcmuToPcm16k(payload: string): ArrayBuffer {
  if (typeof payload !== "string" || payload.length < 4 || payload.length > Math.ceil(MAX_PCMU_FRAME_BYTES / 3) * 4
    || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error("telnyx_audio_frame_invalid");
  const pcmu = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
  if (!pcmu.byteLength || pcmu.byteLength > MAX_PCMU_FRAME_BYTES) throw new Error("telnyx_audio_frame_invalid");
  const output = new ArrayBuffer(pcmu.byteLength * 4);
  const view = new DataView(output);
  for (let i = 0; i < pcmu.byteLength; i++) {
    const current = decodeMuLawByte(pcmu[i]!);
    const next = decodeMuLawByte(pcmu[Math.min(i + 1, pcmu.byteLength - 1)]!);
    view.setInt16(i * 4, current, true);
    view.setInt16(i * 4 + 2, Math.round((current + next) / 2), true);
  }
  return output;
}

/** Downsample mono PCM16 16 kHz to PCMU 8 kHz. An incomplete sample is rejected. */
export function encodePcm16kToTelnyxPcmu(input: Uint8Array): Uint8Array {
  if (!input.byteLength || input.byteLength % 4 !== 0 || input.byteLength > 512_000) throw new Error("telnyx_speech_frame_invalid");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const output = new Uint8Array(input.byteLength / 4);
  for (let i = 0; i < output.byteLength; i++) {
    const first = view.getInt16(i * 4, true);
    const second = view.getInt16(i * 4 + 2, true);
    output[i] = encodeMuLawSample(Math.round((first + second) / 2));
  }
  return output;
}

export function encodeTelnyxPcmuBase64(input: Uint8Array): string {
  if (!input.byteLength || input.byteLength > MAX_PCMU_FRAME_BYTES) throw new Error("telnyx_speech_frame_invalid");
  let binary = "";
  for (let offset = 0; offset < input.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...input.subarray(offset, Math.min(input.byteLength, offset + 0x8000)));
  return btoa(binary);
}

/** Fixed 20 ms outbound packet size at 8 kHz mono. */
export const TELNYX_PCMU_PACKET_BYTES = 160;

export const telnyxExtensionAudioLimits = Object.freeze({
  maxInboundPcmuBytes: MAX_PCMU_FRAME_BYTES,
  pcmuPacketBytes: TELNYX_PCMU_PACKET_BYTES,
  inboundRateHz: 8_000,
  processingRateHz: 16_000,
});
