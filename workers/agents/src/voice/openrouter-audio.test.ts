import { describe, expect, it, vi } from "vitest";
import { createOpenRouterAudio } from "./openrouter-audio.js";
function fixture(response: (url: string) => Response) {
  const settle = vi.fn(async () => {}), pending = vi.fn(async () => {});
  const authorize = vi.fn(async () => ({ settle, pending }));
  const fetchWithAuth = vi.fn(async (url: string) => response(url));
  return { settle, pending, authorize, fetchWithAuth, adapter: createOpenRouterAudio({ vault: { fetchWithAuth }, credentialName: "openrouter", authorize }) };
}
describe("metered OpenRouter audio", () => {
  it("records actual transcription cost and never exposes a provider key", async () => {
    const f = fixture(() => Response.json({ text: "Hello", usage: { cost: 0.001, total_tokens: 11 } }));
    expect(await f.adapter.transcribe({ model: "openrouter/openai/whisper-1", requestId: "turn-1", data: "YWJj", format: "wav" })).toBe("Hello");
    expect(f.authorize).toHaveBeenCalledBefore(f.fetchWithAuth);
    expect(f.settle).toHaveBeenCalledWith(0.001, undefined, 11);
    expect(f.fetchWithAuth.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
  });
  it("accepts the full bounded 20-second PCM utterance size", async () => {
    const f = fixture(() => Response.json({ text: "ok", usage: { cost: 0.00006, total_tokens: 2000 } }));
    const data = "A".repeat(853_392);
    expect(await f.adapter.transcribe({ model: "openai/whisper-large-v3-turbo", requestId: "max-utterance", data, format: "wav" })).toBe("ok");
    expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ estimatedTokens: 2000, estimatedCostUsd: 0.00006 }));
  });
  it("retains a reservation when provider usage is missing", async () => {
    const f = fixture(() => Response.json({ text: "Hello" }));
    await expect(f.adapter.transcribe({ model: "openai/whisper-1", requestId: "t", data: "YWJj", format: "wav" })).rejects.toThrow("audio_usage_unavailable");
    expect(f.pending).toHaveBeenCalledTimes(1); expect(f.settle).not.toHaveBeenCalled();
  });
  it("streams speech and settles from generation metadata after consumption", async () => {
    const f = fixture(url => url.includes("/generation?") ? Response.json({ data: { total_cost: 0.002, total_tokens: 22 } }) : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "audio/pcm", "x-generation-id": "gen-123" } }));
    const audio = await f.adapter.speak({ model: "vendor/tts", requestId: "t", voice: "Kore", text: "Hello" });
    expect(f.settle).not.toHaveBeenCalled();
    expect(new Uint8Array(await new Response(audio.stream).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(f.settle).toHaveBeenCalledWith(0.002, "gen-123", 22); expect(f.pending).not.toHaveBeenCalled();
  });
  it("records pending usage for cancelled speech", async () => {
    const f = fixture(() => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/pcm", "x-generation-id": "gen-123" } }));
    const audio = await f.adapter.speak({ model: "vendor/tts", requestId: "t", text: "Hello" });
    await audio.stream.cancel();
    expect(f.pending).toHaveBeenCalledWith("gen-123"); expect(f.settle).not.toHaveBeenCalled();
  });
  it("rejects unsupported output and invalid reference data", async () => {
    const f = fixture(() => new Response("MP3", { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-123" } }));
    await expect(f.adapter.speak({ model: "vendor/tts", requestId: "t", text: "Hello" })).rejects.toThrow("speech_receipt_or_format_unavailable");
    expect(f.pending).toHaveBeenCalledWith("gen-123");
    await expect(f.adapter.speak({ model: "vendor/tts", requestId: "t", text: "Hello", references: [{ data: "https://private" }] })).rejects.toThrow("invalid_speech_reference");
  });
});
