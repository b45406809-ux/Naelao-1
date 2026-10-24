import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_UTTERANCE_MS = 20_000;
const MAX_UTTERANCE_BYTES = (BYTES_PER_SECOND * MAX_UTTERANCE_MS) / 1000;
const MAX_QUEUE_BYTES = MAX_UTTERANCE_BYTES;
const END_SILENCE_MS = 650;
const MIN_VOICE_MS = 120;
const RMS_THRESHOLD = 520;

export interface UtteranceTranscriber {
  transcribe(input: { requestId: string; data: string; format: "wav" }): Promise<string>;
}
export interface LiveTranscriberOptions {
  provider: UtteranceTranscriber;
  requestId(): string;
  now?: () => number;
}

function wav(pcm: Uint8Array): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) header[at + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, pcm.byteLength, true);
  const result = new Uint8Array(header.byteLength + pcm.byteLength); result.set(header); result.set(pcm, header.byteLength); return result;
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function voiced(pcm: Uint8Array): boolean {
  if (pcm.byteLength < 2) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0, count = Math.floor(pcm.byteLength / 2);
  for (let i = 0; i < count; i++) { const sample = view.getInt16(i * 2, true); sum += sample * sample; }
  return Math.sqrt(sum / count) >= RMS_THRESHOLD;
}

/** Continuous PCM adapter for OpenRouter's complete-WAV transcription requests. It keeps at most
 * one active and one queued utterance in memory and never saves raw call audio to storage. */
export class OpenRouterLiveTranscriber implements Transcriber {
  constructor(private readonly options: LiveTranscriberOptions) {}
  createSession(sessionOptions: TranscriberSessionOptions): TranscriberSession {
    const now = this.options.now ?? Date.now;
    let active: Uint8Array[] = [], activeBytes = 0, activeStart = 0, lastVoice = 0, voiceBytes = 0;
    let queued: Uint8Array[] | null = null, queuedBytes = 0, processing = false, closed = false;
    const fail = (reason: string) => sessionOptions.onFatalError?.(new Error(reason));
    const copy = (chunk: ArrayBuffer) => new Uint8Array(chunk.slice(0));
    const append = (target: Uint8Array[], chunk: Uint8Array) => target.push(chunk);
    const dispatch = async (chunks: Uint8Array[], size: number) => {
      if (size < (BYTES_PER_SECOND * MIN_VOICE_MS) / 1000) return;
      const pcm = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength; }
      const payload = base64(wav(pcm));
      try {
        const text = await this.options.provider.transcribe({ requestId: this.options.requestId(), data: payload, format: "wav" });
        if (!closed && text.trim()) sessionOptions.onUtterance?.(text.slice(0, 2_000));
      } catch { if (!closed) fail("openrouter_transcription_unavailable"); }
    };
    const drain = async () => {
      if (processing || closed) return;
      processing = true;
      try {
        while (!closed) {
          const batch = queued; const size = queuedBytes;
          queued = null; queuedBytes = 0;
          if (!batch) break;
          await dispatch(batch, size);
        }
      } finally { processing = false; }
    };
    const finish = () => {
      if (!activeBytes) return;
      const chunks = active, size = activeBytes;
      active = []; activeBytes = 0; activeStart = 0; lastVoice = 0; voiceBytes = 0;
      if (processing || queued) {
        if (queued || size > MAX_QUEUE_BYTES) { fail("voice_transcription_backpressure"); return; }
        queued = chunks; queuedBytes = size;
      } else {
        queued = chunks; queuedBytes = size;
      }
      void drain();
    };
    return {
      feed(chunk: ArrayBuffer) {
        if (closed || !chunk.byteLength) return;
        if (chunk.byteLength % 2 || chunk.byteLength > BYTES_PER_SECOND) { fail("voice_pcm_frame_invalid"); return; }
        const bytes = copy(chunk), time = now(), isVoice = voiced(bytes);
        if (isVoice) {
          if (!activeBytes) { activeStart = time; sessionOptions.onSpeechStart?.(); }
          lastVoice = time; voiceBytes += bytes.byteLength;
        }
        if (!activeBytes && !isVoice) return;
        if (activeBytes + bytes.byteLength > MAX_UTTERANCE_BYTES) { finish(); if (!isVoice) return; activeStart = time; lastVoice = time; voiceBytes = bytes.byteLength; }
        append(active, bytes); activeBytes += bytes.byteLength;
        if (activeBytes >= MAX_UTTERANCE_BYTES || time - activeStart >= MAX_UTTERANCE_MS) finish();
        else if (lastVoice && time - lastVoice >= END_SILENCE_MS) finish();
      },
      close() { closed = true; active = []; queued = null; activeBytes = queuedBytes = 0; },
    };
  }
}

export const openRouterLiveTranscriberLimits = Object.freeze({ SAMPLE_RATE, MAX_UTTERANCE_MS, MAX_UTTERANCE_BYTES, END_SILENCE_MS, MIN_VOICE_MS, RMS_THRESHOLD });
