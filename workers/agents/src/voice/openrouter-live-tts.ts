import type { TTSProvider } from "agents/voice";

const MAX_PCM_BYTES = 8 * 1024 * 1024;
export interface OpenRouterSpeechClient {
  speak(input: { model: string; requestId: string; text: string; voice: string; instructions?: string; speed: number; rate: 16000 | 24000; channels: 1; priceUsdPerMillionCharacters: number }): Promise<{ stream: ReadableStream<Uint8Array> }>;
}
/** Adapter for the Agents voice transport, which consumes bounded 16kHz mono PCM ArrayBuffers. */
export class OpenRouterLiveTTS implements TTSProvider {
  constructor(private readonly options: { audio: OpenRouterSpeechClient; model: string; voice: string; instructions?: string; speed: number; priceUsdPerMillionCharacters?: number; requestId(): string; sampleRate?: 16000 | 24000 }) {}
  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (signal?.aborted) throw new Error("voice_tts_cancelled");
    if (typeof text !== "string" || !text.trim() || text.length > 2_000) throw new Error("voice_tts_text_invalid");
    const { stream } = await this.options.audio.speak({
      model: this.options.model, voice: this.options.voice, speed: this.options.speed,
      ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
      priceUsdPerMillionCharacters: this.options.priceUsdPerMillionCharacters ?? 15,
      rate: this.options.sampleRate ?? 16_000, channels: 1, requestId: this.options.requestId(), text,
    });
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal?.aborted) { await reader.cancel().catch(() => {}); throw new Error("voice_tts_cancelled"); }
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PCM_BYTES) { await reader.cancel().catch(() => {}); throw new Error("voice_tts_size_limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size || size % 2) throw new Error("voice_tts_pcm_invalid");
    const source = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.byteLength; }
    // The Agents phone transport is fixed at 16 kHz. Microsoft speech models emit 24 kHz PCM;
    // downsample with bounded linear interpolation before passing audio to the telephony layer.
    if ((this.options.sampleRate ?? 16_000) === 16_000) return source.buffer;
    const sourceView = new DataView(source.buffer), targetCount = Math.floor((size / 2) * 2 / 3);
    const output = new Uint8Array(targetCount * 2), targetView = new DataView(output.buffer);
    for (let i = 0; i < targetCount; i++) {
      const position = i * 1.5, left = Math.floor(position), fraction = position - left;
      const a = sourceView.getInt16(left * 2, true), b = sourceView.getInt16(Math.min(left + 1, size / 2 - 1) * 2, true);
      targetView.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))), true);
    }
    return output.buffer;
  }
}
