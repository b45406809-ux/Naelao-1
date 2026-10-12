import type { OggOpusDecoder as OggOpusDecoderClass } from "ogg-opus-decoder";

export const MAX_DECODED_AUDIO_SECONDS = 180;
const SAMPLE_RATE = 16_000;
const MAX_DECODED_SAMPLES = SAMPLE_RATE * MAX_DECODED_AUDIO_SECONDS;

interface DecodedChunk {
  channelData: Float32Array[];
  samplesDecoded: number;
  errors: Array<{ message: string }>;
}

interface OpusDecoder {
  ready: Promise<void>;
  decodeFile(data: Uint8Array): Promise<DecodedChunk>;
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
  createDecoder?: DecoderFactory
): Promise<Uint8Array> {
  if (input.byteLength < 4 || input[0] !== 0x4f || input[1] !== 0x67 || input[2] !== 0x67 || input[3] !== 0x53) {
    throw new Error("audio_ogg_container_invalid");
  }
  // Do not load this package while the router module starts. Its top-level exports include a
  // browser/Node Web Worker subclass; workerd has no global Worker and would otherwise crash
  // before any route can serve. Import only after an Ogg request reaches this path.
  let decoder: OpusDecoder;
  if (createDecoder) decoder = createDecoder();
  else {
    const { OggOpusDecoder } = await import("ogg-opus-decoder");
    decoder = new OggOpusDecoder(
      { sampleRate: SAMPLE_RATE } as unknown as ConstructorParameters<typeof OggOpusDecoderClass>[0]
    ) as unknown as OpusDecoder;
  }
  const pcm: Int16Array[] = [];
  let sampleCount = 0;
  try {
    await decoder.ready;
    const consume = (decoded: DecodedChunk) => {
      if (decoded.errors.length) throw new Error("audio_opus_decode_failed");
      sampleCount += appendMonoPcm16(decoded.channelData, pcm);
      if (sampleCount > MAX_DECODED_SAMPLES) throw new Error("audio_duration_exceeds_limit");
    };
    // decodeFile processes the complete Ogg stream, including its final page/granule position.
    // A separate flush after decode() causes a second WASM decoder reset in workerd and can
    // strand the request; decoding the bounded whole payload avoids that reset path.
    consume(await decoder.decodeFile(input));
    if (sampleCount === 0) throw new Error("audio_opus_decode_empty");
    return toWav(pcm, sampleCount);
  } finally {
    decoder.free();
  }
}
