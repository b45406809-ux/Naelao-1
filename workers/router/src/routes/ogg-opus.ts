import { OggOpusDecoder } from "ogg-opus-decoder";

export const MAX_DECODED_AUDIO_SECONDS = 180;
const SAMPLE_RATE = 16_000;
const MAX_DECODED_SAMPLES = SAMPLE_RATE * MAX_DECODED_AUDIO_SECONDS;
const OGG_CHUNK_BYTES = 64 * 1024;

interface DecodedChunk {
  channelData: Float32Array[];
  samplesDecoded: number;
  errors: Array<{ message: string }>;
}

interface OpusDecoder {
  ready: Promise<void>;
  decode(data: Uint8Array): DecodedChunk;
  flush(): Promise<DecodedChunk>;
  free(): void;
}

type DecoderFactory = () => OpusDecoder;

function appendMonoPcm16(channels: Float32Array[], chunks: Int16Array[]): number {
  if (!channels.length) return 0;
  const length = Math.min(...channels.map((channel) => channel.length));
  if (!length) return 0;
  const mono = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sample = 0;
    for (const channel of channels) sample += channel[i] ?? 0;
    sample /= channels.length;
    const bounded = Math.max(-1, Math.min(1, sample));
    mono[i] = Math.round(bounded < 0 ? bounded * 0x8000 : bounded * 0x7fff);
  }
  chunks.push(mono);
  return length;
}

function toWav(chunks: Int16Array[], sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
  }
  return bytes;
}

/** Decode Ogg/Opus in bounded chunks and normalize it to 16kHz mono PCM WAV. */
export async function decodeOggOpusToWav(
  input: Uint8Array,
  createDecoder: DecoderFactory = () => new OggOpusDecoder(
    { sampleRate: SAMPLE_RATE } as unknown as ConstructorParameters<typeof OggOpusDecoder>[0]
  ) as unknown as OpusDecoder
): Promise<Uint8Array> {
  if (input.byteLength < 4 || input[0] !== 0x4f || input[1] !== 0x67 || input[2] !== 0x67 || input[3] !== 0x53) {
    throw new Error("audio_ogg_container_invalid");
  }
  const decoder = createDecoder();
  const pcm: Int16Array[] = [];
  let sampleCount = 0;
  try {
    await decoder.ready;
    const consume = (decoded: DecodedChunk) => {
      if (decoded.errors.length) throw new Error("audio_opus_decode_failed");
      sampleCount += appendMonoPcm16(decoded.channelData, pcm);
      if (sampleCount > MAX_DECODED_SAMPLES) throw new Error("audio_duration_exceeds_limit");
    };
    for (let offset = 0; offset < input.byteLength; offset += OGG_CHUNK_BYTES) {
      consume(await decoder.decode(input.subarray(offset, Math.min(input.byteLength, offset + OGG_CHUNK_BYTES))));
    }
    consume(await decoder.flush());
    if (sampleCount === 0) throw new Error("audio_opus_decode_empty");
    return toWav(pcm, sampleCount);
  } finally {
    decoder.free();
  }
}
