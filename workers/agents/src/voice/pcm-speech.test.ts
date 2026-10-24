import { describe, it, expect, vi } from "vitest";
import { synthesizeVoicePcm } from "./pcm-speech.js";
import type { AgentsEnv } from "../index.js";
describe("telephone/browser PCM synthesis", () => {
  it("requests raw linear16 PCM and returns exact audio bytes", async () => {
    const run = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    const audio = await synthesizeVoicePcm(
      { run } as unknown as AgentsEnv["AI"],
      "Hello"
    );
    expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-1",
      expect.objectContaining({
        encoding: "linear16",
        container: "none",
        sample_rate: 16000,
      }),
      expect.objectContaining({ returnRawResponse: true })
    );
  });
  it.each([
    new Uint8Array(),
    new Uint8Array([1]),
    new TextEncoder().encode("RIFF0000"),
    new TextEncoder().encode("ID3000"),
  ])("rejects invalid or wrapped audio", async (bytes) => {
    await expect(
      synthesizeVoicePcm(
        { run: async () => new Response(bytes) } as unknown as AgentsEnv["AI"],
        "Hello"
      )
    ).rejects.toThrow("voice_audio_format_invalid");
  });
  it("rejects oversized audio without sending it to the caller", async () => {
    await expect(
      synthesizeVoicePcm(
        {
          run: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 2)),
        } as unknown as AgentsEnv["AI"],
        "Hello"
      )
    ).rejects.toThrow("voice_audio_size_limit");
  });
});
