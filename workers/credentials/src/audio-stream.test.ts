import { describe, expect, it, vi } from "vitest";
import { checkedAudioStream, isOpenRouterSpeechStream } from "./audio-stream.js";
const encode = (s: string) => new TextEncoder().encode(s);
function stream(chunks: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }); }
describe("credential-safe audio streaming", () => {
  it("streams binary intact and finalizes the full receipt", async () => {
    const completed = vi.fn(async () => {}), interrupted = vi.fn(async () => {});
    const bytes = new Uint8Array([255, 0, 1, 128, 42]);
    const r = checkedAudioStream({ source: stream([bytes.slice(0, 2), bytes.slice(2)]), secrets: ["long-secret"], completed, interrupted });
    expect(new Uint8Array(await new Response(r).arrayBuffer())).toEqual(bytes);
    expect(completed).toHaveBeenCalledWith(bytes); expect(interrupted).not.toHaveBeenCalled();
  });
  it("never emits a reflected secret split across chunk boundaries", async () => {
    const interrupted = vi.fn(async () => {}), completed = vi.fn(async () => {});
    const r = checkedAudioStream({ source: stream([encode("audio-secr"), encode("et-tail")]), secrets: ["secret"], completed, interrupted });
    const reader = r.getReader(); let output = "";
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; output += new TextDecoder().decode(value); } } catch {}
    expect(output).not.toContain("secr"); expect(completed).not.toHaveBeenCalled(); expect(interrupted).toHaveBeenCalledTimes(1);
  });
  it("marks cancellation and byte-limit failures indeterminate", async () => {
    const interrupted = vi.fn(async () => {});
    const r = checkedAudioStream({ source: stream([encode("123456")]), secrets: [], maxBytes: 5, completed: async () => {}, interrupted });
    await expect(new Response(r).arrayBuffer()).rejects.toThrow("audio_response_too_large");
    expect(interrupted).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn(async () => {});
    await checkedAudioStream({ source: stream([]), secrets: [], completed: async () => {}, interrupted: cancelled }).cancel();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("only allows the exact OpenRouter speech destination", () => {
    expect(isOpenRouterSpeechStream("https://openrouter.ai/api/v1/audio/speech", "POST", "audio")).toBe(true);
    expect(isOpenRouterSpeechStream("https://openrouter.ai.evil.test/api/v1/audio/speech", "POST", "audio")).toBe(false);
    expect(isOpenRouterSpeechStream("https://openrouter.ai/api/v1/audio/speech?redirect=x", "POST", "audio")).toBe(false);
  });
});
