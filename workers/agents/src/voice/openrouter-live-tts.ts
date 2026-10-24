import type { TTSProvider } from "agents/voice";

const MAX_PCM_BYTES = 8 * 1024 * 1024;
export interface OpenRouterSpeechClient {
  speak(input: { model: string; requestId: string; text: string; voice: string; speed: number; rate: 16000; channels: 1 }): Promise<{ stream: ReadableStream<Uint8Array> }>;
}
/** Adapter for the Agents voice transport, which consumes bounded 16kHz mono PCM ArrayBuffers. */
export class OpenRouterLiveTTS implements TTSProvider {
  constructor(private readonly options: { audio: OpenRouterSpeechClient; model: string; voice: string; speed: number; requestId(): string }) {}
  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (signal?.aborted) throw new Error("voice_tts_cancelled");
    if (typeof text !== "string" || !text.trim() || text.length > 2_000) throw new Error("voice_tts_text_invalid");
    const { stream } = await this.options.audio.speak({
      model: this.options.model, voice: this.options.voice, speed: this.options.speed,
      rate: 16_000, channels: 1, requestId: this.options.requestId(), text,
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
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output.buffer;
  }
}
