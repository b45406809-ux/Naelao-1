import { describe, expect, it, vi } from "vitest";
import { OpenRouterLiveTTS } from "./openrouter-live-tts.js";

describe("OpenRouter live TTS adapter", () => {
  it("requests call-compatible raw PCM and returns it as a bounded ArrayBuffer", async () => {
    const source = new Uint8Array([1, 0, 2, 0]);
    const speak = vi.fn(async (input: unknown) => ({ stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(source); c.close(); } }) }));
    const tts = new OpenRouterLiveTTS({ audio: { speak }, model: "openrouter/test/voice", voice: "voice-1", speed: 1.1, requestId: () => "r1" });
    const result = await tts.synthesize("Good morning");
    expect([...new Uint8Array(result!)]).toEqual([...source]);
    expect(speak).toHaveBeenCalledWith({ model: "openrouter/test/voice", voice: "voice-1", speed: 1.1, rate: 16_000, channels: 1, priceUsdPerMillionCharacters: 15, requestId: "r1", text: "Good morning" });
  });
  it("rejects malformed PCM and checks interruption before egress", async () => {
    const speak = vi.fn(async () => ({ stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }));
    const tts = new OpenRouterLiveTTS({ audio: { speak }, model: "m", voice: "v", speed: 1, requestId: () => "r" });
    await expect(tts.synthesize("text")).rejects.toThrow("voice_tts_pcm_invalid");
    const abort = new AbortController(); abort.abort();
    await expect(tts.synthesize("text", abort.signal)).rejects.toThrow("voice_tts_cancelled");
    expect(speak).toHaveBeenCalledOnce();
  });
  it("resamples 24 kHz Microsoft output to the call transport's 16 kHz PCM format", async () => {
    const input = new Uint8Array(12); const inputView = new DataView(input.buffer);
    for (let i = 0; i < 6; i++) inputView.setInt16(i * 2, i * 1000, true);
    const speak = vi.fn(async () => ({ stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(input); c.close(); } }) }));
    const tts = new OpenRouterLiveTTS({ audio: { speak }, model: "microsoft/mai-voice-2.1-flash", voice: "en-US-Harper:MAI-Voice-2.1-Flash", speed: 1, sampleRate: 24_000, requestId: () => "r" });
    const output = new Uint8Array((await tts.synthesize("hello"))!);
    expect(output.byteLength).toBe(8);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ rate: 24_000, channels: 1 }));
  });
});
